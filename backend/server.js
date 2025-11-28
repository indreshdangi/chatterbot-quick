// backend/server.js
// AUTO-DETECT MODEL VERSION
// यह कोड Google से पूछेगा कि कौन सा मॉडल Available है और उसे ही Use करेगा।

const express = require("express");
const cors = require("cors");
const path = require("path");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const fetch = require("node-fetch");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "4mb" }));

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const DB_PATH = path.join(__dirname, "history.json");

// --- CONFIGURATION ---
// अपनी API Key ENV से लें (Render Environment Variable)
const GEMINI_KEY = (process.env.GEMINI_KEY || "").trim();
const GROQ_KEY = (process.env.GROQ_KEY || "").trim();

// Global Variable to store the working model name
let ACTIVE_GEMINI_MODEL = null;

// --- 1. MAGIC FUNCTION: FIND VALID MODEL ---
async function findValidGeminiModel() {
  if (!GEMINI_KEY) {
    console.log("❌ GEMINI_KEY missing in Environment Variables.");
    return null;
  }

  try {
    console.log("🔍 Asking Google for available models...");
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_KEY}`;
    const resp = await fetch(url);
    const data = await resp.json();

    if (data.models) {
      // ऐसा मॉडल ढूंढो जो 'generateContent' को support करता हो
      // और जिसमें 'gemini' लिखा हो
      const validModel = data.models.find(m => 
        m.name.includes("gemini") && 
        m.supportedGenerationMethods.includes("generateContent") &&
        !m.name.includes("vision") // text only preferred first
      );

      if (validModel) {
        // "models/gemini-pro" -> "gemini-pro"
        ACTIVE_GEMINI_MODEL = validModel.name.replace("models/", "");
        console.log(`✅ SUCCESS: Auto-detected working model: [ ${ACTIVE_GEMINI_MODEL} ]`);
        return ACTIVE_GEMINI_MODEL;
      }
    }
    
    console.warn("⚠️ No suitable Gemini model found in list. Response:", JSON.stringify(data));
  } catch (e) {
    console.error("❌ Failed to list models:", e.message);
  }
  
  // Fallback if auto-detect fails
  console.log("⚠️ Fallback to 'gemini-pro'");
  ACTIVE_GEMINI_MODEL = "gemini-pro";
  return ACTIVE_GEMINI_MODEL;
}

// Server start होते ही सही मॉडल ढूंढो
findValidGeminiModel();

// --- 2. SETUP SDK ---
const genAI = GEMINI_KEY ? new GoogleGenerativeAI(GEMINI_KEY) : null;

/* --- CHAT ENDPOINT --- */
app.post("/api/chat", async (req, res) => {
  try {
    const message = (req.body.message || "").toString();
    const modelKey = (req.body.model || "").toString();
    
    // अगर Auto-detect अभी पूरा नहीं हुआ है, तो फिर से try करो
    if (!ACTIVE_GEMINI_MODEL) await findValidGeminiModel();

    let replyText = "";
    let usedProvider = "";

    // --- GEMINI LOGIC ---
    if (modelKey.includes("gemini")) {
      usedProvider = `gemini (${ACTIVE_GEMINI_MODEL})`;
      
      if (!genAI) throw new Error("GEMINI_KEY is missing on server.");
      
      console.log(`🤖 Generatig with: ${ACTIVE_GEMINI_MODEL}`);
      
      const model = genAI.getGenerativeModel({ model: ACTIVE_GEMINI_MODEL });
      const result = await model.generateContent(message);
      const response = await result.response;
      replyText = response.text();
    
    } 
    // --- GROQ LOGIC (Backup) ---
    else {
      usedProvider = "groq";
      const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${GROQ_KEY}` },
        body: JSON.stringify({
           model: "llama-3.1-8b-instant",
           messages: [{ role: "user", content: message }]
        })
      });
      const json = await resp.json();
      replyText = json.choices?.[0]?.message?.content || "Error from Groq";
    }

    return res.json({ output: { role: "assistant", content: replyText, via: usedProvider } });

  } catch (error) {
    console.error("SERVER ERROR:", error);
    // Error Details User ko dikhao taaki pata chale
    return res.json({ 
      output: { 
        role: "assistant", 
        content: `❌ Error: ${error.message}\n(Model tried: ${ACTIVE_GEMINI_MODEL})`, 
        via: "error" 
      } 
    });
  }
});

// Serve Frontend
const fs = require("fs");
if (fs.existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR));
  app.get("/", (req,res) => res.sendFile(path.join(PUBLIC_DIR,"index.html")));
}

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
