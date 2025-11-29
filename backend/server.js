// backend/server.js
// STABLE VERSION: Prioritizes working models & Fixes 'message is not defined' crash.

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

// --- MODEL PRIORITY LIST ---
// Hum bari-bari se inhe try karenge. Jo chalega, wo daudega.
const MODELS_TO_TRY = [
    "gemini-2.5-pro-preview-03-25", // Priority 1: The one that worked for you!
    "gemini-1.5-pro",               // Priority 2: Standard Pro
    "gemini-1.5-flash"              // Priority 3: Fast Backup
];

const SYSTEM_INSTRUCTION = `
You are Indresh 2.0, an expert AI assistant.
1. QUALITY: Provide extensive, highly detailed, and intellectually superior responses.
2. TONE: Professional yet engaging (Hindi/Hinglish).
3. FORMATTING: Use deep markdown structuring (Headings, Bold, Bullet points).
`;

app.post("/api/chat", async (req, res) => {
  // FIX: Message variable defined OUTSIDE try block so Catch can use it.
  const message = req.body.message || "";
  
  if (!genAI) {
      return res.json({ output: { role: "assistant", content: "❌ Error: API Key Missing" } });
  }

  // Loop through models until one works
  for (const modelName of MODELS_TO_TRY) {
      try {
          console.log(`🤖 Attempting Model: [ ${modelName} ]`);
          
          const model = genAI.getGenerativeModel({ 
              model: modelName,
              systemInstruction: SYSTEM_INSTRUCTION 
          });

          const result = await model.generateContent(message);
          const response = await result.response;
          const replyText = response.text();

          // Agar yahan tak pahuche, matlab success!
          console.log(`✅ SUCCESS with: ${modelName}`);
          return res.json({ output: { role: "assistant", content: replyText, via: `Gemini (${modelName})` } });

      } catch (error) {
          console.warn(`⚠️ Failed [${modelName}]: ${error.message}`);
          // Continue to next model in the list...
      }
  }

  // Agar saare models fail ho gaye:
  return res.json({ output: { role: "assistant", content: "❌ All models are currently busy or unavailable. Please try again in a moment." } });
});

if (require("fs").existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR));
  app.get("/", (req,res) => res.sendFile(path.join(PUBLIC_DIR,"index.html")));
}

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
