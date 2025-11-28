// backend/server.js
// Multi-provider chat proxy — Groq (Llama) default + Gemini 2.5 Flash (Google).
// Designed to run on Render or similar (set env vars in Render dashboard).
// Restart with: node server.js

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
require("dotenv").config();
const fetch = require("node-fetch"); // if Node v18+ you can remove and use global fetch

const app = express();
app.use(cors());
app.use(express.json({ limit: "3mb" }));

const PORT = process.env.PORT || 3000;
const PROJECT_ROOT = __dirname;
const PUBLIC_DIR = path.join(PROJECT_ROOT, "..", "public");
const DB_PATH = path.join(PROJECT_ROOT, "history.json");

// Env keys
const GROQ_KEY = (process.env.GROQ_KEY || "").trim();
const GROQ_API_BASE = (process.env.GROQ_API_BASE || "https://api.groq.com/openai/v1").trim();
const GROQ_MODEL_DEFAULT = (process.env.GROQ_MODEL || "llama-3.1-8b-instant").trim();

const GEMINI_KEY = (process.env.GEMINI_KEY || "").trim();
// Use 2.5 flash as the single Gemini model for production
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

// small helpers
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
    timeout: 60000
  });
  const parsed = await safeParseResponse(resp);
  return { provider:"groq", resp, parsed };
}

// Gemini (Google Generative) — correct v1 endpoint (:generateContent)
async function callGemini(modelId, userMessage, opts={}) {
  if (!GEMINI_KEY) throw new Error("GEMINI_KEY_MISSING");
  // Use v1 :generateContent endpoint (works with modern Gemini models)
  const url = `https://generativelanguage.googleapis.com/v1/models/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(GEMINI_KEY)}`;

  const body = {
    // recommended shape: contents array with parts
    contents: [
      {
        role: "user",
        parts: [{ text: String(userMessage) }]
      }
    ],
    // generation config
    generationConfig: {
      maxOutputTokens: opts.maxOutputTokens || 512,
      temperature: typeof opts.temperature === "number" ? opts.temperature : 0.6
    }
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    timeout: 60000
  });
  const parsed = await safeParseResponse(resp);
  return { provider:"gemini", resp, parsed };
}

/* --- Main chat endpoint --- */
app.post("/api/chat", async (req, res) => {
  try {
    const message = (req.body.message || "").toString();
    const convId = req.body.conversation_id || "default";
    // model keys we accept from client
    const modelKey = (req.body.model || "").toString().trim() || "llama_3_1_8b_instant";

    if (!message) return res.status(400).json({ error: "message required" });

    // persist user message
    const db = loadDB();
    if (!db[convId]) db[convId] = [];
    db[convId].push({ role:"user", content: message, created_at: new Date().toISOString() });
    saveDB(db);

    // system prompt: enforce output script
    let systemMsg;
    if (containsDevanagari(message)) {
      systemMsg = { role: "system", content: "You are Indresh 2.0. Reply IN HINDI using Devanagari only. Do NOT repeat the user's question. Keep answers clear and concise." };
    } else {
      systemMsg = { role: "system", content: "You are Indresh 2.0. Reply in the same script as the user (Hinglish/English). Do NOT repeat the user's question." };
    }

    // Choose provider
    let providerResult = null;
    let usedProvider = null;

    // We'll prefer Gemini when client asks, otherwise default to GROQ Llama
    try {
      if (modelKey === "gemini_2_5") {
        usedProvider = "gemini";
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
    if (p && p.json) {
      const j = p.json;

      // --- GROQ / OpenAI-like shapes ---
      replyText =
        j?.choices?.[0]?.message?.content ||
        j?.choices?.[0]?.text ||
        j?.output?.text ||
        j?.candidates?.[0]?.content ||
        j?.generated_text || null;

      // --- Gemini v1 shape: candidates[].content.parts[].text
      if (!replyText && j?.candidates && Array.isArray(j.candidates) && j.candidates[0]) {
        // try typical Gemini shape
        const cand = j.candidates[0];
        if (cand.content && Array.isArray(cand.content.parts) && cand.content.parts[0] && cand.content.parts[0].text) {
          replyText = cand.content.parts.map(p => p.text).join("\n");
        } else if (cand.content && typeof cand.content === "string") {
          replyText = cand.content;
        }
      }

      // Another Gemini possible shape: output[0].content -> parts
      if (!replyText && j?.output && Array.isArray(j.output) && j.output[0] && j.output[0].content) {
        const seg = j.output[0].content;
        if (typeof seg === "string") replyText = seg;
        else if (Array.isArray(seg)) {
          const texts = seg.map(s => (s?.text || "")).filter(Boolean);
          if (texts.length) replyText = texts.join("\n");
        }
      }
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
      db[convId].push({ role:"assistant", content: `Provider error: no content from ${usedProvider}`, created_at: new Date().toISOString(), meta:{ provider: usedProvider, detail }} );
      saveDB(db);
      // If Gemini failed and we are not already on GROQ, try fallback to GROQ once
      if (usedProvider === "gemini" && GROQ_KEY) {
        try {
          const messagesArr = [ systemMsg, { role:"user", content: message } ];
          const fallback = await callGroq(GROQ_MODEL_DEFAULT, messagesArr, { maxOutputTokens: 900, temperature: 0.6 });
          // parse fallback quickly
          let fbText = null;
          if (fallback.parsed && fallback.parsed.json) {
            const jj = fallback.parsed.json;
            fbText = jj?.choices?.[0]?.message?.content || jj?.choices?.[0]?.text || jj?.output?.text || (typeof jj === "string" ? jj : null);
          } else if (fallback.parsed && fallback.parsed.text) fbText = fallback.parsed.text;
          if (fbText) {
            fbText = sanitizeReply(String(fbText));
            db[convId].push({ role:"assistant", content: fbText, created_at: new Date().toISOString(), meta:{ via:"groq_fallback" }});
            saveDB(db);
            return res.json({ output: { role:"assistant", content: fbText, via: "groq_fallback" } });
          }
        } catch(e) {
          console.warn("fallback to groq failed:", e);
        }
      }
      return res.status(502).json({ error:"provider_no_content", provider: usedProvider, detail: detail || "no body" });
    }

    // sanitize + replace banned names
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
  console.log("GROQ_KEY:", GROQ_KEY ? "SET" : "MISSING");
  console.log("GROQ_API_BASE:", GROQ_API_BASE);
  console.log("GROQ_MODEL_DEFAULT:", GROQ_MODEL_DEFAULT);
  console.log("GEMINI_KEY:", GEMINI_KEY ? "SET" : "MISSING");
  console.log("GEMINI_MODEL:", GEMINI_MODEL_ID);
});

process.on("SIGINT", () => { console.log("Shutting down..."); server.close(()=>process.exit(0)); });
