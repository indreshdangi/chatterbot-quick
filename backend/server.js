// backend/server.js
// FIXED VERSION 2.0
// Updates: Uses "gemini-1.5-flash-001" (pinned version) to fix 404 on Paid Accounts.

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
// FIX: Using specific version number '001' which is more stable for paid accounts
const GEMINI_MODEL = "gemini-1.5-flash-001"; 

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

/* --- GROQ --- */
async function callGroq(modelId, messagesOrString, opts={}) {
  if (!GROQ_KEY) throw new Error("GROQ_KEY_MISSING");
  const url = `${GROQ_API_BASE}/chat/completions`;
  const body = {
    model: modelId,
    messages: Array.isArray(messagesOrString) ? messagesOrString : [{ role: "user", content: String(messagesOrString) }],
    max_tokens: opts.maxOutputTokens || 1024,
    temperature: 0.6
  };
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${GROQ_KEY}` },
    body: JSON.stringify(body)
  });
  const json = await resp.json();
  return { provider:"groq", resp, parsed: { ok: resp.ok, json: json, status: resp.status } };
}

/* --- GEMINI (FIXED FOR PAID ACCOUNTS) --- */
async function callGemini(userMessage, opts={}) {
  if (!GEMINI_KEY) throw new Error("GEMINI_KEY_MISSING");

  // We try specific version '001' first. If that fails, we fallback to 'latest'.
  const modelsToTry = ["gemini-1.5-flash-001", "gemini-1.5-flash", "gemini-1.5-pro-latest"];
  
  let lastError = null;

  for (const modelId of modelsToTry) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${GEMINI_KEY}`;
        
        const bodyPayload = {
            contents: [{ parts: [{ text: String(userMessage) }] }],
            generationConfig: { maxOutputTokens: opts.maxOutputTokens || 512, temperature: 0.6 }
        };

        console.log(`[callGemini] Trying model: ${modelId}`); 

        const resp = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(bodyPayload)
        });

        const json = await resp.json();

        // If successful
        if (resp.ok && json.candidates && json.candidates.length > 0) {
            return { provider: "gemini", parsed: { ok: true, json: json }, modelUsed: modelId };
        }

        // If error, log and try next model
        console.warn(`[callGemini] Failed with ${modelId}:`, JSON.stringify(json));
        lastError = json;

      } catch (e) {
          console.error(`[callGemini] Network error with ${modelId}:`, e);
          lastError = e;
      }
  }

  // If all failed
  throw new Error(JSON.stringify(lastError || "All Gemini models failed"));
}

/* --- Main chat endpoint --- */
app.post("/api/chat", async (req, res) => {
  try {
    const message = (req.body.message || "").toString();
    const convId = req.body.conversation_id || "default";
    let modelKey = (req.body.model || "").toString().toLowerCase();

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
      if (modelKey.includes("gemini")) {
        usedProvider = "gemini";
        // Call new robust Gemini function
        const result = await callGemini(message, { maxOutputTokens: 900 });
        
        if (result.parsed.json.candidates[0].content.parts[0].text) {
            replyText = result.parsed.json.candidates[0].content.parts[0].text;
        } else {
            throw new Error("Empty content from Gemini");
        }

      } else {
        // GROQ
        usedProvider = "groq";
        const messagesArr = [ systemMsg, { role:"user", content: message } ];
        const result = await callGroq(GROQ_MODEL_DEFAULT, messagesArr, { maxOutputTokens: 1400 });
        const j = result.parsed.json;
        replyText = j?.choices?.[0]?.message?.content || j?.error?.message;
      }

    } catch (provErr) {
      console.error("Provider Error:", provErr);
      // Fallback to Groq if Gemini fails completely
      if (usedProvider === "gemini") {
          console.log("Gemini failed, falling back to Llama 3...");
          try {
             const fallback = await callGroq(GROQ_MODEL_DEFAULT, [systemMsg, { role:"user", content: message }]);
             replyText = fallback.parsed.json?.choices?.[0]?.message?.content;
             usedProvider = "groq (fallback)";
          } catch(e) { /* ignore */ }
      }
      
      if(!replyText) return res.status(502).json({ error: "provider_error", detail: provErr.message });
    }

    if (!replyText) replyText = "Sorry, no response generated.";

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
});
