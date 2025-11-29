// backend/server.js
// DUAL ENGINE: Gemini 2.5 Pro (Smart) + Llama 3.1 (Fast)
// No detection. Direct hardcoded connections.

const express = require("express");
const cors = require("cors");
const path = require("path");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const fetch = require("node-fetch");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "..", "public");

// --- API KEYS ---
const GEMINI_KEY = (process.env.GEMINI_KEY || "").trim();
const GROQ_KEY = (process.env.GROQ_KEY || "").trim();

// --- HARDCODED MODELS ---
const MODEL_GEMINI = "gemini-2.5-pro-preview-03-25"; // SMART & POWERFUL
const MODEL_GROQ = "llama-3.1-8b-instant";         // SUPER FAST

const genAI = GEMINI_KEY ? new GoogleGenerativeAI(GEMINI_KEY) : null;

const SYSTEM_INSTRUCTION = `
You are Indresh 2.0, an expert AI assistant.
1. FORMAT: Use Markdown (Bold, Lists) clearly.
2. TONE: Professional, Helpful, and Friendly (Hindi/Hinglish).
`;

app.post("/api/chat", async (req, res) => {
  const message = req.body.message || "";
  // Frontend se "gemini" ya "groq" aayega
  const requestedModel = (req.body.model || "gemini").toLowerCase(); 
  
  try {
    // ==========================================
    // OPTION 1: GEMINI (Smart Mode)
    // ==========================================
    if (requestedModel.includes("gemini")) {
        if (!genAI) return res.json({ output: { role: "assistant", content: "❌ Error: Gemini Key Missing" } });

        // console.log(`🧠 Using Gemini: ${MODEL_GEMINI}`);
        
        const model = genAI.getGenerativeModel({ 
            model: MODEL_GEMINI,
            systemInstruction: SYSTEM_INSTRUCTION 
        });

        const result = await model.generateContent(message);
        const response = await result.response;
        return res.json({ output: { role: "assistant", content: response.text(), via: "Gemini 2.5 Pro (Smart)" } });
    } 
    
    // ==========================================
    // OPTION 2: GROQ / LLAMA (Fast Mode)
    // ==========================================
    else {
        if (!GROQ_KEY) return res.json({ output: { role: "assistant", content: "❌ Error: Groq Key Missing" } });

        // console.log(`⚡ Using Groq: ${MODEL_GROQ}`);

        const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${GROQ_KEY}`
            },
            body: JSON.stringify({
                model: MODEL_GROQ,
                messages: [
                    { role: "system", content: SYSTEM_INSTRUCTION },
                    { role: "user", content: message }
                ],
                temperature: 0.7
            })
        });

        const data = await response.json();
        const reply = data.choices?.[0]?.message?.content || "Error from Groq";
        return res.json({ output: { role: "assistant", content: reply, via: "Llama 3.1 (Fast)" } });
    }

  } catch (error) {
      console.error("Server Error:", error.message);
      return res.json({ output: { role: "assistant", content: `❌ Error: ${error.message}` } });
  }
});

if (require("fs").existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR));
  app.get("/", (req,res) => res.sendFile(path.join(PUBLIC_DIR,"index.html")));
}

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
