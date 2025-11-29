// backend/server.js
// PREMIUM VERSION: Forces 'Gemini 1.5 Pro-002' (Best Quality + Optimized Speed)
// No Flash, No Compromise.

const express = require("express");
const cors = require("cors");
const path = require("path");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const fetch = require("node-fetch");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" })); // Limit badha di taaki bada data handle ho sake

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "..", "public");

const GEMINI_KEY = (process.env.GEMINI_KEY || "").trim();

// --- 🎯 THE TARGET MODEL ---
// Yeh Google ka sabse latest optimized PRO model hai.
// Yeh mehenga hai, lekin sabse best hai.
const TARGET_MODEL = "gemini-1.5-pro-002"; 

const genAI = GEMINI_KEY ? new GoogleGenerativeAI(GEMINI_KEY) : null;

// --- SYSTEM PROMPT (High Quality) ---
const SYSTEM_INSTRUCTION = `
You are Indresh 2.0, an expert AI assistant.
1. QUALITY: Provide extensive, highly detailed, and intellectually superior responses.
2. TONE: Professional yet engaging (Hindi/Hinglish).
3. FORMATTING: Use deep markdown structuring (Headings, Bold, Bullet points, Code blocks).
4. SPEED: Do not fluff. Be direct and impactful.
`;

app.post("/api/chat", async (req, res) => {
  try {
    const message = req.body.message || "";
    
    if (!genAI) {
        return res.json({ output: { role: "assistant", content: "❌ Error: API Key Missing" } });
    }

    // Direct Call to the Premium Model
    console.log(`💎 Requesting Premium Model: [ ${TARGET_MODEL} ]`);
    
    const model = genAI.getGenerativeModel({ 
        model: TARGET_MODEL,
        systemInstruction: SYSTEM_INSTRUCTION 
    });

    const result = await model.generateContent(message);
    const response = await result.response;
    const replyText = response.text();

    return res.json({ output: { role: "assistant", content: replyText, via: `Gemini Pro 002 (Premium)` } });

  } catch (error) {
    console.error("Premium Model Failed:", error.message);
    
    // Fallback: Agar kisi reason se 002 fail ho jaye, to Standard Pro try karega
    if(error.message.includes("404") || error.message.includes("not found")) {
        console.log("⚠️ 002 not active, falling back to Standard 1.5 Pro...");
        try {
            const fallback = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });
            const result = await fallback.generateContent(message);
            return res.json({ output: { role: "assistant", content: result.response.text(), via: "Gemini 1.5 Pro (Standard)" } });
        } catch(e) {
             return res.json({ output: { role: "assistant", content: `❌ Server Error: ${e.message}` } });
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
