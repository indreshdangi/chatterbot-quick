// backend/server.js
// Fixed multi-provider proxy (Groq + Gemini).
// Deploy: set env vars (see README in chat). Restart server after env change.

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
require("dotenv").config();
const fetch = require("node-fetch"); // v2 style

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;
const PROJECT_ROOT = __dirname;
const PUBLIC_DIR = path.join(PROJECT_ROOT, "..", "public");
const DB_PATH = path.join(PROJECT_ROOT, "history.json");

// Env keys (trim)
const GROQ_KEY = (process.env.GROQ_KEY || "").trim();
const GROQ_API_BASE = (process.env.GROQ_API_BASE || "https://api.groq.com/openai/v1").trim();
const GROQ_MODEL_DEFAULT = (process.env.GROQ_MODEL || "llama-3.1-8b-instant").trim();

// Gemini env
const GEMINI_KEY = (process.env.GEMINI_KEY || "").trim();            // API key (if using key)
const GEMINI_BEARER = (process.env.GEMINI_BEARER || "").trim();      // Bearer token (if using)
const GEMINI_MODEL_ID = (process.env.GEMINI_MODEL || "gemini-2.5-pro").trim(); // recommended: gemini-2.5-pro
const GEMINI_API_BASE = (process.env.GEMINI_API_BASE || "https://generativelanguage.googleapis.com/v1").trim();
const GEMINI_USER_PROJECT = (process.env.GEMINI_USER_PROJECT || "").trim(); // optional, billing project id

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

/** robust fetch + parse **/
async function fetchAndParse(resp) {
  const ct = (resp && resp.headers && resp.headers.get("content-type")) || "";
  const status = resp.status;
  let text = null;
  try { text = await resp.text(); } catch(e) { text = null; }
  // try JSON parse
  let json = null;
  try { if (text && text.length) json = JSON.parse(text); } catch(e){ json = null; }
  return { status, headers: resp.headers.raw ? resp.headers.raw() : {}, text, json };
}

/* --- Provider callers --- */

// GROQ wrapper (unchanged)
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
  const parsed = await fetchAndParse(resp);
  return { provider:"groq", resp, parsed, requestBody: body };
}

// Gemini (Generative) call — robust, logs full server response text
async function callGemini(modelId, userMessage, opts={}) {
  // require gemini key or bearer
  if (!GEMINI_KEY && !GEMINI_BEARER) throw new Error("GEMINI_KEY_OR_BEARER_MISSING");

  // Build URL: use GEMINI_API_BASE and model path
  // Accept either `v1` or `v1beta2` style base in env. We append `/models/{id}:generate`
  const base = GEMINI_API_BASE.replace(/\/+$/,"");
  const pathUrl = `${base}/models/${encodeURIComponent(modelId)}:generate`;
  // If using API key, append ?key=...
  const url = GEMINI_KEY ? `${pathUrl}?key=${encodeURIComponent(GEMINI_KEY)}` : pathUrl;

  // Request body according to docs
  const body = {
    prompt: { text: String(userMessage) },
    // allow overriding token size
    maxOutputTokens: (typeof opts.maxOutputTokens === "number") ? opts.maxOutputTokens : 512,
    temperature: typeof opts.temperature === "number" ? opts.temperature : 0.6
  };

  // Build headers
  const headers = { "Content-Type": "application/json" };
  if (GEMINI_BEARER) headers["Authorization"] = `Bearer ${GEMINI_BEARER}`;
  if (GEMINI_USER_PROJECT) headers["X-Goog-User-Project"] = GEMINI_USER_PROJECT;

  // Log the outgoing call (useful for debugging)
  console.log("[callGemini] POST", url, "model:", modelId, "maxOutputTokens:", body.maxOutputTokens);
  if (GEMINI_USER_PROJECT) console.log("[callGemini] X-Goog-User-Project:", GEMINI_USER_PROJECT);
  // Do the call
  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    // increase timeout via signal if needed (omitted)
  });

  const parsed = await fetchAndParse(resp);
  console.log("[callGemini] status:", parsed.status, "content-type:", resp.headers.get("content-type"));
  // Log short preview of response for debugging (avoid full huge logs)
  if (parsed.text && parsed.text.length > 0) {
    console.log("[callGemini] response-text-preview:", parsed.text.slice(0,2000));
  } else {
    console.log("[callGemini] response had empty body or non-text");
  }
  return { provider:"gemini", resp, parsed, requestBody: body };
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

    // system prompt selection
    let systemMsg;
    if (containsDevanagari(message)) {
      systemMsg = { role: "system", content: "You are Indresh 2.0. User used Devanagari Hindi. Reply IN HINDI using Devanagari only. Do NOT repeat the user's question. Keep answers clear and concise." };
    } else {
      systemMsg = { role: "system", content: "You are Indresh 2.0. User used Latin script (Hinglish/English). Reply in the same script. Do NOT repeat the user's question." };
    }

    let providerResult = null;
    let usedProvider = null;
    try {
      if (modelKey.startsWith("gemini")) {
        // accept 'gemini_2_5' or direct gemini selection from client; use GEMINI_MODEL_ID from env
        usedProvider = "gemini";
        // callGemini uses GEMINI_MODEL_ID from env by default (we still pass that)
        providerResult = await callGemini(GEMINI_MODEL_ID, message, { maxOutputTokens: 900, temperature: 0.6 });
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

    // Parse provider response robustly
    let replyText = null;
    const p = providerResult && providerResult.parsed;
    // If parsed.json exists, try known shapes
    if (p && p.json) {
      const j = p.json;
      // Groq/OpenAI-like shapes
      replyText =
        j?.choices?.[0]?.message?.content ||
        j?.choices?.[0]?.text ||
        j?.output?.text ||
        j?.candidates?.[0]?.content ||
        j?.generated_text ||
        (typeof j === "string" ? j : null);

      // Gemini shapes: check `candidates` or `output[]`
      if (!replyText && j?.candidates && j.candidates[0] && j.candidates[0].content) {
        // candidate could be object or string
        const c = j.candidates[0].content;
        if (typeof c === "string") replyText = c;
        else if (c?.text) replyText = c.text;
        else if (Array.isArray(c)) replyText = c.map(x => x.text || x).join(" ");
      }
      if (!replyText && j?.output && Array.isArray(j.output) && j.output[0] && j.output[0].content) {
        const seg = j.output[0].content;
        if (typeof seg === "string") replyText = seg;
        else if (Array.isArray(seg)) {
          const texts = seg.map(s => (s?.text || (s?.content?.[0]?.text) || "" )).filter(Boolean);
          if (texts.length) replyText = texts.join("\n");
        } else if (seg?.text) replyText = seg.text;
      }
    }

    // If no parsed json but text present
    if (!replyText && p && p.text) {
      replyText = p.text;
    }

    // If still empty, try raw resp.text from providerResult
    if (!replyText && providerResult && providerResult.parsed && providerResult.parsed.text) {
      replyText = providerResult.parsed.text;
    }

    // If still empty, include debug dump (so user sees the failure)
    if (!replyText) {
      const detail = providerResult && providerResult.parsed ? {
        status: providerResult.parsed.status,
        headers_preview: providerResult.parsed.headers && Object.keys(providerResult.parsed.headers).slice(0,5),
        raw_preview: providerResult.parsed.text ? providerResult.parsed.text.slice(0,600) : null
      } : null;
      db[convId].push({ role:"assistant", content: `Provider error: no content from ${usedProvider}`, created_at: new Date().toISOString(), meta:{ provider: usedProvider, detail }});
      saveDB(db);
      return res.status(502).json({ error:"provider_no_content", provider: usedProvider, detail });
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
  console.log("GEMINI_BEARER:", GEMINI_BEARER ? "SET len="+GEMINI_BEARER.length : "MISSING");
  console.log("GEMINI_API_BASE:", GEMINI_API_BASE);
  console.log("GEMINI_MODEL:", GEMINI_MODEL_ID);
  if (GEMINI_USER_PROJECT) console.log("GEMINI_USER_PROJECT:", GEMINI_USER_PROJECT);
});

process.on("SIGINT", () => { console.log("Shutting down..."); server.close(()=>process.exit(0)); });
