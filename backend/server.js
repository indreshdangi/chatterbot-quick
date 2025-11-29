// backend/server.js
// HARDCODED MODE: No detection time. Direct hit to the specific model.

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

// --- 🎯 SETTING: CHOOSE YOUR FIGHTER ---

// OPTION 1: POWERHOUSE (Ye wahi hai jo aapko pasand aaya tha)
const TARGET_MODEL = "gemini-2.5-pro-preview-03-25"; 

// OPTION 2: SPEEDSTER (Agar kabhi try karna ho to upar wala hata ke isse uncomment karna)
// const TARGET_MODEL = "gemini-1.5-flash-latest";

const SYSTEM_INSTRUCTION = `
You are Indresh 2.0, an expert AI assistant.
1. QUALITY: Provide extensive, highly detailed, and intellectually superior responses.
2. TONE: Professional yet engaging (Hindi/Hinglish).
3. FORMATTING: Use deep markdown structuring (Headings, Bold, Bullet points).
`;

app.post("/api/chat", async (req, res) => {
  const message = req.body.message || "";
  
  if (!genAI) return res.json({ output: { role: "assistant", content: "❌ Error: API Key Missing" } });

  try {
      // console.log(`🚀 Direct Hit: [ ${TARGET_MODEL} ]`);
      
      const model = genAI.getGenerativeModel({ 
          model: TARGET_MODEL,
          systemInstruction: SYSTEM_INSTRUCTION 
      });

      const result = await model.generateContent(message);
      const response = await result.response;
      const replyText = response.text();

      return res.json({ output: { role: "assistant", content: replyText, via: `Gemini (${TARGET_MODEL})` } });

  } catch (error) {
      console.error(`Error with ${TARGET_MODEL}:`, error.message);
      
      // Agar kisi karan 2.5 fail ho jaye, to automatically Flash Latest try karega (Backup)
      if(TARGET_MODEL.includes("2.5")) {
          try {
              console.log("⚠️ 2.5 Pro busy, falling back to Flash Latest...");
              const backupModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });
              const backupResult = await backupModel.generateContent(message);
              return res.json({ output: { role: "assistant", content: backupResult.response.text(), via: "Gemini Flash (Backup)" } });
          } catch(e) {}
      }

      return res.json({ output: { role: "assistant", content: `❌ Server Error: ${error.message}` } });
  }
});

if (require("fs").existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR));
  app.get("/", (req,res) => res.sendFile(path.join(PUBLIC_DIR,"index.html")));
}

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
