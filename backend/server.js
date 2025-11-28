// backend/server.js
// OPTIMIZED VERSION: Prioritizes Speed (Flash) & Better Tone

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

// --- 1. SMART MODEL FINDER (SPEED PRIORITY) ---
async function findValidGeminiModel() {
  if (!GEMINI_KEY) return null;
  try {
    console.log("🔍 Checking Google Models...");
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_KEY}`;
    const resp = await fetch(url);
    const data = await resp.json();

    if (data.models) {
      // Priority 1: Flash Models (Fastest)
      let bestModel = data.models.find(m => m.name.includes("flash") && m.supportedGenerationMethods.includes("generateContent"));
      
      // Priority 2: Pro Models (Smarter but Slower)
      if (!bestModel) {
          bestModel = data.models.find(m => m.name.includes("pro") && !m.name.includes("vision") && m.supportedGenerationMethods.includes("generateContent"));
      }
      
      // Priority 3: Any Gemini
      if (!bestModel) {
          bestModel = data.models.find(m => m.name.includes("gemini") && m.supportedGenerationMethods.includes("generateContent"));
      }

      if (bestModel) {
        ACTIVE_GEMINI_MODEL = bestModel.name.replace("models/", "");
        console.log(`✅ SELECTED FASTEST MODEL: [ ${ACTIVE_GEMINI_MODEL} ] 🚀`);
        return ACTIVE_GEMINI_MODEL;
      }
    }
  } catch (e) { console.error("Model check failed:", e.message); }
  
  ACTIVE_GEMINI_MODEL = "gemini-1.5-flash"; // Default backup
  return ACTIVE_GEMINI_MODEL;
}

findValidGeminiModel();
const genAI = GEMINI_KEY ? new GoogleGenerativeAI(GEMINI_KEY) : null;

// --- SYSTEM PROMPT (FRIENDLY TONE) ---
const SYSTEM_INSTRUCTION = `
You are Indresh 2.0, a smart and friendly AI assistant.
1. Format your answers beautifully using Markdown (Bold headings, bullet points).
2. Use a conversational, helpful tone (Hinglish/Hindi allowed).
3. Do NOT give walls of text. Use spacing.
4. If asked to write a letter, format it properly.
`;

app.post("/api/chat", async (req, res) => {
  try {
    const message = req.body.message || "";
    if (!ACTIVE_GEMINI_MODEL) await findValidGeminiModel();

    let replyText = "";

    // GEMINI LOGIC
    if (genAI) {
      const model = genAI.getGenerativeModel({ 
          model: ACTIVE_GEMINI_MODEL,
          systemInstruction: SYSTEM_INSTRUCTION // Add Personality here
      });
      
      const result = await model.generateContent(message);
      const response = await result.response;
      replyText = response.text();
    } else {
      replyText = "Gemini Key Missing.";
    }

    return res.json({ output: { role: "assistant", content: replyText } });

  } catch (error) {
    return res.json({ output: { role: "assistant", content: `❌ Error: ${error.message}` } });
  }
});

if (require("fs").existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR));
  app.get("/", (req,res) => res.sendFile(path.join(PUBLIC_DIR,"index.html")));
}

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
