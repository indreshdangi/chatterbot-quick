// backend/server.js
// PRIORITY: POWER & INTELLIGENCE (PRO MODEL FIRST)

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

const GEMINI_KEY = (process.env.GEMINI_KEY || "").trim();
const GROQ_KEY = (process.env.GROQ_KEY || "").trim();

let ACTIVE_GEMINI_MODEL = null;

// --- 1. INTELLIGENT MODEL FINDER ---
async function findValidGeminiModel() {
  if (!GEMINI_KEY) return null;
  try {
    console.log("🔍 Checking Google Models for INTELLIGENCE...");
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_KEY}`;
    const resp = await fetch(url);
    const data = await resp.json();

    if (data.models) {
      // Priority 1: PRO Models (सबसे समझदार और पावरफुल)
      // हम 1.5 Pro को पहले ढूंढेंगे क्योंकि वो स्टेबल और बेस्ट है
      let bestModel = data.models.find(m => m.name.includes("1.5-pro") && !m.name.includes("vision"));
      
      // Priority 2: 2.5 Preview (अगर Pro नहीं मिला तो लेटेस्ट प्रीव्यू)
      if (!bestModel) {
          bestModel = data.models.find(m => m.name.includes("preview") && m.name.includes("pro"));
      }

      // Priority 3: Fallback to Flash (अगर कुछ नहीं मिला)
      if (!bestModel) {
          bestModel = data.models.find(m => m.name.includes("flash"));
      }

      if (bestModel) {
        ACTIVE_GEMINI_MODEL = bestModel.name.replace("models/", "");
        console.log(`✅ SELECTED POWERFUL MODEL: [ ${ACTIVE_GEMINI_MODEL} ] 🧠`);
        return ACTIVE_GEMINI_MODEL;
      }
    }
  } catch (e) { console.error("Model check failed:", e.message); }
  
  // Default Fallback
  ACTIVE_GEMINI_MODEL = "gemini-1.5-pro"; 
  return ACTIVE_GEMINI_MODEL;
}

findValidGeminiModel();
const genAI = GEMINI_KEY ? new GoogleGenerativeAI(GEMINI_KEY) : null;

// --- SYSTEM PROMPT (INDRESH 2.0 PERSONALITY) ---
const SYSTEM_INSTRUCTION = `
You are Indresh 2.0, an advanced and intelligent AI assistant. 
Your Goal: Provide detailed, accurate, and high-quality responses.
Language: Use a natural mix of Hindi and English (Hinglish). Talk like a smart, friendly expert.
Formatting: 
- ALWAYS use Markdown. 
- Use **Bold** for headings and key points. 
- Use lists (bullet points) for steps.
- Do NOT produce dense walls of text. Break paragraphs.
`;

app.post("/api/chat", async (req, res) => {
  try {
    const message = req.body.message || "";
    if (!ACTIVE_GEMINI_MODEL) await findValidGeminiModel();

    let replyText = "";
    let via = "";

    // GEMINI LOGIC
    if (genAI) {
      const model = genAI.getGenerativeModel({ 
          model: ACTIVE_GEMINI_MODEL,
          systemInstruction: SYSTEM_INSTRUCTION 
      });
      
      const result = await model.generateContent(message);
      const response = await result.response;
      replyText = response.text();
      via = `Gemini (${ACTIVE_GEMINI_MODEL})`;
    } else {
      replyText = "Gemini Key Missing.";
    }

    return res.json({ output: { role: "assistant", content: replyText, via: via } });

  } catch (error) {
    return res.json({ output: { role: "assistant", content: `❌ Error: ${error.message}` } });
  }
});

if (require("fs").existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR));
  app.get("/", (req,res) => res.sendFile(path.join(PUBLIC_DIR,"index.html")));
}

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
