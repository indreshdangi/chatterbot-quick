// backend/server.js
// MEMORY LOCKED VERSION: Checks once, remembers forever.
// Priority: 2.0 Flash (Speed) -> 2.5 Pro (Power) -> 1.5 Pro (Backup)

const express = require("express");
const cors = require("cors");
const path = require("path");
const { GoogleGenerativeAI } = require("@google/generative-ai");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "..", "public");

const GEMINI_KEY = (process.env.GEMINI_KEY || "").trim();
const genAI = GEMINI_KEY ? new GoogleGenerativeAI(GEMINI_KEY) : null;

// --- GLOBAL VARIABLE (YADDAASH) ---
// Ek bar model mil gaya to yahan save ho jayega.
let LOCKED_MODEL_NAME = null;

// Is list me se jo sabse pehle chalega, wo final ho jayega.
const MODELS_TO_TRY = [
    "gemini-2.0-flash-exp",          // 1. Super Fast + Smart (Newest)
    "gemini-2.5-pro-preview-03-25",  // 2. Your Current Best (Heavy Power)
    "gemini-1.5-pro",                // 3. Stable Backup
    "gemini-1.5-flash"               // 4. Emergency Speed
];

const SYSTEM_INSTRUCTION = `
You are Indresh 2.0, an advanced AI assistant.
1. FORMAT: Use Markdown (Bold, Lists) clearly.
2. TONE: Professional, Helpful, and Friendly (Hindi/Hinglish).
3. GOAL: Provide accurate and detailed information quickly.
`;

app.post("/api/chat", async (req, res) => {
  const message = req.body.message || "";
  
  if (!genAI) return res.json({ output: { role: "assistant", content: "❌ Error: API Key Missing" } });

  // ⚡ STEP 1: Agar model pehle se yaad hai, to direct use karo (No Checking)
  if (LOCKED_MODEL_NAME) {
      try {
          // console.log(`🚀 Using Cached Model: ${LOCKED_MODEL_NAME}`); // Logs kam karne ke liye comment kar sakte hain
          const model = genAI.getGenerativeModel({ model: LOCKED_MODEL_NAME, systemInstruction: SYSTEM_INSTRUCTION });
          const result = await model.generateContent(message);
          return res.json({ output: { role: "assistant", content: result.response.text(), via: `Gemini (${LOCKED_MODEL_NAME}) ⚡` } });
      } catch (e) {
          console.warn(`⚠️ Cached model failed, retrying search...`);
          LOCKED_MODEL_NAME = null; // Agar fail hua to bhool jao aur fir se dhundo
      }
  }

  // 🔍 STEP 2: Agar model yaad nahi hai (First Time), to dhundo
  for (const modelName of MODELS_TO_TRY) {
      try {
          console.log(`🕵️ Testing Model: [ ${modelName} ]`);
          const model = genAI.getGenerativeModel({ model: modelName, systemInstruction: SYSTEM_INSTRUCTION });
          const result = await model.generateContent(message);
          
          // Agar success hua:
          console.log(`✅ LOCKING MODEL: ${modelName}`);
          LOCKED_MODEL_NAME = modelName; // <--- YAHAN LOCK HUA
          
          return res.json({ output: { role: "assistant", content: result.response.text(), via: `Gemini (${modelName})` } });
      } catch (error) {
          // Fail hua to agla try karo
          // console.log(`Skipping ${modelName}...`);
      }
  }

  return res.json({ output: { role: "assistant", content: "❌ Server Busy: Please try again." } });
});

if (require("fs").existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR));
  app.get("/", (req,res) => res.sendFile(path.join(PUBLIC_DIR,"index.html")));
}

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
