// backend/server.js
// Multi-provider chat proxy: Groq (default Llama 3.1) + Gemini (Google v1beta2).
// - Default: Llama 3.1 (via GROQ)
// - Optional: Gemini (switchable via UI)
// - No OpenAI inclusion (as requested)
// - Bind to 0.0.0.0 and process.env.PORT for Render compatibility
// - Robust parsing and fallback for Gemini "no body" responses

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
require("dotenv").config();
const fetch = require("node-fetch");

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0"; // Render requires 0.0.0.0
const PROJECT_ROOT = __dirname;
const PUBLIC_DIR = path.join(PROJECT_ROOT, "..", "public");
const DB_PATH = path.join(PROJECT_ROOT, "history.json");

// Env (trim)
const GROQ_KEY = (process.env.GROQ_KEY || "").trim();
const GROQ_API_BASE = (process.env.GROQ_API_BASE || "https://api.groq.com/openai/v1").trim();
// Keep default cheap model in .env: e.g. "llama-3.1-8b-instant"
const GROQ_MODEL_DEFAULT = (process.env.GROQ_MODEL || "llama-3.1-8b-instant").trim();

const GEMINI_KEY = (process.env.GEMINI_KEY || "").trim();
// Default to Gemini 2.0 flash name user requested; make configurable via env
const GEMINI_MODEL = (process.env.GEMINI_MODEL || "gemini-2.0").trim();

// Ensure history DB
if (!fs.existsSync(DB_PATH)) {
  try { fs.writeFileSync(DB_PATH, "{}", "utf8"); }
  catch (e) { console.error("Could not create history.json:", e); }
}

function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_PATH, "utf8") || "{}"); }
  catch (e) { console.error("loadDB error:", e); return {}; }
}
function saveDB(db) {
  try { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf8"); }
  catch (e) { console.error("saveDB error:", e); }
}

// Helpers
function containsDevanagari(s){ return /[\u0900-\u097F]/.test(s || ""); }
function sanitizeReply(text){
  if (!text) return "";
  if (typeof text !== "string") text = String(text);
  return text.replace(/\s+/g, " ").trim();
}

async function safeParseResponse(res){
  if (!res || !res.headers) return { ok:false, text:null };
  const ct = (res.headers.get && res.headers.get("content-type") || "").toLowerCase();
  try {
    if (ct.includes("application/json")) {
      const j = await res.json();
      return { ok: res.ok, json: j };
    } else {
      const t = await res.text();
      try { return { ok: res.ok, json: JSON.parse(t) }; } catch(e){ return { ok: res.ok, text: t }; }
    }
  } catch (e) {
    return { ok:false, error:e, text:null };
  }
}

/* --- Provider callers --- */

// GROQ OpenAI-compatible chat endpoint
async function callGroq(modelId, messagesArrOrString, opts={}) {
  if (!GROQ_KEY) throw new Error("GROQ_KEY_MISSING");
  const url = `${GROQ_API_BASE}/chat/completions`;
  const body = {
    model: modelId,
    messages: Array.isArray(messagesArrOrString) ? messagesArrOrString : [{ role: "user", content: String(messagesArrOrString) }],
    max_tokens: opts.maxOutputTokens || 1200,
    temperature: typeof opts.temperature === "number" ? opts.temperature : 0.6
  };
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type":"application/json", "Authorization": `Bearer ${GROQ_KEY}` },
    body: JSON.stringify(body)
  });
  const parsed = await safeParseResponse(resp);
  return { provider:"groq", resp, parsed };
}

// Gemini simple API-key generate (v1beta2). Many Google projects require service-account flows.
// This call tries the basic key-based endpoint; parsing is robust.
async function callGemini(modelId, userMessage, opts={}) {
  if (!GEMINI_KEY) throw new Error("GEMINI_KEY_MISSING");
  // v1beta2 generate endpoint
  const url = `https://generativelanguage.googleapis.com/v1beta2/models/${encodeURIComponent(modelId)}:generate?key=${GEMINI_KEY}`;
  const body = {
    prompt: { text: String(userMessage) },
    maxOutputTokens: opts.maxOutputTokens || 800,
    temperature: typeof opts.temperature === "number" ? opts.temperature : 0.6
  };
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify(body)
  });
  const parsed = await safeParseResponse(resp);
  return { provider:"gemini", resp, parsed };
}

/* --- Main endpoint --- */

app.post("/api/chat", async (req, res) => {
  try {
    const message = (req.body.message || "").toString();
    const convId = req.body.conversation_id || "default";
    // model keys used by frontend: "llama_3_1_8b_instant" (default) or "gemini_2_0"
    const modelKey = (req.body.model || "").toString().trim() || "llama_3_1_8b_instant";

    if (!message) return res.status(400).json({ error: "message required" });

    const db = loadDB();
    if (!db[convId]) db[convId] = [];
    db[convId].push({ role:"user", content: message, created_at: new Date().toISOString() });
    saveDB(db);

    // System message: keep reply in same script user used
    let systemMsg;
    if (containsDevanagari(message)) {
      systemMsg = { role:"system", content: "You are Indresh 2.0. User wrote in Devanagari (हिन्दी). Reply ONLY in Devanagari Hindi. Be concise and do NOT repeat the user's question." };
    } else {
      systemMsg = { role:"system", content: "You are Indresh 2.0. User wrote in Latin script (English/Hinglish). Reply in same script as user used. Do not repeat user's question." };
    }

    // Provider selection & call
    let providerResult = null;
    let usedProvider = null;
    try {
      if (modelKey === "gemini_2_0" || modelKey.startsWith("gemini")) {
        usedProvider = "gemini";
        providerResult = await callGemini(GEMINI_MODEL, message, { maxOutputTokens: 800, temperature: 0.6 });
      } else {
        // anything else -> use Groq with default llama model
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

    // Parse response (robust)
    let replyText = null;
    const p = providerResult && providerResult.parsed;
    if (p && p.json) {
      const j = p.json;
      replyText = j?.choices?.[0]?.message?.content
               || j?.choices?.[0]?.text
               || j?.output?.text
               || j?.candidates?.[0]?.content
               || j?.generated_text
               || (typeof j === "string" ? j : null);

      // Gemini alternative shapes: sometimes output is in j?.candidates[0].content or j?.output?.[0]?.content
      if (!replyText && j?.candidates && j.candidates[0] && (j.candidates[0].content || j.candidates[0].output)) {
        replyText = j.candidates[0].content || j.candidates[0].output;
      }
      // sometimes gemini returns { output: [{ content: '...' }] }
      if (!replyText && j?.output && Array.isArray(j.output) && j.output[0] && (j.output[0].content || j.output[0].text)) {
        replyText = j.output[0].content || j.output[0].text;
      }
    } else if (p && p.text) {
      replyText = p.text;
    } else if (p && p.ok === false && p.error) {
      replyText = `Provider returned error: ${JSON.stringify(p.error)}`;
    }

    // final fallback: raw body text
    if (!replyText && providerResult && providerResult.resp) {
      try {
        const raw = await providerResult.resp.text();
        if (raw && raw.length) replyText = raw;
      } catch (e) { /* ignore */ }
    }

    if (!replyText) {
      const detail = providerResult && providerResult.parsed ? (providerResult.parsed.json || providerResult.parsed.text || providerResult.parsed.error || null) : null;
      db[convId].push({ role:"assistant", content: `Provider error: no content`, created_at: new Date().toISOString(), meta:{ provider: usedProvider, detail }});
      saveDB(db);
      return res.status(502).json({ error:"provider_no_content", provider: usedProvider, detail: detail || "no body" });
    }

    // sanitize and save
    replyText = sanitizeReply(String(replyText).replace(/OpenAI|ChatGPT/gi, "Indresh 2.0"));
    db[convId].push({ role:"assistant", content: replyText, created_at: new Date().toISOString() });
    saveDB(db);

    return res.json({ output: { role: "assistant", content: replyText, via: usedProvider } });

  } catch (err) {
    console.error("Server /api/chat error:", err && err.stack ? err.stack : err);
    return res.status(500).json({ error:"server_error", details: err && err.message ? err.message : String(err) });
  }
});

/* history & static serve */
app.get("/api/history/:id", (req,res) => { const db = loadDB(); res.json({ messages: db[req.params.id] || [] }); });
app.post("/api/clear/:id", (req,res) => { const db = loadDB(); db[req.params.id] = []; saveDB(db); res.json({ ok:true }); });

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

const server = app.listen(PORT, HOST, () => {
  console.log(`Server running on ${HOST}:${PORT}`);
  console.log("PUBLIC_DIR:", PUBLIC_DIR, "exists:", fs.existsSync(PUBLIC_DIR));
  console.log("GROQ_KEY:", GROQ_KEY ? "SET len="+GROQ_KEY.length : "MISSING");
  console.log("GROQ_API_BASE:", GROQ_API_BASE);
  console.log("GROQ_MODEL_DEFAULT:", GROQ_MODEL_DEFAULT);
  console.log("GEMINI_KEY:", GEMINI_KEY ? "SET len="+GEMINI_KEY.length : "MISSING");
  console.log("GEMINI_MODEL:", GEMINI_MODEL);
});

process.on("SIGINT", () => { console.log("Shutting down..."); server.close(()=>process.exit(0)); });
