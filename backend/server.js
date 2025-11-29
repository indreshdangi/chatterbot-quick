// backend/server.js
// GOD MODE: Uses 'Gemini 3 Pro Preview' (The Latest & Most Powerful) 💎

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

// --- 🎯 TARGET: THE BEAST (GEMINI 3) ---
const TARGET_MODEL = "gemini-3-pro-preview"; 

// Backup: Agar 3.0 abhi API par active na ho, to 2.5 Pro chalega
const BACKUP_MODEL = "gemini-2.5-pro-preview-03-25";

const SYSTEM_INSTRUCTION = `
You are Indresh 2.0, an advanced AI powered by Gemini 3.
1. INTELLIGENCE: Use your SOTA reasoning to provide the best possible answers.
2. TONE: Professional, Smart, and Engaging (Hindi/Hinglish).
3. FORMAT: Use clean Markdown (Bold, Lists, Headings).
`;

app.post("/api/chat", async (req, res) => {
  const message = req.body.message || "";
  
  if (!genAI) return res.json({ output: { role: "assistant", content: "❌ Error: API Key Missing" } });

  try {
      console.log(`💎 Attempting GOD MODE: [ ${TARGET_MODEL} ]`);
      
      const model = genAI.getGenerativeModel({ 
          model: TARGET_MODEL,
          systemInstruction: SYSTEM_INSTRUCTION 
      });

      const result = await model.generateContent(message);
      const response = await result.response;
      return res.json({ output: { role: "assistant", content: response.text(), via: `Gemini 3 Pro (New)` } });

  } catch (error) {
      console.error(`Gemini 3 Failed (${error.message}), switching to 2.5 Pro...`);
      
      // FALLBACK TO 2.5 PRO (Jo pehle chal raha tha)
      try {
          const backupModel = genAI.getGenerativeModel({ model: BACKUP_MODEL, systemInstruction: SYSTEM_INSTRUCTION });
          const backupResult = await backupModel.generateContent(message);
          return res.json({ output: { role: "assistant", content: backupResult.response.text(), via: "Gemini 2.5 Pro (Backup)" } });
      } catch(e) {
          return res.json({ output: { role: "assistant", content: `❌ Server Error: ${e.message}` } });
      }
  }
});

if (require("fs").existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR));
  app.get("/", (req,res) => res.sendFile(path.join(PUBLIC_DIR,"index.html")));
}

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
