// backend/server.js
// Multi-provider chat proxy: GROQ (Llama default) + Gemini (Google).
// - No OpenAI usage (as requested).
// - Robust Gemini handling: tries multiple endpoint variants and returns clear errors.
// - Keep convo history in backend/history.json

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
const PROJECT_ROOT = __dirname;
const PUBLIC_DIR = path.join(PROJECT_ROOT, "..", "public");
const DB_PATH = path.join(PROJECT_ROOT, "history.json");

// env keys (trim)
const GROQ_KEY = (process.env.GROQ_KEY || "").trim();
const GROQ_API_BASE = (process.env.GROQ_API_BASE || "https://api.groq.com/openai/v1").trim();
// default llama model (keep cheap 3.1 instant in .env)
const GROQ_MODEL_DEFAULT = (process.env.GROQ_MODEL || "llama-3.1-8b-instant").trim();

// Gemini config (set exact official model name into GEMINI_MODEL env)
const GEMINI_KEY = (process.env.GEMINI_KEY || "").trim();
const GEMINI_MODEL = (process.env.GEMINI_MODEL || "gemini-2.0-flash").trim();

// Ensure history file
if (!fs.existsSync(DB_PATH)) {
  try { fs.writeFileSync(DB_PATH, "{}", "utf8"); } catch (e) { console.error("Could not create history.json:", e); }
}
function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_PATH, "utf8") || "{}"); } catch (e) { console.error("loadDB error:", e); return {}; }
}
function saveDB(db) {
  try { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf8"); } catch (e) { console.error("saveDB error:", e); }
}

function containsDevanagari(s){ return /[\u0900-\u097F]/.test(s || ""); }
function sanitizeReply(text){
  if (!text) return "";
  if (typeof text !== "string") text = String(text);
  return text.replace(/\s+/g, " ").trim();
}

async function safeParseResponse(res){
  if (!res || !res.headers) return { ok:false, text:null, status: res ? res.status : null };
  const ct = (res.headers.get && res.headers.get("content-type") || "").toLowerCase();
  try {
    if (ct.includes("application/json")) {
      const j = await res.json();
      return { ok: res.ok, json: j, status: res.status };
    } else {
      const t = await res.text();
      try { return { ok: res.ok, json: JSON.parse(t), status: res.status }; } catch(e){ return { ok: res.ok, text: t, status: res.status }; }
    }
  } catch(e){
    return { ok:false, error:e, text:null, status: res.status };
  }
}

/* ---------- GROQ (Llama via Groq) ---------- */
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
  return { provider: "groq", resp, parsed };
}

/* ---------- Gemini (Google Generative) ---------- */
/*
  Notes:
   - Different projects / keys / API versions can require different endpoints.
   - We'll try a couple of endpoints (v1beta2 and v1) that people commonly use.
   - If your API key requires service-account (IAM) auth instead of simple API key, this simple key method will 404/403.
*/
async function callGemini(modelId, userMessage, opts={}) {
  if (!GEMINI_KEY) throw new Error("GEMINI_KEY_MISSING");

  // candidate endpoints (try in order until one returns a meaningful body)
  const endpoints = [
    // older widely used form:
    `https://generativelanguage.googleapis.com/v1beta2/models/${encodeURIComponent(modelId)}:generate?key=${GEMINI_KEY}`,
    // newer versions may exist (v1/v1beta3). We include a v1 variant:
    `https://generativelanguage.googleapis.com/v1/models/${encodeURIComponent(modelId)}:generate?key=${GEMINI_KEY}`,
    // another possible form (discuss/predict style) - try predict if available
    `https://generativelanguage.googleapis.com/v1/models/${encodeURIComponent(modelId)}:predict?key=${GEMINI_KEY}`
  ];

  // request body format: keep simple text prompt wrapper (works in many examples)
  const bodyTemplate = {
    prompt: { text: String(userMessage) },
    maxOutputTokens: opts.maxOutputTokens || 512,
    temperature: typeof opts.temperature === "number" ? opts.temperature : 0.6
  };

  let lastErr = null;
  for (const url of endpoints) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type":"application/json" },
        body: JSON.stringify(bodyTemplate)
      });
      const parsed = await safeParseResponse(resp);
      // if parsed has JSON with content, return immediately
      if (parsed && parsed.json && (parsed.json.candidates || parsed.json.output || parsed.json.text)) {
        return { provider: "gemini", resp, parsed, urlTried: url };
      }
      // sometimes v1 returns empty body but status helps
      if (parsed && (parsed.text || (parsed.json && Object.keys(parsed.json).length))) {
        return { provider: "gemini", resp, parsed, urlTried: url };
      }
      // otherwise record and try next
      lastErr = { url, parsed };
    } catch (e) {
      lastErr = { url, error: e };
    }
  }

  // If none worked, throw informative error
  const msg = { message: "No usable response from Gemini endpoints", attempts: lastErr };
  const fakeResp = { provider: "gemini", parsed: lastErr && lastErr.parsed ? lastErr.parsed : null, errorInfo: msg };
  return fakeResp;
}

/* ---------- Main chat endpoint ---------- */
app.post("/api/chat", async (req, res) => {
  try {
    const message = (req.body.message || "").toString();
    const convId = req.body.conversation_id || "default";
    // model key from client: 'llama' or 'gemini' — we map it
    const modelKey = (req.body.model || "").toString().trim() || "llama_3_1_8b_instant";

    if (!message) return res.status(400).json({ error: "message required" });

    const db = loadDB();
    if (!db[convId]) db[convId] = [];
    db[convId].push({ role: "user", content: message, created_at: new Date().toISOString() });
    saveDB(db);

    // build simple system prompt depending on script
    let systemMsg;
    if (containsDevanagari(message)) {
      systemMsg = { role: "system", content: "You are Indresh 2.0. User wrote in Devanagari Hindi. Reply in Devanagari Hindi only." };
    } else {
      systemMsg = { role: "system", content: "You are Indresh 2.0. User used Latin script (Hinglish/English). Reply in same script the user used. Do not repeat user's question." };
    }

    // provider selection
    let providerResult = null;
    let usedProvider = null;
    try {
      if (modelKey === "gemini") {
        usedProvider = "gemini";
        providerResult = await callGemini(GEMINI_MODEL, message, { maxOutputTokens: 800, temperature: 0.6 });
      } else {
        // any llama selection -> use GROQ with default model (cheap) unless explicit llama_3_3 chosen (we removed 3.3 per request)
        usedProvider = "groq";
        const messagesArr = [ systemMsg, { role: "user", content: message } ];
        providerResult = await callGroq(GROQ_MODEL_DEFAULT, messagesArr, { maxOutputTokens: 1400, temperature: 0.6 });
      }
    } catch (provErr) {
      console.warn("Provider call exception:", provErr);
      db[convId].push({ role: "assistant", content: `Provider error: ${String(provErr)}`, created_at: new Date().toISOString(), meta: { error: true } });
      saveDB(db);
      return res.status(502).json({ error: "provider_exception", provider: usedProvider, detail: String(provErr) });
    }

    // parse providerResult robustly
    let replyText = null;
    const p = providerResult && providerResult.parsed;
    if (usedProvider === "groq") {
      if (p && p.json) {
        const j = p.json;
        replyText =
          j?.choices?.[0]?.message?.content ||
          j?.choices?.[0]?.text ||
          j?.generated_text ||
          j?.output?.text ||
          (typeof j === "string" ? j : null);
      } else if (p && p.text) replyText = p.text;
    } else if (usedProvider === "gemini") {
      // Gemini shapes vary: try multiple fields
      if (p && p.json) {
        const j = p.json;
        // common: candidates[0].content, or output.text, or output[0].content
        replyText =
          j?.candidates?.[0]?.content ||
          j?.output?.[0]?.content ||
          j?.output?.text ||
          j?.text ||
          j?.candidates?.[0]?.message?.content ||
          (typeof j === "string" ? j : null);
      }
      if (!replyText && providerResult && providerResult.parsed && providerResult.parsed.text) replyText = providerResult.parsed.text;
    }

    // fallback: raw response body if available
    if (!replyText && providerResult && providerResult.resp) {
      try {
        const raw = await providerResult.resp.text();
        if (raw && raw.length) replyText = raw;
      } catch (e) { /* ignore */ }
    }

    // If still no replyText, return clear provider_no_content with parsed info
    if (!replyText) {
      const detail = providerResult && providerResult.parsed ? (providerResult.parsed.json || providerResult.parsed.text || providerResult.parsed.error || providerResult.errorInfo || null) : null;
      db[convId].push({ role:"assistant", content: `Provider error: no content from ${usedProvider}`, created_at: new Date().toISOString(), meta:{ provider: usedProvider, detail } });
      saveDB(db);
      return res.status(502).json({ error: "provider_no_content", provider: usedProvider, detail: detail || "no body" });
    }

    // sanitize/store
    replyText = sanitizeReply(String(replyText).replace(/OpenAI|ChatGPT/gi, "Indresh 2.0"));
    db[convId].push({ role: "assistant", content: replyText, created_at: new Date().toISOString() });
    saveDB(db);

    return res.json({ output: { role: "assistant", content: replyText, via: usedProvider, meta: { tried: providerResult && providerResult.urlTried ? providerResult.urlTried : undefined } } });

  } catch (err) {
    console.error("Server /api/chat error:", err && err.stack ? err.stack : err);
    return res.status(500).json({ error: "server_error", details: err && err.message ? err.message : String(err) });
  }
});

/* history + static */
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

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running http://0.0.0.0:${PORT}`);
  console.log("PUBLIC_DIR:", PUBLIC_DIR, "exists:", fs.existsSync(PUBLIC_DIR));
  console.log("GROQ_KEY:", GROQ_KEY ? "SET len="+GROQ_KEY.length : "MISSING");
  console.log("GROQ_API_BASE:", GROQ_API_BASE);
  console.log("GROQ_MODEL_DEFAULT:", GROQ_MODEL_DEFAULT);
  console.log("GEMINI_KEY:", GEMINI_KEY ? "SET len="+GEMINI_KEY.length : "MISSING");
  console.log("GEMINI_MODEL:", GEMINI_MODEL);
});

process.on("SIGINT", () => { console.log("Shutting down..."); server.close(()=>process.exit(0)); });
