// backend/server.js
// SPEED KING: Uses 'Gemini 1.5 Flash Latest' ⚡
// Best balance of Speed, Cost, and Quality for Chatbots.

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

// --- 🎯 TARGET: FLASH LATEST ---
// Ye model Pro se thoda kam powerful hai, lekin insan ko fark pata nahi chalta.
// Speed: 10x Faster than Pro. Cost: Very Low.
const TARGET_MODEL = "gemini-1.5-flash-latest"; 

const SYSTEM_INSTRUCTION = `
You are Indresh 2.0, a highly efficient and fast AI assistant.
1. SPEED: Do not lag. Respond instantly.
2. QUALITY: Provide accurate, well-structured answers in Hindi/Hinglish.
3. FORMATTING: Use Markdown (Bold, Lists, Paragraphs) effectively.
4. PERSONALITY: Helpful, Polite, and Intelligent.
`;

app.post("/api/chat", async (req, res) => {
  const message = req.body.message || "";
  
  if (!genAI) return res.json({ output: { role: "assistant", content: "❌ Error: API Key Missing" } });

  try {
      // console.log(`⚡ Speed Mode: [ ${TARGET_MODEL} ]`);
      
      const model = genAI.getGenerativeModel({ 
          model: TARGET_MODEL,
          systemInstruction: SYSTEM_INSTRUCTION 
      });

      const result = await model.generateContent(message);
      const response = await result.response;
      
      // Flash kabhi-kabhi response block kar deta hai agar safety high ho
      // Isliye hum safety settings default rakhenge
      
      return res.json({ output: { role: "assistant", content: response.text(), via: `Gemini Flash ⚡` } });

  } catch (error) {
      console.error(`Flash Error: ${error.message}`);
      return res.json({ output: { role: "assistant", content: `❌ Server Error: ${error.message}` } });
  }
});

if (require("fs").existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR));
  app.get("/", (req,res) => res.sendFile(path.join(PUBLIC_DIR,"index.html")));
}

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
