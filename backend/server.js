// backend/server.js
// Multi-provider chat proxy — Groq (default) + Gemini (Google).
// Save as server.js, set env vars and restart server (node server.js)

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

// Env keys
const GROQ_KEY = (process.env.GROQ_KEY || "").trim();
const GROQ_API_BASE = (process.env.GROQ_API_BASE || "https://api.groq.com/openai/v1").trim();
const GROQ_MODEL_DEFAULT = (process.env.GROQ_MODEL || "llama-3.1-8b-instant").trim();

const GEMINI_KEY = (process.env.GEMINI_KEY || "").trim();
const GEMINI_API_BASE = (process.env.GEMINI_API_BASE || "https://generativelanguage.googleapis.com/v1").trim(); // v1 recommended
const GEMINI_MODEL_ID = (process.env.GEMINI_MODEL || "gemini-2.5-flash").trim();

// ensure db exists
if (!fs.existsSync(DB_PATH)) {
  try { fs.writeFileSync(DB_PATH, "{}", "utf8"); } catch (e) { console.error("Could not create history.json:", e); }
}
function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_PATH, "utf8") || "{}"); } catch (e) { console.error("loadDB error:", e); return {}; }
}
function saveDB(db) {
  try { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf8"); } catch (e) { console.error("saveDB error:", e); }
}

function containsDevanagari(s) { return /[\u0900-\u097F]/.test(s || ""); }
function sanitizeReply(text) { if (!text) return ""; if (typeof text !== "string") text = String(text); return text.replace(/\s+/g, " ").trim(); }

async function safeParseResponse(res) {
  if (!res) return { ok:false, text:null };
  const ct = (res.headers && (res.headers.get && res.headers.get("content-type") || "")) || "";
  try {
    if (ct.includes("application/json")) {
      const j = await res.json();
      return { ok: res.ok, json: j, status: res.status };
    } else {
      const t = await res.text();
      // try parse fallback
      try { return { ok: res.ok, json: JSON.parse(t), status: res.status }; } catch(e) { return { ok: res.ok, text: t, status: res.status }; }
    }
  } catch (e) {
    return { ok:false, error:e, text:null };
  }
}

/* ---- GROQ caller (unchanged) ---- */
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
    body: JSON.stringify(body),
    timeout: 20000
  });
  const parsed = await safeParseResponse(resp);
  return { provider:"groq", resp, parsed };
}

/* ---- Gemini caller (Google Generative API v1) ---- */
async function callGemini(modelId, userMessage, opts={}) {
  if (!GEMINI_KEY) throw new Error("GEMINI_KEY_MISSING");
  // Use v1 by default (matches GET /v1/models etc)
  const url = `${GEMINI_API_BASE}/models/${encodeURIComponent(modelId)}:generate?key=${encodeURIComponent(GEMINI_KEY)}`;
  const body = {
    prompt: { text: String(userMessage) },
    maxOutputTokens: opts.maxOutputTokens || 512,
    temperature: typeof opts.temperature === "number" ? opts.temperature : 0.6
  };

  // DEBUG: do not log the raw key in production. Here mask it if we print.
  console.log("[callGemini] POST", url.replace(/key=[^&]+/,"key=***MASKED***"), "model:", modelId, "maxOutputTokens:", body.maxOutputTokens);

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    timeout: 25000
  });

  // read raw text for better debugging (some errors return empty JSON)
  const rawText = await resp.text();
  let parsed;
  try {
    parsed = { ok: resp.ok, status: resp.status, json: rawText ? JSON.parse(rawText) : null, rawText };
  } catch (e) {
    parsed = { ok: resp.ok, status: resp.status, text: rawText };
  }

  // also return the Response-like object in case caller wants status
  return { provider:"gemini", resp, parsed };
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

    // system prompt language rule
    let systemMsg;
    if (containsDevanagari(message)) {
      systemMsg = { role: "system", content: "You are Indresh 2.0. User used Devanagari Hindi. Reply IN HINDI using Devanagari only. Do NOT repeat the user's question. Keep answers clear and concise." };
    } else {
      systemMsg = { role: "system", content: "You are Indresh 2.0. User used Latin script (Hinglish/English). Reply in the same script. Do NOT repeat the user's question." };
    }

    let providerResult = null;
    let usedProvider = null;

    try {
      if (modelKey.startsWith("gemini") || modelKey.indexOf("gemini") !== -1) {
        usedProvider = "gemini";
        // pass the selected gemini model if client supplied (or default GEMINI_MODEL_ID)
        const targetModel = (req.body.gemini_model || GEMINI_MODEL_ID);
        providerResult = await callGemini(targetModel, message, { maxOutputTokens: req.body.maxOutputTokens || 900, temperature: 0.6 });
      } else {
        usedProvider = "groq";
        const targetModel = GROQ_MODEL_DEFAULT;
        const messagesArr = [ systemMsg, { role:"user", content: message } ];
        providerResult = await callGroq(targetModel, messagesArr, { maxOutputTokens: 1400, temperature: 0.6 });
      }
    } catch (provErr) {
      console.warn("Provider call exception:", provErr);
      db[convId].push({ role:"assistant", content: `Provider error: ${String(provErr)}`, created_at: new Date().toISOString(), meta:{ error:true }});
      saveDB(db);
      return res.status(502).json({ error:"provider_exception", provider: usedProvider, detail: String(provErr) });
    }

    // parse provider response robustly
    let replyText = null;
    const p = providerResult && providerResult.parsed;
    // If Gemini, we handled parsed as {ok,status,json,rawText} above
    if (p) {
      if (p.json) {
        const j = p.json;
        // Gemini: shape may include candidates or output
        if (j?.candidates?.[0]?.content) {
          // content may be array or object
          const cont = j.candidates[0].content;
          if (typeof cont === "string") replyText = cont;
          else if (Array.isArray(cont)) {
            const texts = cont.map(s => (s?.text || s?.content?.[0]?.text || "")).filter(Boolean);
            replyText = texts.join("\n");
          } else if (cont?.text) replyText = cont.text;
        }
        if (!replyText) {
          // common places
          replyText = j?.output?.[0]?.content?.map?.(c => c.text || "").join("") || j?.output?.[0]?.content?.text || j?.output?.[0]?.text || j?.text || j?.generated_text || null;
        }
      } else if (p.text) {
        replyText = p.text;
      } else if (p.rawText) {
        // sometimes raw html or empty
        replyText = typeof p.rawText === "string" ? p.rawText : null;
      }
    }

    // if still no reply, attach debug info
    if (!replyText) {
      const detail = providerResult && providerResult.parsed ? (providerResult.parsed.json || providerResult.parsed.text || providerResult.parsed.rawText || providerResult.parsed.error || null) : null;
      console.warn("[server] provider_no_content, provider:", usedProvider, "parsed:", detail ? (typeof detail === "string" ? detail.slice(0,1000) : JSON.stringify(detail).slice(0,1000)) : null);
      db[convId].push({ role:"assistant", content: `Provider error: no content from ${usedProvider}`, created_at: new Date().toISOString(), meta:{ provider: usedProvider, detail }} );
      saveDB(db);
      return res.status(502).json({ error:"provider_no_content", provider: usedProvider, detail: detail || "no body" });
    }

    // sanitize
    replyText = sanitizeReply(String(replyText).replace(/OpenAI|ChatGPT/gi, "Indresh 2.0"));

    db[convId].push({ role:"assistant", content: replyText, created_at: new Date().toISOString() });
    saveDB(db);

    return res.json({ output: { role:"assistant", content: replyText, via: usedProvider } });

  } catch (err) {
    console.error("Server /api/chat error:", err && err.stack ? err.stack : err);
    return res.status(500).json({ error:"server_error", details: err && err.message ? err.message : String(err) });
  }
});

/* history & static */
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
  console.log("GROQ_KEY:", GROQ_KEY ? "SET":"MISSING");
  console.log("GROQ_API_BASE:", GROQ_API_BASE);
  console.log("GROQ_MODEL_DEFAULT:", GROQ_MODEL_DEFAULT);
  console.log("GEMINI_KEY:", GEMINI_KEY ? "SET":"MISSING");
  console.log("GEMINI_API_BASE:", GEMINI_API_BASE);
  console.log("GEMINI_MODEL:", GEMINI_MODEL_ID);
});

process.on("SIGINT", () => { console.log("Shutting down..."); server.close(()=>process.exit(0)); });
