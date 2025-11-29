// backend/server.js
// FINAL STABLE VERSION: Auto-fixes history errors & Role mismatch
// Includes: Gemini 2.5 Pro + Llama 3.1

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

// MODELS
const MODEL_GEMINI = "gemini-2.5-pro-preview-03-25"; 
const MODEL_GROQ = "llama-3.1-8b-instant";        

const genAI = GEMINI_KEY ? new GoogleGenerativeAI(GEMINI_KEY) : null;

const SYSTEM_INSTRUCTION = `
You are Indresh 2.0, a smart AI assistant.
1. CONCISE: Keep answers short and direct.
2. TONE: Natural, conversational (Hinglish/Hindi allowed).
3. FORMAT: Use Markdown (Bold, Lists).
`;

// --- HISTORY CLEANER FUNCTION (Ye Error Rokega) ---
function sanitizeHistory(history) {
    if (!Array.isArray(history) || history.length === 0) return [];

    let cleanHistory = [...history];

    // RULE: History must start with 'user'. If 'model' is first, remove it.
    while (cleanHistory.length > 0 && cleanHistory[0].role !== "user") {
        cleanHistory.shift(); 
    }
    
    return cleanHistory;
}

app.post("/api/chat", async (req, res) => {
  const { message, history, model } = req.body;
  const requestedModel = (model || "groq").toLowerCase(); 

  // 1. Validate History
  let validHistory = sanitizeHistory(history);

  try {
    // ==========================================
    // OPTION 1: GEMINI (Smart)
    // ==========================================
    if (requestedModel.includes("gemini")) {
        if (!genAI) return res.json({ output: { role: "assistant", content: "❌ Error: Gemini Key Missing" } });

        const geminiModel = genAI.getGenerativeModel({ 
            model: MODEL_GEMINI,
            systemInstruction: SYSTEM_INSTRUCTION 
        });

        // Convert roles for Gemini (user -> user, assistant -> model)
        const geminiHistory = validHistory.map(msg => ({
            role: msg.role === "user" ? "user" : "model",
            parts: [{ text: msg.content }]
        }));

        const chat = geminiModel.startChat({
            history: geminiHistory
        });

        const result = await chat.sendMessage(message);
        const response = await result.response;
        return res.json({ output: { role: "assistant", content: response.text(), via: "2.5 Pro (Powerful)" } });
    } 
    
    // ==========================================
    // OPTION 2: GROQ (Fast)
    // ==========================================
    else {
        if (!GROQ_KEY) return res.json({ output: { role: "assistant", content: "❌ Error: Groq Key Missing" } });

        // Groq needs roles: 'user' and 'assistant'
        const groqMessages = [
            { role: "system", content: SYSTEM_INSTRUCTION },
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
        const reply = data.choices?.[0]?.message?.content || "Error from Groq API";
        return res.json({ output: { role: "assistant", content: reply, via: "3.1 8b (Fast)" } });
    }

  } catch (error) {
      console.error("Server Error:", error.message);
      // Agar error aaye to user ko batao, lekin crash mat hone do
      return res.json({ output: { role: "assistant", content: `❌ Connection Error: ${error.message}. Please try again.` } });
  }
});

if (require("fs").existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR));
  app.get("/", (req,res) => res.sendFile(path.join(PUBLIC_DIR,"index.html")));
}

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
