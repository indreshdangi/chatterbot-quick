// backend/server.js
// Minimal, production-friendly: 2 models only — Llama-3.1-8B (GROQ) and Gemini-2.0-Flash

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
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const DB_PATH = path.join(__dirname, "history.json");

// ENV keys (must be set in Render)
const GROQ_KEY = (process.env.GROQ_KEY || "").trim();
const GROQ_API_BASE = (process.env.GROQ_API_BASE || "https://api.groq.com/openai/v1").trim();
const GEMINI_KEY = (process.env.GEMINI_KEY || "").trim();
const GEMINI_MODEL = (process.env.GEMINI_MODEL || "gemini-2.0-flash").trim();
const SERVER_API_KEY = (process.env.SERVER_API_KEY || "").trim();

// Models (canonical)
const MODEL_LLAMA_8B = "llama-3.1-8b-instant";
const MODEL_GEMINI = GEMINI_MODEL;

// ensure history file
if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, "{}", "utf8");

function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_PATH, "utf8")); }
  catch (e) { return {}; }
}
function saveDB(db) {
  try { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf8"); } catch(e){}
}

function isHindi(text) {
  return /[\u0900-\u097F]/.test(text);
}

// ------------------ PROVIDER CALLS ------------------

// GROQ (Llama 3.1)
async function callGroq(model, messages) {
  if (!GROQ_KEY) throw new Error("Missing GROQ_KEY");
  const url = `${GROQ_API_BASE}/chat/completions`;
  const body = { model, messages, max_tokens: 1500, temperature: 0.6 };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${GROQ_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body),
    // timeout not built-in in fetch here; provider / platform should handle
  });

  if (!res.ok) {
    const text = await res.text().catch(()=>null);
    throw new Error(`GROQ error ${res.status}: ${text || res.statusText}`);
  }

  const data = await res.json().catch(()=>null);
  return data?.choices?.[0]?.message?.content || null;
}

// Gemini 2.0 Flash (Google Generative Language)
async function callGemini(text) {
  if (!GEMINI_KEY) throw new Error("Missing GEMINI_KEY");
  const modelName = MODEL_GEMINI;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${GEMINI_KEY}`;

  const body = {
    contents: [{ parts: [{ text }] }],
    generationConfig: { maxOutputTokens: 1200, temperature: 0.5 }
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const textBody = await res.text().catch(()=>null);
  if (!res.ok) {
    // throw error with provider response for logs
    throw new Error(`Gemini error ${res.status}: ${textBody || res.statusText}`);
  }

  // try to parse json and extract common shapes
  let data;
  try { data = JSON.parse(textBody); } catch(e){ data = null; }
  if (!data) return textBody || null;

  // typical shapes
  return data?.candidates?.[0]?.content?.parts?.[0]?.text
      || data?.candidates?.[0]?.text
      || data?.text
      || null;
}

// ------------------ MAIN CHAT ------------------

app.post("/api/chat", async (req, res) => {
  try {
    const incomingKey = (req.headers["x-api-key"] || "").toString();
    // quick server API key check (if configured)
    if (SERVER_API_KEY && incomingKey !== SERVER_API_KEY) {
      return res.status(401).json({ error: "Invalid server API key" });
    }

    const message = (req.body.message || "").toString();
    // support both fields from different frontends
    const modelKey = (req.body.model || req.body.modelKey || "llama_3_1_8b").toString();
    const convId = req.body.conversation_id || "default";

    if (!message) return res.status(400).json({ error: "Message required." });

    const db = loadDB();
    if (!db[convId]) db[convId] = [];
    db[convId].push({ role: "user", content: message, created_at: new Date().toISOString() });
    saveDB(db);

    const hindi = isHindi(message);
    const systemInstructionHindi = "आप एक सहायक AI हैं। सीधे और आसान हिंदी में उत्तर दें।";
    const systemInstructionEnglish = "You are a helpful AI assistant. Answer directly in clear English.";

    const systemMsg = { role: "system", content: hindi ? systemInstructionHindi : systemInstructionEnglish };
    const messages = [ systemMsg, { role: "user", content: message } ];

    let reply = "";

    // route to providers
    if (modelKey === "llama_3_1_8b" || modelKey === "llama-3.1-8b" || modelKey === "llama_3_1") {
      // GROQ call
      reply = await callGroq(MODEL_LLAMA_8B, messages);
    } else if (modelKey === "gemini_flash" || modelKey === "gemini_flash_lite" || modelKey === "gemini-2.0-flash") {
      // Gemini call (all aliases accepted)
      reply = await callGemini(message);
    } else {
      // fallback to Llama 3.1
      reply = await callGroq(MODEL_LLAMA_8B, messages);
    }

    if (!reply) reply = "No response from model.";

    db[convId].push({ role: "assistant", content: reply, created_at: new Date().toISOString() });
    saveDB(db);

    return res.json({ output: { role: "assistant", content: reply } });
  } catch (err) {
    // log for render
    console.error("Chat handler error:", err && err.message ? err.message : err);
    return res.status(500).json({ error: "Server error", detail: (err && err.message) ? err.message : String(err) });
  }
});

// HISTORY endpoints
app.get("/api/history/:id", (req, res) => {
  const db = loadDB();
  res.json({ messages: db[req.params.id] || [] });
});
app.post("/api/clear/:id", (req, res) => {
  const db = loadDB();
  db[req.params.id] = [];
  saveDB(db);
  res.json({ ok: true });
});

// Serve frontend
if (fs.existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR));
  app.get("/", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));
} else {
  app.get("/", (req, res) => res.send("public folder not found"));
}

// Start
app.listen(PORT, () => {
  console.log(`Server running on http://127.0.0.1:${PORT}`);
  console.log("Models loaded: Llama-3.1-8B (GROQ), Gemini (", MODEL_GEMINI, ")");
});
