// backend/server.js
// Fixed multi-provider proxy (Groq Llama + Google Gemini primary).
// Use env vars: GEMINI_KEY, GEMINI_MODEL (default gemini-2.5-flash), GROQ_KEY, GROQ_MODEL (default llama-3.1-8b-instant)
// Restart server with: node server.js

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
require("dotenv").config();
const fetch = require("node-fetch"); // v2 style compatible

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

const PORT = process.env.PORT || 3000;
const PROJECT_ROOT = __dirname;
const PUBLIC_DIR = path.join(PROJECT_ROOT, "..", "public");
const DB_PATH = path.join(PROJECT_ROOT, "history.json");

// Env keys (trim)
const GROQ_KEY = (process.env.GROQ_KEY || "").trim();
const GROQ_API_BASE = (process.env.GROQ_API_BASE || "https://api.groq.com/openai/v1").trim();
const GROQ_MODEL_DEFAULT = (process.env.GROQ_MODEL || "llama-3.1-8b-instant").trim();

const GEMINI_KEY = (process.env.GEMINI_KEY || "").trim();
const GEMINI_MODEL_ID = (process.env.GEMINI_MODEL || "gemini-2.5-flash").trim();

// ensure DB file
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

// Robust extractor: tries many shapes to get text from provider JSON
function extractTextFromJson(j) {
  if (!j) return "";

  // If it's a string
  if (typeof j === "string") return j;

  // If object has obvious fields
  const tryGet = (obj, pathArr) => {
    try {
      let cur = obj;
      for (const p of pathArr) {
        if (cur == null) return null;
        cur = cur[p];
      }
      return cur;
    } catch (e) {
      return null;
    }
  };

  // 1) OpenAI-like choices -> choices[0].message.content || choices[0].text
  const cmsg = tryGet(j, ["choices", 0, "message", "content"]);
  if (typeof cmsg === "string" && cmsg.trim()) return cmsg;
  const ctext = tryGet(j, ["choices", 0, "text"]);
  if (typeof ctext === "string" && ctext.trim()) return ctext;

  // 2) Groq style maybe j.output?.text or j.generated_text
  if (typeof j.output === "string" && j.output.trim()) return j.output;
  if (typeof j.generated_text === "string" && j.generated_text.trim()) return j.generated_text;

  // 3) Gemini style: candidates[0].content
  const cand = tryGet(j, ["candidates", 0, "content"]);
  if (cand) {
    if (typeof cand === "string" && cand.trim()) return cand;
    // if content is array of segments or objects
    if (Array.isArray(cand)) {
      const texts = [];
      for (const seg of cand) {
        if (typeof seg === "string" && seg.trim()) texts.push(seg);
        else if (seg && typeof seg.text === "string") texts.push(seg.text);
        else if (seg && seg.segments) {
          for (const s of seg.segments) if (s && (s.text || s.content)) texts.push(s.text || s.content || "");
        }
      }
      if (texts.length) return texts.join("\n");
    } else if (typeof cand === "object") {
      // maybe nested structure
      const t = cand.text || (cand[0] && cand[0].text) || null;
      if (t) return t;
      // fallback: stringify minimal
      try {
        const s = JSON.stringify(cand);
        if (s && s.length < 2000) return s;
      } catch(e){}
    }
  }

  // 4) Gemini output: j.output[0].content -> could be array of segments
  const out = tryGet(j, ["output", 0, "content"]);
  if (out) {
    // array of pieces
    if (typeof out === "string") return out;
    if (Array.isArray(out)) {
      const segs = out.map(x => {
        if (typeof x === "string") return x;
        if (x && typeof x.text === "string") return x.text;
        if (x && x.content && Array.isArray(x.content)) return x.content.map(c => c.text || "").join("");
        return "";
      }).filter(Boolean);
      if (segs.length) return segs.join("\n");
    } else if (typeof out === "object") {
      if (typeof out.text === "string") return out.text;
    }
  }

  // 5) Some providers place text under candidates[0].content[0].text or similar - deep search for 'text' strings
  function deepCollectStrings(o, acc = []) {
    if (!o) return acc;
    if (typeof o === "string") { acc.push(o); return acc; }
    if (Array.isArray(o)) {
      for (const it of o) deepCollectStrings(it, acc);
      return acc;
    }
    if (typeof o === "object") {
      for (const k of Object.keys(o)) deepCollectStrings(o[k], acc);
      return acc;
    }
    return acc;
  }
  const collected = deepCollectStrings(j).filter(s => typeof s === "string" && s.trim().length > 0);
  if (collected.length) {
    // pick first few joined but limit length
    return collected.slice(0, 6).join("\n");
  }

  return "";
}

async function safeParseResponse(res){
  if (!res || !res.headers) return { ok:false, text:null };
  const ct = (res.headers.get && (res.headers.get("content-type") || "").toLowerCase()) || "";
  try {
    if (ct.includes("application/json") || ct.includes("text/json")) {
      const j = await res.json();
      return { ok: res.ok, json: j, status: res.status };
    } else {
      const t = await res.text();
      try { return { ok: res.ok, json: JSON.parse(t), status: res.status }; } catch(e){ return { ok: res.ok, text: t, status: res.status }; }
    }
  } catch(e){
    // if parsing failed, try raw text
    try {
      const t = await res.text();
      return { ok: res.ok, text: t, status: res.status, error: e };
    } catch(ee) {
      return { ok:false, error:e, text:null };
    }
  }
}

/* --- Provider callers --- */

// GROQ / OpenAI-compatible
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

// GEMINI (Google Generative) - using key query param (or you can set Authorization: Bearer)
async function callGemini(modelId, userMessage, opts={}) {
  if (!GEMINI_KEY) throw new Error("GEMINI_KEY_MISSING");
  // Use v1 endpoint and key param (works with API key). If you prefer bearer token, replace with Authorization header.
  const url = `https://generativelanguage.googleapis.com/v1/models/${encodeURIComponent(modelId)}:generate?key=${encodeURIComponent(GEMINI_KEY)}`;
  const body = {
    prompt: { text: String(userMessage) },
    // control tokens/settings
    maxOutputTokens: typeof opts.maxOutputTokens === "number" ? opts.maxOutputTokens : 512,
    temperature: typeof opts.temperature === "number" ? opts.temperature : 0.6
  };
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
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

    // system prompt
    let systemMsg;
    if (containsDevanagari(message)) {
      systemMsg = { role: "system", content: "You are Indresh 2.0. User used Devanagari Hindi. Reply IN HINDI using Devanagari only. Do NOT repeat the user's question. Keep answers clear and concise." };
    } else {
      systemMsg = { role: "system", content: "You are Indresh 2.0. User used Latin script (Hinglish/English). Reply in the same script. Do NOT repeat the user's question." };
    }

    // choose provider
    let providerResult = null;
    let usedProvider = null;

    if (modelKey.startsWith("gemini")) {
      // Gemini selected — attempt Gemini only (no automatic fallback)
      if (!GEMINI_KEY) {
        db[convId].push({ role:"assistant", content: `Provider error: GEMINI_KEY missing`, created_at: new Date().toISOString(), meta:{ error:true }});
        saveDB(db);
        return res.status(502).json({ error:"provider_exception", provider: "gemini", detail: "GEMINI_KEY missing in server env" });
      }
      usedProvider = "gemini";
      providerResult = await callGemini(GEMINI_MODEL_ID, message, { maxOutputTokens: 1200, temperature: 0.6 });

    } else {
      // Default -> Groq (Llama)
      if (!GROQ_KEY) {
        db[convId].push({ role:"assistant", content: `Provider error: GROQ_KEY missing`, created_at: new Date().toISOString(), meta:{ error:true }});
        saveDB(db);
        return res.status(502).json({ error:"provider_exception", provider: "groq", detail: "GROQ_KEY missing in server env" });
      }
      usedProvider = "groq";
      const targetModel = GROQ_MODEL_DEFAULT;
      const messagesArr = [ systemMsg, { role:"user", content: message } ];
      providerResult = await callGroq(targetModel, messagesArr, { maxOutputTokens: 1400, temperature: 0.6 });
    }

    // parse provider response robustly
    let replyText = null;
    const p = providerResult && providerResult.parsed;

    // if parsed has json, extract
    if (p && (p.json || p.text)) {
      const j = p.json || p.text || {};
      // use extractor
      replyText = extractTextFromJson(j);
    }

    // if still empty but resp exists, try raw text
    if (!replyText && providerResult && providerResult.resp) {
      try {
        const raw = await providerResult.resp.text();
        if (raw && raw.length) {
          // try parse
          try { const rj = JSON.parse(raw); replyText = extractTextFromJson(rj) || raw; } catch(e){ replyText = raw; }
        }
      } catch(e){}
    }

    // If still nothing, return error and include parsed summary for debugging
    if (!replyText) {
      const detail = p && (p.json || p.text || p.error) ? (p.json || p.text || p.error) : "no body";
      db[convId].push({ role:"assistant", content: `Provider error: no content from ${usedProvider}`, created_at: new Date().toISOString(), meta:{ provider: usedProvider, detail }} );
      saveDB(db);
      // include parsed detail for debugging (client) but keep it short
      return res.status(502).json({ error:"provider_no_content", provider: usedProvider, detail: typeof detail === "string" ? detail : (JSON.stringify(detail).slice(0,200) + (JSON.stringify(detail).length>200? "...":"")) });
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
