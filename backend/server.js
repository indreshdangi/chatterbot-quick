// backend/server.js
// Improved debug-friendly server: robust Gemini + Groq callers with verbose logging.
// Replace your existing server.js with this, set ENV and redeploy.

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
require("dotenv").config();
const fetch = require("node-fetch"); // v2 style

const app = express();
app.use(cors());
app.use(express.json({ limit: "3mb" }));

const PORT = process.env.PORT || 3000;
const PROJECT_ROOT = __dirname;
const PUBLIC_DIR = path.join(PROJECT_ROOT, "..", "public");
const DB_PATH = path.join(PROJECT_ROOT, "history.json");

// ENV & defaults
const GROQ_KEY = (process.env.GROQ_KEY || "").trim();
const GROQ_API_BASE = (process.env.GROQ_API_BASE || "https://api.groq.com/openai/v1").trim();
const GROQ_MODEL_DEFAULT = (process.env.GROQ_MODEL || "llama-3.1-8b-instant").trim();

const GEMINI_KEY = (process.env.GEMINI_KEY || "").trim();
const GEMINI_API_BASE = (process.env.GEMINI_API_BASE || "https://generativelanguage.googleapis.com/v1").trim();
const GEMINI_MODEL_ID = (process.env.GEMINI_MODEL || "gemini-2.5-flash").trim();
// Optional header if billing is on separate project
const GEMINI_USER_PROJECT = (process.env.GEMINI_USER_PROJECT || "").trim();

// ensure history
if (!fs.existsSync(DB_PATH)) {
  try { fs.writeFileSync(DB_PATH, "{}", "utf8"); } catch(e){ console.error("Could not create history.json:", e); }
}
function loadDB(){ try { return JSON.parse(fs.readFileSync(DB_PATH, "utf8") || "{}"); } catch(e){ console.error("loadDB error:", e); return {}; } }
function saveDB(db){ try { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf8"); } catch(e){ console.error("saveDB error:", e); } }

function containsDevanagari(s){ return /[\u0900-\u097F]/.test(s || ""); }
function sanitizeReply(text){ if(!text) return ""; if(typeof text !== "string") text = String(text); return text.replace(/\s+/g," ").trim(); }

// safe parse helper
async function safeParseResponse(res){
  if (!res) return { ok:false, status:null, text:null };
  const status = res.status;
  let raw = null;
  try { raw = await res.text(); } catch(e) { raw = null; }
  // try json
  let json = null;
  try { json = raw ? JSON.parse(raw) : null; } catch(e) { json = null; }
  return { ok: res.ok, status, raw, json, headers: (() => { const h = {}; res.headers && res.headers.forEach && res.headers.forEach((v,k)=>h[k]=v); return h; })() };
}

/* --- Groq (OpenAI-compatible) --- */
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
  return { provider: "groq", url, body, parsed };
}

/* --- Gemini (Generative Language API) --- */
async function callGemini(modelId, userMessage, opts={}) {
  if (!GEMINI_KEY) throw new Error("GEMINI_KEY_MISSING");
  const url = `${GEMINI_API_BASE}/models/${encodeURIComponent(modelId)}:generate?key=${encodeURIComponent(GEMINI_KEY)}`;
  // Build request body strictly as API expects
  const bodyObj = {
    prompt: { text: String(userMessage) },
    maxOutputTokens: opts.maxOutputTokens || 512,
    temperature: typeof opts.temperature === "number" ? opts.temperature : 0.6
  };
  const headers = { "Content-Type": "application/json" };
  // Optionally add user project header if billing uses different project
  if (GEMINI_USER_PROJECT) headers["X-Goog-User-Project"] = GEMINI_USER_PROJECT;

  // debug log (not printing secret)
  console.log(`[callGemini] POST ${url} model:${modelId} maxOutputTokens:${bodyObj.maxOutputTokens} X-User-Project:${GEMINI_USER_PROJECT ? "SET":"NO"}`);

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(bodyObj),
    timeout: 20000
  });

  const parsed = await safeParseResponse(resp);
  // log response summary
  console.log("[callGemini] status:", parsed.status, "ok:", parsed.ok, "rawLen:", parsed.raw ? parsed.raw.length : 0);
  // if html returned, show small preview
  if (parsed.raw && parsed.raw.startsWith("<")) {
    console.warn("[callGemini] raw looks like HTML (maybe error page). preview:", parsed.raw.substring(0,300));
  }
  return { provider: "gemini", url, body: bodyObj, parsed };
}

/* --- Helper to extract text from provider JSON shapes --- */
function extractTextFromProvider(parsed) {
  if (!parsed) return null;
  // prefer parsed.json
  const j = parsed.json;
  if (j) {
    // OpenAI-like
    if (j.choices && j.choices[0]) {
      return j.choices[0].message?.content || j.choices[0].text || null;
    }
    // Gemini shapes:
    if (j.candidates && j.candidates[0] && j.candidates[0].content) return j.candidates[0].content;
    if (j.output && Array.isArray(j.output) && j.output[0] && j.output[0].content) {
      const seg = j.output[0].content;
      if (typeof seg === "string") return seg;
      if (Array.isArray(seg)) {
        const texts = seg.map(s => (s?.text || (s?.content?.[0]?.text) || "")).filter(Boolean);
        if (texts.length) return texts.join("\n");
      }
    }
    // fallback if top-level text
    if (typeof j === "string") return j;
  }
  // fallback to raw text if present
  if (parsed.raw) return parsed.raw;
  return null;
}

/* --- Main chat endpoint --- */
app.post("/api/chat", async (req, res) => {
  try {
    const message = (req.body.message || "").toString();
    const convId = req.body.conversation_id || "default";
    const modelKey = (req.body.model || "").toString().trim() || "llama_3_1_8b_instant";

    if (!message) return res.status(400).json({ error: "message required" });

    const db = loadDB();
    if (!db[convId]) db[convId] = [];
    db[convId].push({ role:"user", content: message, created_at: new Date().toISOString() });
    saveDB(db);

    let systemMsg;
    if (containsDevanagari(message)) {
      systemMsg = { role: "system", content: "You are Indresh 2.0. User used Devanagari Hindi. Reply IN HINDI using Devanagari only. Do NOT repeat the user's question. Keep answers clear and concise." };
    } else {
      systemMsg = { role: "system", content: "You are Indresh 2.0. Reply in same script as user. Do NOT repeat the user's question." };
    }

    let providerResult = null;
    let usedProvider = null;

    // Attempt Gemini if requested
    if (modelKey.startsWith("gemini") || modelKey === "gemini_2_5") {
      usedProvider = "gemini";
      try {
        const modelName = GEMINI_MODEL_ID;
        providerResult = await callGemini(modelName, message, { maxOutputTokens: 900, temperature: 0.6 });
      } catch (err) {
        console.warn("callGemini exception:", err && err.message ? err.message : err);
        providerResult = { provider: "gemini", parsed: { ok:false, status:null, raw: String(err) } };
      }
    } else {
      // default to Groq
      usedProvider = "groq";
      try {
        const targetModel = GROQ_MODEL_DEFAULT;
        const messagesArr = [ systemMsg, { role:"user", content: message } ];
        providerResult = await callGroq(targetModel, messagesArr, { maxOutputTokens: 1400, temperature: 0.6 });
      } catch (err) {
        console.warn("callGroq exception:", err && err.message ? err.message : err);
        providerResult = { provider: "groq", parsed: { ok:false, status:null, raw: String(err) } };
      }
    }

    // Diagnostics: log provider parsed object summary
    console.log("[chat] providerResult.parsed:", providerResult && providerResult.parsed ? { ok: providerResult.parsed.ok, status: providerResult.parsed.status, rawLen: providerResult.parsed.raw ? providerResult.parsed.raw.length : 0 } : "no parsed");

    // Extract text
    let replyText = extractTextFromProvider(providerResult.parsed);

    // If no replyText from chosen provider and provider was gemini -> show full parsed raw for debugging then try fallback to Groq
    if (!replyText && usedProvider === "gemini") {
      // log full debug object to console (not to user directly)
      console.error("[server] Gemini returned no usable content. parsed:", providerResult.parsed);
      // attempt fallback to Groq if configured
      if (GROQ_KEY) {
        console.log("[server] Falling back to GROQ model:", GROQ_MODEL_DEFAULT);
        const messagesArr = [ systemMsg, { role:"user", content: message } ];
        const groqResp = await callGroq(GROQ_MODEL_DEFAULT, messagesArr, { maxOutputTokens: 900, temperature: 0.6 });
        let gtext = extractTextFromProvider(groqResp.parsed);
        if (gtext) {
          replyText = gtext;
          usedProvider = "groq(fallback)";
        } else {
          console.error("[server] Groq fallback also returned nothing. parsed:", groqResp.parsed);
        }
      }
    }

    if (!replyText) {
      const detail = providerResult && providerResult.parsed ? (providerResult.parsed.json || providerResult.parsed.raw || providerResult.parsed) : null;
      db[convId].push({ role:"assistant", content: `Provider error: no content from ${usedProvider}`, created_at: new Date().toISOString(), meta:{ provider: usedProvider, detail }} );
      saveDB(db);
      return res.status(502).json({ error:"provider_no_content", provider: usedProvider, detail });
    }

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
  console.log("GEMINI_API_BASE:", GEMINI_API_BASE);
  console.log("GEMINI_MODEL:", GEMINI_MODEL_ID);
  if (GEMINI_USER_PROJECT) console.log("GEMINI_USER_PROJECT:", GEMINI_USER_PROJECT);
});

process.on("SIGINT", () => { console.log("Shutting down..."); server.close(()=>process.exit(0)); });
