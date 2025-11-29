// backend/server.js
// TARGET: 'Gemini 1.5 Flash-002' (The REAL name of Flash Latest) ⚡

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

// --- 🎯 REAL NAME OF FLASH LATEST ---
// Website par iska naam "Flash Latest" hai, lekin API me "002" hai.
const TARGET_MODEL = "gemini-1.5-flash-002"; 

const SYSTEM_INSTRUCTION = `
You are Indresh 2.0, a super-fast AI assistant.
1. SPEED: Respond instantly.
2. ACCURACY: Provide the latest info.
3. FORMAT: Clean Markdown (Bold, Lists).
`;

app.post("/api/chat", async (req, res) => {
  const message = req.body.message || "";
  
  if (!genAI) return res.json({ output: { role: "assistant", content: "❌ Error: API Key Missing" } });

  try {
      // console.log(`⚡ Using Real Flash Latest: [ ${TARGET_MODEL} ]`);
      
      const model = genAI.getGenerativeModel({ 
          model: TARGET_MODEL,
          systemInstruction: SYSTEM_INSTRUCTION 
      });

      const result = await model.generateContent(message);
      const response = await result.response;
      return res.json({ output: { role: "assistant", content: response.text(), via: `Gemini Flash Latest (002)` } });

  } catch (error) {
      console.error(`Flash 002 Error: ${error.message}`);
      
      // Agar 002 kisi wajah se na chale, to standard Flash try karega
      try {
          const fallback = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
          const res2 = await fallback.generateContent(message);
          return res.json({ output: { role: "assistant", content: res2.response.text(), via: "Gemini Flash (Backup)" } });
      } catch(e) {
          return res.json({ output: { role: "assistant", content: `❌ Server Error: ${error.message}` } });
      }
  }
});

if (require("fs").existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR));
  app.get("/", (req,res) => res.sendFile(path.join(PUBLIC_DIR,"index.html")));
}

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
