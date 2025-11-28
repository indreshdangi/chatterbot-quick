// backend/server.js
// Fixed multi-provider proxy with robust Gemini generateContent usage (v1beta2).
// Usage: set environment variables (GEMINI_KEY, GEMINI_MODEL, optionally GEMINI_PROJECT).
// Restart server after changes.

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
require("dotenv").config();
const fetch = require("node-fetch");

const app = express();
app.use(cors());
app.use(express.json({ limit: "4mb" }));

const PORT = process.env.PORT || 3000;
const PROJECT_ROOT = __dirname;
const PUBLIC_DIR = path.join(PROJECT_ROOT, "..", "public");
const DB_PATH = path.join(PROJECT_ROOT, "history.json");

// Env keys (trim)
const GROQ_KEY = (process.env.GROQ_KEY || "").trim();
const GROQ_API_BASE = (process.env.GROQ_API_BASE || "https://api.groq.com/openai/v1").trim();
const GROQ_MODEL_DEFAULT = (process.env.GROQ_MODEL || "llama-3.1-8b-instant").trim();

const GEMINI_KEY = (process.env.GEMINI_KEY || "").trim();
const GEMINI_MODEL = (process.env.GEMINI_MODEL || "gemini-2.5-flash").trim(); // e.g. 'gemini-2.5-flash'
const GEMINI_PROJECT = (process.env.GEMINI_PROJECT || "").trim(); // optional Google Cloud project id to send as header

// Helpers: DB
if (!fs.existsSync(DB_PATH)) {
  try { fs.writeFileSync(DB_PATH, "{}", "utf8"); } catch (e) { console.error("Could not create history.json:", e); }
}
function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_PATH, "utf8") || "{}"); } catch (e) { console.error("loadDB error:", e); return {}; }
}
function saveDB(db) {
  try { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf8"); } catch (e) { console.error("saveDB error:", e); }
}

// Small utils
function containsDevanagari(s){ return /[\u0900-\u097F]/.test(s || ""); }
function sanitizeReply(text){ if(!text) return ""; if(typeof text !== "string") text = String(text); return text.replace(/\s+/g, " ").trim(); }
async function safeParseResponse(res){
  if (!res || !res.headers) return { ok:false, text:null };
  const ct = (res.headers.get && (res.headers.get("content-type") || "").toLowerCase()) || "";
  try {
    if (ct.includes("application/json")) {
      const j = await res.json();
      return { ok: res.ok, json: j, status: res.status };
    } else {
      const t = await res.text();
      try { return { ok: res.ok, json: JSON.parse(t), status: res.status }; } catch(e){ return { ok: res.ok, text: t, status: res.status }; }
    }
  } catch(e){
    return { ok:false, error:e, text:null };
  }
}

/* --- GROQ (OpenAI-like) --- */
async function callGroq(modelId, messagesOrString, opts={}) {
  if (!GROQ_KEY) throw new Error("GROQ_KEY_MISSING");
  const url = `${GROQ_API_BASE}/chat/completions`;
  const body = {
    model: modelId,
    messages: Array.isArray(messagesOrString) ? messagesOrString : [{ role: "user", content: String(messagesOrString) }],
    max_tokens: opts.maxOutputTokens || 1024,
    temperature: typeof opts.temperature === "number" ? opts.temperature : 0.6
  };
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${GROQ_KEY}`
    },
    body: JSON.stringify(body)
  });
  const parsed = await safeParseResponse(resp);
  return { provider:"groq", resp, parsed };
}

/* --- GEMINI (Generative Language) --- */
/*
  Use the correct method name: generateContent (common on v1beta / v1beta2).
  We'll try endpoints in order and return the first usable JSON/text body.
*/
async function callGemini(modelId, userMessage, opts={}) {
  if (!GEMINI_KEY) throw new Error("GEMINI_KEY_MISSING");
  // accepted modelId examples: "gemini-2.5-flash" (no 'models/' prefix)
  const endpointsToTry = [
    // prefer v1beta2 generateContent (most examples use generateContent)
    `https://generativelanguage.googleapis.com/v1beta2/models/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(GEMINI_KEY)}`,
    // fallback older path v1beta
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(GEMINI_KEY)}`,
    // fallback to v1 with generateContent
    `https://generativelanguage.googleapis.com/v1/models/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(GEMINI_KEY)}`,
    // last resort: v1 :generate (older name) — keep but lower priority
    `https://generativelanguage.googleapis.com/v1/models/${encodeURIComponent(modelId)}:generate?key=${encodeURIComponent(GEMINI_KEY)}`
  ];

  const bodyPayload = {
    prompt: { text: String(userMessage) },
    maxOutputTokens: opts.maxOutputTokens || 512,
    temperature: typeof opts.temperature === "number" ? opts.temperature : 0.6
  };

  for (const url of endpointsToTry) {
    try {
      const headers = { "Content-Type": "application/json" };
      // if a billing/project header is needed, send it
      if (GEMINI_PROJECT) headers["X-Goog-User-Project"] = GEMINI_PROJECT;

      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(bodyPayload),
        // don't follow infinite redirects silently
      });

      const parsed = await safeParseResponse(resp);

      // Log for debugging (server logs)
      console.log("[callGemini] tried:", url, "status:", parsed && parsed.status);

      // If service returned JSON or text with content -> return it
      if (parsed && (parsed.json || parsed.text) && (parsed.status === 200 || parsed.status === 201)) {
        return { provider: "gemini", resp, parsed, urlUsed: url };
      }

      // handle some error pages that are HTML but with useful code (like 404). Return the parsed info upward
      if (parsed && (parsed.status && parsed.status >= 400)) {
        // return the parsed object but mark ok false
        return { provider: "gemini", resp, parsed, urlUsed: url };
      }

      // parsed may be OK but empty; try next endpoint
    } catch (e) {
      // network, JSON parse, etc. try next
      console.warn("[callGemini] exception for url", url, e && e.message ? e.message : e);
    }
  }

  // if none responded use a clear error
  throw new Error("GEMINI_NO_USABLE_RESPONSE");
}

/* --- Main chat endpoint --- */
app.post("/api/chat", async (req, res) => {
  try {
    const message = (req.body.message || "").toString();
    const convId = req.body.conversation_id || "default";
    const modelKey = (req.body.model || "").toString().trim() || "llama_3_1_8b_instant";

    if (!message) return res.status(400).json({ error: "message required" });

    // persist user message
    const db = loadDB();
    if (!db[convId]) db[convId] = [];
    db[convId].push({ role:"user", content: message, created_at: new Date().toISOString() });
    saveDB(db);

    // system prompt
    let systemMsg;
    if (containsDevanagari(message)) {
      systemMsg = { role: "system", content: "You are Indresh 2.0. User used Devanagari Hindi. Reply IN HINDI using Devanagari only. Do NOT repeat the user's question. Keep answers clear and concise." };
    } else {
      systemMsg = { role: "system", content: "You are Indresh 2.0. User used Latin script (Hinglish/English). Reply in the same script. Do NOT repeat the user's question." };
    }

    // send to provider
    let providerResult = null;
    let usedProvider = null;
    try {
      if (modelKey.startsWith("gemini") || modelKey.includes("gemini")) {
        if (!GEMINI_KEY) throw new Error("GEMINI_KEY_MISSING");
        usedProvider = "gemini";
        // model id: use GEMINI_MODEL env (override if client asked differently)
        const targetModel = GEMINI_MODEL || modelKey.replace(/^models\//, "");
        providerResult = await callGemini(targetModel, message, { maxOutputTokens: 900, temperature: 0.6 });
      } else {
        // default Groq/OpenAI-like
        if (!GROQ_KEY) throw new Error("GROQ_KEY_MISSING");
        usedProvider = "groq";
        const targetModel = GROQ_MODEL_DEFAULT;
        const messagesArr = [ systemMsg, { role:"user", content: message } ];
        providerResult = await callGroq(targetModel, messagesArr, { maxOutputTokens: 1400, temperature: 0.6 });
      }
    } catch (provErr) {
      console.warn("Provider call exception:", provErr && (provErr.stack || provErr.message) ? (provErr.stack || provErr.message) : provErr);
      db[convId].push({ role:"assistant", content: `Provider error: ${String(provErr)}`, created_at: new Date().toISOString(), meta:{ error:true }});
      saveDB(db);
      return res.status(502).json({ error:"provider_exception", provider: usedProvider, detail: String(provErr) });
    }

    // parse provider result
    let replyText = null;
    const p = providerResult && providerResult.parsed;
    // GROQ-style
    if (p && p.json) {
      const j = p.json;
      replyText =
        j?.choices?.[0]?.message?.content ||
        j?.choices?.[0]?.text ||
        j?.output?.[0]?.content ||
        j?.output?.text ||
        j?.candidates?.[0]?.content ||
        j?.generated_text ||
        (typeof j === "string" ? j : null);

      // Gemini specific shapes
      if (!replyText && j?.candidates && j.candidates[0] && j.candidates[0].content) replyText = j.candidates[0].content;
      if (!replyText && j?.output && Array.isArray(j.output) && j.output[0] && j.output[0].content) {
        const seg = j.output[0].content;
        if (typeof seg === "string") replyText = seg;
        else if (Array.isArray(seg)) {
          const texts = seg.map(s => (s?.text || (s?.content?.[0]?.text) || "")).filter(Boolean);
          if (texts.length) replyText = texts.join("\n");
        } else if (seg?.text) replyText = seg.text;
      }
    } else if (p && p.text) {
      replyText = p.text;
    } else if (p && p.ok === false && p.error) {
      replyText = `Provider returned error: ${JSON.stringify(p.error)}`;
    } else if (providerResult && providerResult.resp) {
      // try raw resp text
      try {
        const raw = await providerResult.resp.text();
        if (raw && raw.length) {
          // if it is HTML error page, include small preview
          if (raw.trim().startsWith("<")) {
            replyText = `Error: provider returned non-JSON body (status:${providerResult.parsed && providerResult.parsed.status})`;
          } else replyText = raw;
        }
      } catch(e){}
    }

    if (!replyText) {
      const detail = (providerResult && providerResult.parsed) ? (providerResult.parsed.json || providerResult.parsed.text || providerResult.parsed.error || null) : null;
      db[convId].push({ role:"assistant", content: `Provider error: no content from ${usedProvider}`, created_at: new Date().toISOString(), meta:{ provider: usedProvider, detail }}); saveDB(db);
      return res.status(502).json({ error:"provider_no_content", provider: usedProvider, detail: detail || "no body" });
    }

    // sanitize + rewrite names
    replyText = sanitizeReply(String(replyText).replace(/OpenAI|ChatGPT/gi, "Indresh 2.0"));

    db[convId].push({ role:"assistant", content: replyText, created_at: new Date().toISOString() });
    saveDB(db);

    return res.json({ output: { role:"assistant", content: replyText, via: usedProvider } });

  } catch (err) {
    console.error("Server /api/chat error:", err && err.stack ? err.stack : err);
    return res.status(500).json({ error:"server_error", details: err && err.message ? err.message : String(err) });
  }
});

/* history & static serve */
app.get("/api/history/:id", (req,res) => {
  const db = loadDB(); res.json({ messages: db[req.params.id] || [] });
});
app.post("/api/clear/:id", (req,res) => {
  const db = loadDB(); db[req.params.id] = []; saveDB(db); res.json({ ok:true });
});

if (fs.existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR));
  app.get("/", (req,res) => {
    const idx = path.join(PUBLIC_DIR,"index.html");
    if (fs.existsSync(idx)) return res.sendFile(idx);
    return res.status(404).send("index.html missing in public/");
  });
} else {
  app.get("/", (req,res) => res.status(404).send("Frontend not found. Put index.html into public/"));
}

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running http://0.0.0.0:${PORT}`);
  console.log("PUBLIC_DIR:", PUBLIC_DIR, "exists:", fs.existsSync(PUBLIC_DIR));
  console.log("GROQ_KEY:", GROQ_KEY ? "SET len="+GROQ_KEY.length : "MISSING");
  console.log("GROQ_API_BASE:", GROQ_API_BASE);
  console.log("GROQ_MODEL_DEFAULT:", GROQ_MODEL_DEFAULT);
  console.log("GEMINI_KEY:", GEMINI_KEY ? "SET len="+GEMINI_KEY.length : "MISSING");
  console.log("GEMINI_MODEL:", GEMINI_MODEL);
  if (GEMINI_PROJECT) console.log("GEMINI_PROJECT:", GEMINI_PROJECT);
});

process.on("SIGINT", () => { console.log("Shutting down..."); server.close(()=>process.exit(0)); });
