// backend/server.js
// FINAL VERSION — 3 Models: Llama-3.1-8B (default), Llama-3.3-70B, Gemini Flash Lite

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
require("dotenv").config();
const fetch = require("node-fetch");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const DB_PATH = path.join(__dirname, "history.json");

// ENV keys
const GROQ_KEY = (process.env.GROQ_KEY || "").trim();
const GEMINI_KEY = (process.env.GEMINI_KEY || "").trim();

const MODEL_LLAMA_8B = "llama-3.1-8b-instant";
const MODEL_LLAMA_70B = "llama-3.3-70b-versatile";
const MODEL_GEMINI_LITE = "gemini-2.5-flash-lite";

// Ensure history file exists
if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, "{}", "utf8");

function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_PATH, "utf8")); }
  catch { return {}; }
}

function saveDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf8");
}

// detect Hindi (Devanagari)
function isHindi(text) {
  return /[\u0900-\u097F]/.test(text);
}

// ------------------ PROVIDER CALLS ------------------

// GROQ Models (for both Llama 8B and 70B)
async function callGroq(model, messages) {
  const url = "https://api.groq.com/openai/v1/chat/completions";

  const body = {
    model,
    messages,
    max_tokens: 1500,
    temperature: 0.6
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${GROQ_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const data = await res.json().catch(() => null);
  return data?.choices?.[0]?.message?.content || null;
}

// Gemini Flash Lite
async function callGemini(text) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_GEMINI_LITE}:generateContent?key=${GEMINI_KEY}`;

  const body = {
    contents: [{ parts: [{ text }] }],
    generationConfig: { maxOutputTokens: 1200, temperature: 0.5 }
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const data = await res.json().catch(() => null);
  return (
    data?.candidates?.[0]?.content?.parts?.[0]?.text ||
    data?.text ||
    null
  );
}

// ------------------ MAIN CHAT ------------------

app.post("/api/chat", async (req, res) => {
  const message = (req.body.message || "").toString();
  const modelKey = req.body.model || "llama_3_1_8b";
  const convId = req.body.conversation_id || "default";

  if (!message) return res.json({ error: "Message required." });

  const db = loadDB();
  if (!db[convId]) db[convId] = [];
  db[convId].push({ role: "user", content: message, created_at: new Date().toISOString() });
  saveDB(db);

  const hindi = isHindi(message);

  const systemInstructionHindi =
    "आप एक सहायक AI हैं। प्रश्न दोहराए बिना, साफ़ और सीधे हिंदी में उत्तर दें। मज़ाक, कविता, लंबा लेख सब ठीक से लिखें।";

  const systemInstructionEnglish =
    "You are a helpful AI assistant. Do not repeat the question. Respond directly in clean English.";

  const systemMsg = {
    role: "system",
    content: hindi ? systemInstructionHindi : systemInstructionEnglish
  };

  // final message array
  const messages = [
    systemMsg,
    { role: "user", content: message }
  ];

  let reply = "";

  try {
    // ------------------- MODEL ROUTING -------------------

    if (modelKey === "llama_3_1_8b") {
      reply = await callGroq(MODEL_LLAMA_8B, messages);
    }

    else if (modelKey === "llama_3_3_70b") {
      reply = await callGroq(MODEL_LLAMA_70B, messages);
    }

    else if (modelKey === "gemini_flash_lite") {
      reply = await callGemini(message);
    }

    else {
      reply = "Unknown model.";
    }

  } catch (e) {
    reply = "Provider error: " + e.message;
  }

  if (!reply) reply = "No response from model.";

  db[convId].push({ role: "assistant", content: reply, created_at: new Date().toISOString() });
  saveDB(db);

  res.json({ output: { role: "assistant", content: reply } });
});

// HISTORY
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

// FRONTEND
if (fs.existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR));
  app.get("/", (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, "index.html"));
  });
} else {
  app.get("/", (req, res) => res.send("public folder not found"));
}

// START
app.listen(PORT, () => {
  console.log("Server running on http://127.0.0.1:" + PORT);
  console.log("Models loaded: Llama 8B / Llama 70B / Gemini Flash Lite");
});
