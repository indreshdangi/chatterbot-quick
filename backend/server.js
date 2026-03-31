// backend/server.js
// INDRESH 2.0 - RAILWAY FIX (Normal Tone, Smart Answers, Exact Models)

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

const GEMINI_KEY = (process.env.GEMINI_KEY || "").trim();
const GROQ_KEY = (process.env.GROQ_KEY || "").trim();

// --- 🔥 YOUR EXACT MODELS ---
const MODEL_GEMINI_FLASH = "gemini-2.0-flash-exp"; 
const MODEL_GEMINI_PRO = "gemini-2.5-pro-preview-03-25";
const MODEL_GROQ = "llama-3.1-8b-instant";        

const genAI = GEMINI_KEY ? new GoogleGenerativeAI(GEMINI_KEY) : null;

// --- 🧠 SYSTEM PROMPT (SMART + FORMAT FIX, NO VIP) ---
const SYSTEM_INSTRUCTION_INDRESH = `
You are Indresh 2.0, an advanced, patriotic, and highly intelligent AI assistant from India.

**CORE BEHAVIOR & LANGUAGE:**
1. Detect user's language (Hinglish, Hindi, or English) and reply in the same language. 
2. Be energetic, smart, and creative. If asked for poetry, shayari, or wishes, DO NOT be boring. Use Emojis (🎂, ✨, ❤️, 🇮🇳) and make it heartwarming.

**CRITICAL FORMATTING RULES:**
1. **EMAIL/PHONE:** Always write standard email addresses (e.g., name@domain.com). DO NOT write the words "dot" or "at". Write phone numbers clearly.
2. **APPLICATIONS/LETTERS:** Do NOT use markdown code blocks (\`\`\`) for writing letters or applications. Use standard text paragraphs so it fits on mobile screens perfectly.
3. **SEARCH:** Use Google Search implicitly for fresh facts and current affairs.

Keep answers sharp, accurate, and concise.
`;

// --- HISTORY CLEANER ---
function sanitizeHistory(history) {
    if (!Array.isArray(history) || history.length === 0) return [];
    let cleanHistory = [...history];
    while (cleanHistory.length > 0 && cleanHistory[0].role !== "user") {
        cleanHistory.shift(); 
    }
    return cleanHistory;
}

app.post("/api/chat", async (req, res) => {
  const { message, history, model } = req.body;
  const requestedModel = (model || "groq").toLowerCase(); 
  let validHistory = sanitizeHistory(history);

  try {
    // ==========================================
    // GEMINI MODE
    // ==========================================
    if (requestedModel.includes("gemini")) {
        if (!genAI) return res.json({ output: { role: "assistant", content: "❌ Error: AI Key Missing" } });

        let modelName, viaLabel;

        if (requestedModel.includes("flash")) {
            modelName = MODEL_GEMINI_FLASH; 
            viaLabel = "Indresh (Speed)";
        } else {
            modelName = MODEL_GEMINI_PRO;   
            viaLabel = "Indresh (Deep Logic)";
        }

        const geminiModel = genAI.getGenerativeModel({ 
            model: modelName,
            systemInstruction: SYSTEM_INSTRUCTION_INDRESH,
            tools: [{ googleSearch: {} }] 
        });

        const geminiHistory = validHistory.map(msg => ({
            role: msg.role === "user" ? "user" : "model",
            parts: [{ text: msg.content }]
        }));

        const chat = geminiModel.startChat({
            history: geminiHistory,
            generationConfig: {
                temperature: 0.4, // Set for smart/creative responses
                maxOutputTokens: 1000,
            }
        });

        const result = await chat.sendMessage(message);
        const response = await result.response;
        const text = response.text();
        
        return res.json({ output: { role: "assistant", content: text, via: viaLabel } });
    } 
    
    // ==========================================
    // GROQ MODE
    // ==========================================
    else {
        if (!GROQ_KEY) return res.json({ output: { role: "assistant", content: "❌ Error: AI Key Missing" } });

        const groqMessages = [
            { role: "system", content: SYSTEM_INSTRUCTION_INDRESH },
            ...validHistory.map(msg => ({
                role: msg.role === "user" ? "user" : "assistant",
                content: msg.content
            })),
            { role: "user", content: message }
        ];

        const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${GROQ_KEY}`
            },
            body: JSON.stringify({
                model: MODEL_GROQ,
                messages: groqMessages,
                temperature: 0.6,
                max_tokens: 1024
            })
        });

        const data = await response.json();
        const reply = data.choices?.[0]?.message?.content || "Error from API";
        return res.json({ output: { role: "assistant", content: reply, via: "Indresh (Turbo)" } });
    }

  } catch (error) {
      console.error("Server Error:", error.message);
      return res.json({ output: { role: "assistant", content: `⚠️ Technical Issue: ${error.message}` } });
  }
});

if (require("fs").existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR));
  app.get("/", (req,res) => res.sendFile(path.join(PUBLIC_DIR,"index.html")));
}

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
