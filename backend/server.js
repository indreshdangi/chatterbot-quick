// backend/server.js
// Multi-provider proxy: GROQ (default Llama-3.1) + Gemini (gemini-1.5-flash).
// No OpenAI in this version. Listens on process.env.PORT and 0.0.0.0 for Render.

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
const HOST = process.env.HOST || "0.0.0.0"; // bind to 0.0.0.0 for Render

const PROJECT_ROOT = __dirname;
const PUBLIC_DIR = path.join(PROJECT_ROOT, "..", "public");
const DB_PATH = path.join(PROJECT_ROOT, "history.json");

// Env / defaults
const GROQ_KEY = (process.env.GROQ_KEY || "").trim();
const GROQ_API_BASE = (process.env.GROQ_API_BASE || "https://api.groq.com/openai/v1").trim();
const GROQ_MODEL_DEFAULT = (process.env.GROQ_MODEL || "llama-3.1-8b-instant").trim(); // default cheap model

const GEMINI_KEY = (process.env.GEMINI_KEY || "").trim();
const GEMINI_MODEL = (process.env.GEMINI_MODEL || "gemini-1.5-flash").trim(); // requested model

// whether model select dropdown is visible in UI. If "false", front-end will auto-select default.
const MODEL_SELECT_VISIBLE = (process.env.MODEL_SELECT_VISIBLE || "false").toLowerCase() === "true";

// Ensure DB file
if (!fs.existsSync(DB_PATH)) {
  try { fs.writeFileSync(DB_PATH, "{}", "utf8"); } catch (e) { console.error("Could not create history.json:", e); }
}
function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_PATH, "utf8") || "{}"); }
  catch (e) { console.error("loadDB error:", e); return {}; }
}
function saveDB(db) {
  try { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf8"); }
  catch (e) { console.error("saveDB error:", e); }
}

// helpers
function containsDevanagari(s){ return /[\u0900-\u097F]/.test(s || ""); }
function sanitizeReply(text){
  if (!text) return "";
  if (typeof text !== "string") text = String(text);
  return text.replace(/\s+/g, " ").trim();
}
async function safeParseResponse(res){
  if (!res || !res.headers) return { ok:false, text:null };
  const ct = (res.headers.get && (res.headers.get("content-type") || "") || "").toLowerCase();
  try {
    if (ct.includes("application/json")) {
      const j = await res.json();
      return { ok: res.ok, json: j };
    } else {
      const t = await res.text();
      try { return { ok: res.ok, json: JSON.parse(t) }; } catch(e){ return { ok: res.ok, text: t }; }
    }
  } catch(e){
    return { ok:false, error:e, text:null };
  }
}

/* --- Provider callers --- */

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

async function callGemini(modelId, userMessage, opts={}) {
  if (!GEMINI_KEY) throw new Error("GEMINI_KEY_MISSING");
  // NOTE: many Google projects require enabling the Generative AI API and proper key/permissions.
  const url = `https://generativelanguage.googleapis.com/v1beta2/models/${encodeURIComponent(modelId)}:generate?key=${GEMINI_KEY}`;
  const body = {
    prompt: { text: String(userMessage) },
    maxOutputTokens: opts.maxOutputTokens || 512,
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
    // allowed model keys: "groq" (or "llama_default") and "gemini_1_5"
    let modelKey = (req.body.model || "").toString().trim();
    if (!modelKey) {
      // If front-end hides select, default to groq llama-3.1
      modelKey = process.env.FORCE_MODEL === "gemini" ? "gemini_1_5" : "llama_default";
    }

    if (!message) return res.status(400).json({ error: "message required" });

    const db = loadDB();
    if (!db[convId]) db[convId] = [];
    db[convId].push({ role:"user", content: message, created_at: new Date().toISOString() });
    saveDB(db);

    // system prompt: respond in same script unless user asks
    let systemMsg;
    if (containsDevanagari(message)) {
      systemMsg = { role:"system", content: "You are Indresh 2.0. User wrote in Devanagari Hindi — reply ONLY in Devanagari (हिन्दी). Do not repeat user's question." };
    } else {
      systemMsg = { role:"system", content: "You are Indresh 2.0. User used Latin script; reply using the same script (Hinglish/English). Do not repeat the user's question." };
    }

    // select provider
    let providerResult = null;
    let usedProvider = null;
    try {
      if (modelKey === "gemini_1_5" || modelKey === "gemini") {
        usedProvider = "gemini";
        providerResult = await callGemini(GEMINI_MODEL, message, { maxOutputTokens: 900, temperature: 0.6 });
      } else {
        // default to GROQ + llama default model id
        usedProvider = "groq";
        const targetModel = GROQ_MODEL_DEFAULT; // e.g., "llama-3.1-8b-instant"
        const messagesArr = [ systemMsg, { role:"user", content: message } ];
        providerResult = await callGroq(targetModel, messagesArr, { maxOutputTokens: 1400, temperature: 0.6 });
      }
    } catch (provErr) {
      console.warn("Provider call exception:", provErr);
      db[convId].push({ role:"assistant", content: `Provider error: ${String(provErr)}`, created_at: new Date().toISOString(), meta:{ error:true }});
      saveDB(db);
      return res.status(502).json({ error:"provider_exception", provider: usedProvider, detail: String(provErr) });
    }

    // parse response robustly
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
      // gemini: check candidates array
      if (!replyText && j?.candidates && j.candidates[0] && j.candidates[0].content) replyText = j.candidates[0].content;
      // google sometimes returns {output: [{content:"..."}]} style
      if (!replyText && j?.output && Array.isArray(j.output) && j.output[0] && j.output[0].content) replyText = j.output[0].content;
    } else if (p && p.text) {
      replyText = p.text;
    } else if (p && p.ok === false && p.error) {
      replyText = `Provider returned error: ${JSON.stringify(p.error)}`;
    }

    // fallback: raw body text
    if (!replyText && providerResult && providerResult.resp) {
      try {
        const raw = await providerResult.resp.text();
        if (raw && raw.length) replyText = raw;
      } catch(e){}
    }

    if (!replyText) {
      const detail = providerResult && providerResult.parsed ? (providerResult.parsed.json || providerResult.parsed.text || providerResult.parsed.error || null) : null;
      db[convId].push({ role:"assistant", content: `Provider error: no content`, created_at: new Date().toISOString(), meta:{ provider: usedProvider, detail }});
      saveDB(db);
      return res.status(502).json({ error:"provider_no_content", provider: usedProvider, detail: detail || "no body" });
    }

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
  console.log(`Server running on http://${HOST}:${PORT}`);
  console.log("PUBLIC_DIR:", PUBLIC_DIR, "exists:", fs.existsSync(PUBLIC_DIR));
  console.log("GROQ_KEY:", GROQ_KEY ? "SET len="+GROQ_KEY.length : "MISSING");
  console.log("GROQ_API_BASE:", GROQ_API_BASE);
  console.log("GROQ_MODEL_DEFAULT:", GROQ_MODEL_DEFAULT);
  console.log("GEMINI_KEY:", GEMINI_KEY ? "SET len="+GEMINI_KEY.length : "MISSING");
  console.log("GEMINI_MODEL:", GEMINI_MODEL);
  console.log("MODEL_SELECT_VISIBLE:", MODEL_SELECT_VISIBLE);
});

process.on("SIGINT", () => { console.log("Shutting down..."); server.close(()=>process.exit(0)); });
