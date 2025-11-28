// backend/server.js
// FIXED VERSION for Indresh
// Fixes: 1. Uses correct Gemini 1.5 JSON structure. 2. Uses valid Model names.

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
require("dotenv").config();
const fetch = require("node-fetch");

const app = express();
app.use(cors());
app.use(express.json({ limit: "4mb" }));

const PORT = process.env.PORT || 3000;
const PROJECT_ROOT = __dirname;
const PUBLIC_DIR = path.join(PROJECT_ROOT, "..", "public");
const DB_PATH = path.join(PROJECT_ROOT, "history.json");

// --- CONFIGURATION ---
const GROQ_KEY = (process.env.GROQ_KEY || "").trim();
const GROQ_API_BASE = (process.env.GROQ_API_BASE || "https://api.groq.com/openai/v1").trim();
const GROQ_MODEL_DEFAULT = (process.env.GROQ_MODEL || "llama-3.1-8b-instant").trim();

const GEMINI_KEY = (process.env.GEMINI_KEY || "").trim();
// FIX: Default model changed to 1.5-flash because 2.5 DOES NOT EXIST
const GEMINI_MODEL = (process.env.GEMINI_MODEL || "gemini-1.5-flash").trim(); 

// Helpers: DB
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
function sanitizeReply(text){ if(!text) return ""; if(typeof text !== "string") text = String(text); return text.replace(/\s+/g, " ").trim(); }

/* --- GROQ (OpenAI-like) --- */
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
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${GROQ_KEY}` },
    body: JSON.stringify(body)
  });
  const json = await resp.json();
  return { provider:"groq", resp, parsed: { ok: resp.ok, json: json, status: resp.status } };
}

/* --- GEMINI (Generative Language) - FIXED FUNCTION --- */
async function callGemini(modelId, userMessage, opts={}) {
  if (!GEMINI_KEY) throw new Error("GEMINI_KEY_MISSING");

  // FIX: Ensure we don't use non-existent 2.5 models from env vars
  if(modelId.includes("2.5") || modelId.includes("2.0")) {
      console.log("Auto-correcting invalid model name to gemini-1.5-flash");
      modelId = "gemini-1.5-flash";
  }

  // Gemini requires "v1beta" generally. 
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${GEMINI_KEY}`;

  // FIX: Gemini 1.5 Payload Structure (Must use 'contents', not 'prompt')
  const bodyPayload = {
    contents: [{
      parts: [{ text: String(userMessage) }]
    }],
    generationConfig: {
        maxOutputTokens: opts.maxOutputTokens || 512,
        temperature: typeof opts.temperature === "number" ? opts.temperature : 0.6
    }
  };

  console.log(`[callGemini] Hitting: ${url}`); // Debug Log

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(bodyPayload)
  });

  const json = await resp.json();
  
  // Debug Log to see what Google replies
  if(!resp.ok) {
      console.error("[Gemini Error]", JSON.stringify(json));
  }

  return { provider: "gemini", resp, parsed: { ok: resp.ok, json: json, status: resp.status }, urlUsed: url };
}

/* --- Main chat endpoint --- */
app.post("/api/chat", async (req, res) => {
  try {
    const message = (req.body.message || "").toString();
    const convId = req.body.conversation_id || "default";
    let modelKey = (req.body.model || "").toString().trim();

    if (!message) return res.status(400).json({ error: "message required" });

    // DB Load
    const db = loadDB();
    if (!db[convId]) db[convId] = [];
    db[convId].push({ role:"user", content: message, created_at: new Date().toISOString() });
    saveDB(db);

    // System Prompt
    let systemMsg;
    if (containsDevanagari(message)) {
      systemMsg = { role: "system", content: "You are Indresh 2.0. Reply IN HINDI using Devanagari only." };
    } else {
      systemMsg = { role: "system", content: "You are Indresh 2.0. Reply in the same script/language." };
    }

    let replyText = null;
    let usedProvider = null;

    try {
      // Logic to select provider
      if (modelKey.toLowerCase().includes("gemini")) {
        usedProvider = "gemini";
        // Use Env model if set, otherwise fallback to 1.5-flash
        const targetModel = GEMINI_MODEL || "gemini-1.5-flash"; 
        
        const result = await callGemini(targetModel, message, { maxOutputTokens: 900 });
        
        // Gemini Response Parsing (Fixed)
        if (result.parsed.json && result.parsed.json.candidates && result.parsed.json.candidates.length > 0) {
            const candidate = result.parsed.json.candidates[0];
            if (candidate.content && candidate.content.parts && candidate.content.parts.length > 0) {
                replyText = candidate.content.parts[0].text;
            }
        } else {
            // Handle Error from Google
            throw new Error(JSON.stringify(result.parsed.json || "Unknown Gemini Error"));
        }

      } else {
        // GROQ
        usedProvider = "groq";
        const messagesArr = [ systemMsg, { role:"user", content: message } ];
        const result = await callGroq(GROQ_MODEL_DEFAULT, messagesArr, { maxOutputTokens: 1400 });
        
        // Groq Parsing
        const j = result.parsed.json;
        replyText = j?.choices?.[0]?.message?.content || j?.error?.message;
      }

    } catch (provErr) {
      console.error("Provider Error:", provErr);
      return res.status(502).json({ error: "provider_error", detail: provErr.message });
    }

    if (!replyText) replyText = "Sorry, no response generated.";

    // Save and Send
    replyText = sanitizeReply(String(replyText).replace(/OpenAI|ChatGPT/gi, "Indresh 2.0"));
    db[convId].push({ role:"assistant", content: replyText, created_at: new Date().toISOString() });
    saveDB(db);

    return res.json({ output: { role:"assistant", content: replyText, via: usedProvider } });

  } catch (err) {
    console.error("Server Error:", err);
    return res.status(500).json({ error:"server_error", details: err.message });
  }
});

/* Static & Other Routes */
app.get("/api/history/:id", (req,res) => { const db = loadDB(); res.json({ messages: db[req.params.id] || [] }); });
app.post("/api/clear/:id", (req,res) => { const db = loadDB(); db[req.params.id] = []; saveDB(db); res.json({ ok:true }); });

if (fs.existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR));
  app.get("/", (req,res) => res.sendFile(path.join(PUBLIC_DIR,"index.html")));
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Gemini Config: ${GEMINI_MODEL} (Key Len: ${GEMINI_KEY.length})`);
});
