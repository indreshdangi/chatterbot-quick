// backend/server.js
// ULTIMATE BALANCE: Uses 'Gemini 2.0 Flash Experimental'
// (Pro Intelligence + Flash Speed)

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

let ACTIVE_GEMINI_MODEL = null;

// --- 1. THE "BEST OF BOTH WORLDS" FINDER ---
async function findValidGeminiModel() {
  if (!GEMINI_KEY) return null;
  try {
    console.log("🔍 Looking for Gemini 2.0 Flash (Experimental)...");
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_KEY}`;
    const resp = await fetch(url);
    const data = await resp.json();

    if (data.models) {
      // PRIORITY 1: GEMINI 2.0 FLASH EXPERIMENTAL (Fast + Smartest)
      let bestModel = data.models.find(m => m.name.includes("2.0-flash-exp"));
      
      // PRIORITY 2: GEMINI 1.5 PRO (Smart Backup)
      if (!bestModel) {
          console.log("⚠️ 2.0 Flash not found, looking for 1.5 Pro...");
          bestModel = data.models.find(m => m.name.includes("1.5-pro") && !m.name.includes("vision"));
      }

      // PRIORITY 3: GEMINI 1.5 FLASH (Speed Backup)
      if (!bestModel) {
          bestModel = data.models.find(m => m.name.includes("1.5-flash"));
      }

      if (bestModel) {
        ACTIVE_GEMINI_MODEL = bestModel.name.replace("models/", "");
        console.log(`✅ LOCKED MODEL: [ ${ACTIVE_GEMINI_MODEL} ] 🔥`);
        return ACTIVE_GEMINI_MODEL;
      }
    }
  } catch (e) { console.error("Model check failed:", e.message); }
  
  // Hard fallback agar list fail ho jaye
  ACTIVE_GEMINI_MODEL = "gemini-2.0-flash-exp"; 
  return ACTIVE_GEMINI_MODEL;
}

findValidGeminiModel();
const genAI = GEMINI_KEY ? new GoogleGenerativeAI(GEMINI_KEY) : null;

// --- SYSTEM PROMPT ---
const SYSTEM_INSTRUCTION = `
You are Indresh 2.0, a highly advanced AI assistant powered by Gemini 2.0.
1. SPEED: Be concise but detailed.
2. FORMAT: Use Markdown (Bold headings, bullet points) beautifully.
3. TONE: Intelligent, Professional yet Friendly (Hinglish supported).
4. ACCURACY: Provide the latest and most logical information.
`;

app.post("/api/chat", async (req, res) => {
  try {
    const message = req.body.message || "";
    if (!ACTIVE_GEMINI_MODEL) await findValidGeminiModel();

    let replyText = "";
    let via = "";

    // GEMINI LOGIC
    if (genAI) {
      // Ensure we use the correct model string
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
    // Agar 2.0 Model fail ho jaye (kyunki experimental hai), to Pro par fallback karo
    if(error.message.includes("404") || error.message.includes("not found")) {
        console.log("⚠️ 2.0 Failed, retrying with 1.5 Pro...");
        try {
            const fallbackModel = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });
            const result = await fallbackModel.generateContent(message);
            return res.json({ output: { role: "assistant", content: result.response.text(), via: "Gemini (Fallback 1.5 Pro)" } });
        } catch(e) {
            return res.json({ output: { role: "assistant", content: `Error: ${e.message}` } });
        }
    }
    return res.json({ output: { role: "assistant", content: `❌ Error: ${error.message}` } });
  }
});

if (require("fs").existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR));
  app.get("/", (req,res) => res.sendFile(path.join(PUBLIC_DIR,"index.html")));
}

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
