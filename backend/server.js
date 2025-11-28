// backend/server.js
// Multi-provider chat proxy — Groq (Llama) + Google Gemini (1.5 Pro / 2.5 Flash).
// Deploy-ready for Render (uses process.env.PORT). Restart server after changes.

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
require("dotenv").config();
const fetch = require("node-fetch"); // v2 style

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
// default env fallback
const GEMINI_MODEL_ID = (process.env.GEMINI_MODEL || "gemini-2.5-flash").trim();

// Ensure history file exists
if (!fs.existsSync(DB_PATH)) {
  try { fs.writeFileSync(DB_PATH, "{}", "utf8"); } catch (e) { console.error("Could not create history.json:", e); }
}
function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_PATH, "utf8") || "{}"); } catch (e) { console.error("loadDB error:", e); return {}; }
}
function saveDB(db) {
  try { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf8"); } catch (e) { console.error("saveDB error:", e); }
}

// Helpers
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

/* --- Provider callers --- */

// GROQ (OpenAI-compatible)
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

// Gemini (Google Generative) - v1beta2 endpoint usage with key query param fallback
async function callGemini(modelId, userMessage, opts={}) {
  if (!GEMINI_KEY) throw new Error("GEMINI_KEY_MISSING");
  // Use v1beta2 generate endpoint that works in many accounts. If your account requires a different path, set GEMINI_API_BASE env.
  const base = process.env.GEMINI_API_BASE || "https://generativelanguage.googleapis.com";
  const url = `${base}/v1beta2/models/${encodeURIComponent(modelId)}:generate?key=${encodeURIComponent(GEMINI_KEY)}`;
  const body = {
    prompt: { text: String(userMessage) },
    maxOutputTokens: opts.maxOutputTokens || 512,
    temperature: typeof opts.temperature === "number" ? opts.temperature : 0.6
  };
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    timeout: 20000
  });
  const parsed = await safeParseResponse(resp);
  return { provider:"gemini", resp, parsed };
}

/* --- Main chat endpoint --- */
app.post("/api/chat", async (req, res) => {
  try {
    const message = (req.body.message || "").toString();
    const convId = req.body.conversation_id || "default";
    const modelKey = (req.body.model || "").toString().trim() || "llama_3_1_8b_instant";

    if (!message) return res.status(400).json({ error: "message required" });

    // save user message
    const db = loadDB();
    if (!db[convId]) db[convId] = [];
    db[convId].push({ role:"user", content: message, created_at: new Date().toISOString() });
    saveDB(db);

    // system prompt: enforce script -> reply in same script
    let systemMsg;
    if (containsDevanagari(message)) {
      systemMsg = { role: "system", content: "You are Indresh 2.0. User used Devanagari Hindi. Reply IN HINDI using Devanagari only. Do NOT repeat the user's question. Keep answers clear and concise." };
    } else {
      systemMsg = { role: "system", content: "You are Indresh 2.0. User used Latin script (Hinglish/English). Reply in the same script. Do NOT repeat the user's question." };
    }

    // model mapping: client keys -> provider model ids
    const mk = (modelKey || "").toLowerCase();
    const GEMINI_KEY_MAP = {
      "gemini_1_5_pro": "gemini-1.5-pro",
      "gemini_1_5_flash": "gemini-1.5-flash",
      "gemini_2_0_flash": "gemini-2.0-flash",
      "gemini_2_5": "gemini-2.5-flash",
      "gemini_2_5_flash": "gemini-2.5-flash"
    };

    // choose provider and call
    let providerResult = null;
    let usedProvider = null;
    try {
      if (mk.startsWith("gemini")) {
        usedProvider = "gemini";
        const mappedModelId = GEMINI_KEY_MAP[mk] || GEMINI_MODEL_ID;
        console.log(`[chat] modelKey=${mk} -> using Gemini model ${mappedModelId}`);
        providerResult = await callGemini(mappedModelId, message, { maxOutputTokens: 1200, temperature: 0.6 });
      } else {
        usedProvider = "groq";
        const targetModel = GROQ_MODEL_DEFAULT;
        console.log(`[chat] modelKey=${mk} -> using Groq model ${targetModel}`);
        const messagesArr = [ systemMsg, { role:"user", content: message } ];
        providerResult = await callGroq(targetModel, messagesArr, { maxOutputTokens: 1400, temperature: 0.6 });
      }
    } catch (provErr) {
      console.warn("Provider call exception:", provErr);
      db[convId].push({ role:"assistant", content: `Provider error: ${String(provErr)}`, created_at: new Date().toISOString(), meta:{ error:true }});
      saveDB(db);
      return res.status(502).json({ error:"provider_exception", provider: usedProvider, detail: String(provErr) });
    }

    // Parse provider response robustly
    let replyText = null;
    const p = providerResult && providerResult.parsed;
    if (p && p.json) {
      const j = p.json;
      // Groq / OpenAI-like shapes
      replyText =
        j?.choices?.[0]?.message?.content ||
        j?.choices?.[0]?.text ||
        j?.output?.text ||
        j?.candidates?.[0]?.content ||
        j?.generated_text ||
        (typeof j === "string" ? j : null);

      // Gemini shapes: j.candidates[0].content or j.output?.[0]?.content
      if (!replyText && j?.candidates && j.candidates[0] && j.candidates[0].content) {
        // candidates content could be a string or object
        const c = j.candidates[0].content;
        if (typeof c === "string") replyText = c;
        else if (c?.text) replyText = c.text;
        else if (Array.isArray(c)) {
          replyText = c.map(seg => seg?.text || seg?.content?.[0]?.text || "").filter(Boolean).join("\n");
        }
      }
      if (!replyText && j?.output && Array.isArray(j.output) && j.output[0] && j.output[0].content) {
        const seg = j.output[0].content;
        if (typeof seg === "string") replyText = seg;
        else if (Array.isArray(seg)) {
          const texts = seg.map(s => (s?.text || (s?.content?.[0]?.text) || "")).filter(Boolean);
          if (texts.length) replyText = texts.join("\n");
        } else if (seg?.text) {
          replyText = seg.text;
        }
      }
    } else if (p && p.text) {
      replyText = p.text;
    } else if (p && p.ok === false && p.error) {
      replyText = `Provider returned error: ${JSON.stringify(p.error)}`;
    }

    // fallback raw body
    if (!replyText && providerResult && providerResult.resp) {
      try {
        const raw = await providerResult.resp.text();
        if (raw && raw.length) {
          replyText = raw;
        }
      } catch(e){}
    }

    if (!replyText) {
      const detail = providerResult && providerResult.parsed ? (providerResult.parsed.json || providerResult.parsed.text || providerResult.parsed.error || null) : null;
      db[convId].push({ role:"assistant", content: `Provider error: no content from ${usedProvider}`, created_at: new Date().toISOString(), meta:{ provider: usedProvider, detail }}); saveDB(db);
      console.log("[chat] providerResult.parsed:", JSON.stringify(providerResult && providerResult.parsed, null, 2));
      return res.status(502).json({ error:"provider_no_content", provider: usedProvider, detail: detail || "no body" });
    }

    // sanitize + replace mentions
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
  console.log("GEMINI_MODEL:", GEMINI_MODEL_ID);
});

process.on("SIGINT", () => { console.log("Shutting down..."); server.close(()=>process.exit(0)); });
