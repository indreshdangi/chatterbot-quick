// backend/server.js
// Multi-provider chat proxy — Llama (Groq) default + Gemini (Google).
// Restart server with: node server.js

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
// Default Groq model id (keep a cheap default)
const GROQ_MODEL_DEFAULT = (process.env.GROQ_MODEL || "llama-3.1-8b-instant").trim();

const GEMINI_KEY = (process.env.GEMINI_KEY || "").trim();
// Use latest recommended: gemini-2.5-flash by default. Change via env GEMINI_MODEL
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

/** Robust extractor for provider responses (OpenAI-like, Groq, Gemini) **/
function extractTextFromProviderJson(j) {
  if (!j) return null;

  // 1) OpenAI/Groq-style: choices[0].message.content or choices[0].text
  try {
    if (j.choices && Array.isArray(j.choices) && j.choices[0]) {
      const c = j.choices[0];
      // chat-style
      if (c.message && (c.message.content || c.message.role)) {
        if (typeof c.message.content === "string" && c.message.content.trim()) return c.message.content;
        // sometimes content is object
        if (c.message.content && typeof c.message.content === "object") {
          // fallback to text fields inside
          if (c.message.content.text) return c.message.content.text;
        }
      }
      if (typeof c.text === "string" && c.text.trim()) return c.text;
    }
  } catch(e){ /* ignore */ }

  // 2) Common direct shapes
  if (typeof j.generated_text === "string" && j.generated_text.trim()) return j.generated_text;
  if (typeof j.output === "string" && j.output.trim()) return j.output;

  // 3) Some providers return j.output.text or j.output[0].content.text
  try {
    if (j.output) {
      // output.text
      if (typeof j.output.text === "string" && j.output.text.trim()) return j.output.text;

      // output is array with content segments
      if (Array.isArray(j.output) && j.output.length) {
        // try join content.text or content parts
        const out0 = j.output[0];
        // if output[0].content is array or string
        if (out0.content) {
          if (typeof out0.content === "string" && out0.content.trim()) return out0.content;
          if (Array.isArray(out0.content)) {
            const texts = out0.content.map(seg => (seg.text || seg)).filter(Boolean).map(String);
            if (texts.length) return texts.join(" ");
          }
          // maybe out0.content is object with parts
          if (out0.content.parts && Array.isArray(out0.content.parts)) {
            const ptexts = out0.content.parts.map(p => p.text || p).filter(Boolean).map(String);
            if (ptexts.length) return ptexts.join(" ");
          }
        }
      }
    }
  } catch(e){ /* ignore */ }

  // 4) Gemini-style: candidates[].content.parts[].text OR candidates[].content (string)
  try {
    if (j.candidates && Array.isArray(j.candidates) && j.candidates[0]) {
      const cand = j.candidates[0];

      // candidate.content.parts (array)
      if (cand.content && cand.content.parts && Array.isArray(cand.content.parts)) {
        const parts = cand.content.parts.map(p => {
          if (typeof p === "string") return p;
          if (p && p.text) return p.text;
          if (p && p.content) {
            // sometimes nested objects
            if (typeof p.content === "string") return p.content;
            if (Array.isArray(p.content)) return p.content.map(x => x.text || x).filter(Boolean).join(" ");
          }
          return "";
        }).filter(Boolean);
        if (parts.length) return parts.join(" ");
      }

      // candidate.content might be string
      if (typeof cand.content === "string" && cand.content.trim()) return cand.content;

      // candidate.content may be object with text or content fields
      if (cand.content && typeof cand.content === "object") {
        // try cand.content.text
        if (cand.content.text && typeof cand.content.text === "string" && cand.content.text.trim()) return cand.content.text;
        // try nested content[].text
        if (Array.isArray(cand.content) && cand.content.length) {
          const txts = cand.content.map(x => (x && x.text) || x).filter(Boolean).map(String);
          if (txts.length) return txts.join(" ");
        }
      }
    }
  } catch(e){ /* ignore */ }

  // 5) legacy structures: j.data[0].text
  try {
    if (j.data && Array.isArray(j.data) && j.data[0] && typeof j.data[0].text === "string") {
      const t = j.data[0].text;
      if (t && t.trim()) return t;
    }
  } catch(e){ /* ignore */ }

  // 6) If nothing matched, attempt to stringify some common fields if they exist (small)
  try {
    if (j.result && typeof j.result === "string" && j.result.trim()) return j.result;
  } catch(e){}

  return null;
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
    body: JSON.stringify(body)
  });
  const parsed = await safeParseResponse(resp);
  return { provider:"groq", resp, parsed, rawBody: parsed.json || parsed.text || null };
}

// Gemini (Google Generative) - key method
async function callGemini(modelId, userMessage, opts={}) {
  if (!GEMINI_KEY) throw new Error("GEMINI_KEY_MISSING");
  // Official endpoint shape (key query param)
  const url = `https://generativelanguage.googleapis.com/v1beta2/models/${encodeURIComponent(modelId)}:generate?key=${encodeURIComponent(GEMINI_KEY)}`;
  const body = {
    prompt: { text: String(userMessage) },
    maxOutputTokens: opts.maxOutputTokens || 512,
    temperature: typeof opts.temperature === "number" ? opts.temperature : 0.6
  };
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const parsed = await safeParseResponse(resp);
  return { provider:"gemini", resp, parsed, rawBody: parsed.json || parsed.text || null };
}

/* --- Main chat endpoint --- */
app.post("/api/chat", async (req, res) => {
  try {
    const message = (req.body.message || "").toString();
    const convId = req.body.conversation_id || "default";
    // model keys we accept from client
    // 'llama_3_1_8b_instant' => Groq default
    // 'gemini_2_5' => Google Gemini
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

    // choose provider and call
    let providerResult = null;
    let usedProvider = null;
    try {
      if (modelKey === "gemini_2_5" || modelKey.startsWith("gemini")) {
        usedProvider = "gemini";
        // call Gemini with the configured model id
        providerResult = await callGemini(GEMINI_MODEL_ID, message, { maxOutputTokens: 1200, temperature: 0.6 });
      } else {
        // default -> Groq Llama 3.1 8b instant
        usedProvider = "groq";
        const targetModel = GROQ_MODEL_DEFAULT; // e.g. "llama-3.1-8b-instant"
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
      // try generic extractor
      replyText = extractTextFromProviderJson(j);

      // As extra attempt: if json contains top-level text-like fields
      if (!replyText) {
        // try direct fallback to stringifying small useful keys (but avoid sending huge objects)
        if (j?.error && typeof j.error === "string") replyText = `Error from provider: ${j.error}`;
      }

      // log parsed result for debugging
      console.log("[debug] providerResult.parsed:", { provider: usedProvider, status: p.status, parsedKeys: Object.keys(j || {}), extractedTextExists: !!replyText });
    } else if (p && p.text) {
      replyText = p.text;
    } else if (p && p.ok === false && p.error) {
      replyText = `Provider returned error: ${JSON.stringify(p.error)}`;
    }

    // fallback: try raw text from response if no parsed content
    if (!replyText && providerResult && providerResult.resp) {
      try {
        const raw = await providerResult.resp.text();
        if (raw && raw.length) {
          // attempt to extract JSON if raw text looks like JSON
          try {
            const parsedRaw = JSON.parse(raw);
            const extracted = extractTextFromProviderJson(parsedRaw);
            if (extracted) replyText = extracted;
            else replyText = String(parsedRaw).slice(0, 200); // small fallback
          } catch(e) {
            // not JSON: use raw string
            replyText = raw.slice(0, 1000);
          }
        }
      } catch(e){}
    }

    if (!replyText) {
      const detail = providerResult && providerResult.parsed ? (providerResult.parsed.json || providerResult.parsed.text || providerResult.parsed.error || null) : null;
      db[convId].push({ role:"assistant", content: `Provider error: no content from ${usedProvider}`, created_at: new Date().toISOString(), meta:{ provider: usedProvider, detail }} );
      saveDB(db);
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
