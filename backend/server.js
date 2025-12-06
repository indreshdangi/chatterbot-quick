// backend/server.js
// INDRESH 2.0 - GEMINI 2.5 FLASH & PRO (WITH SEARCH)

const express = require("express");
const cors = require("cors");
const path = require("path");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const rateLimit = require('express-rate-limit'); 
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Rate Limiter (Render ke liye zaruri)
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 100 
});
app.use(limiter);

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "..", "public");

const GEMINI_KEY = (process.env.GEMINI_KEY || "").trim();
const GROQ_KEY = (process.env.GROQ_KEY || "").trim();

const genAI = GEMINI_KEY ? new GoogleGenerativeAI(GEMINI_KEY) : null;

// --- 🔥 EXACT MODELS (2.5) WITH SEARCH ---
const MODEL_FLASH = "gemini-2.5-flash"; 
const MODEL_PRO   = "gemini-2.5-pro";
const MODEL_GROQ  = "llama-3.1-8b-instant";

const SYSTEM_INSTRUCTION_INDRESH = `
You are Indresh 2.0, a smart, friendly, and helpful AI assistant made in Bharat.

CRITICAL BEHAVIOR RULES:
1. **Language Mirroring:** Automatically detect the user's language (Hindi, English, or Hinglish) and reply in the **EXACT SAME language**.
   - User: "Aur bhai kya haal?" -> You: "Sab badhiya bhai, tum sunao?"
   - User: "What is quantum physics?" -> You: Explains in English.
   
2. **Tone:** Friendly, direct, and helpful. No fake poetic drama ("Shayar" nahi banna).

3. **Capabilities:** - **USE GOOGLE SEARCH** tool for real-time news, cricket scores, and facts.
   - Provide minute details if asked.
   - Generate high-quality content (essays, code) properly.

4. **Speed:** Be fast and accurate.
`;

// --- HISTORY CLEANER (CRITICAL FIX) ---
function sanitizeHistory(history) {
    if (!Array.isArray(history) || history.length === 0) return [];
    
    let formatted = history.map(msg => ({
        role: msg.role === "user" ? "user" : "model",
        parts: [{ text: msg.content }]
    }));

    formatted = formatted.filter(m => m.parts[0].text && m.parts[0].text.trim() !== "");

    // Rule: First message MUST be user
    while (formatted.length > 0 && formatted[0].role !== "user") {
        formatted.shift();
    }

    return formatted;
}

app.post("/api/chat", async (req, res) => {
    const { message, history, model } = req.body;
    const requestedType = (model || "gemini").toLowerCase();
    
    const geminiHistory = sanitizeHistory(history);

    try {
        // ==========================================
        // GEMINI MODE (2.5 with Search)
        // ==========================================
        if (requestedType.includes("gemini") || requestedType.includes("flash") || requestedType.includes("pro")) {
            if (!genAI) return res.json({ output: { role: "assistant", content: "❌ Error: AI Key Missing" } });

            // Seedha selection: Flash maanga to 2.5 Flash, nahi to 2.5 Pro
            const targetModelName = requestedType.includes("flash") ? MODEL_FLASH : MODEL_PRO;
            
            console.log(`Using Model: ${targetModelName}`);

            const modelInstance = genAI.getGenerativeModel({
                model: targetModelName,
                systemInstruction: SYSTEM_INSTRUCTION_INDRESH,
                // 👇 GOOGLE SEARCH TOOL ON (Live Info ke liye)
                tools: [{ googleSearch: {} }] 
            });

            const chat = modelInstance.startChat({
                history: geminiHistory,
                generationConfig: {
                    temperature: 0.7,      
                    maxOutputTokens: 8192, 
                }
            });

            const result = await chat.sendMessage(message);
            const response = await result.response;
            const text = response.text();
            
            return res.json({ 
                output: { 
                    role: "assistant", 
                    content: text, 
                    via: `Indresh (${targetModelName})` 
                } 
            });
        } 
        
        // ==========================================
        // GROQ MODE (Backup)
        // ==========================================
        else {
            if (!GROQ_KEY) return res.json({ output: { role: "assistant", content: "❌ Error: AI Key Missing" } });

            const groqMessages = [
                { role: "system", content: SYSTEM_INSTRUCTION_INDRESH },
                ...history.map(msg => ({
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
                    temperature: 0.7,
                    max_tokens: 4096
                })
            });

            const data = await response.json();
            const reply = data.choices?.[0]?.message?.content || "Error from API";
            return res.json({ output: { role: "assistant", content: reply, via: "Indresh (Turbo)" } });
        }

    } catch (error) {
        console.error("Server Error:", error.message);
        return res.json({ 
            output: { 
                role: "assistant", 
                content: `⚠️ Error: ${error.message}.` 
            } 
        });
    }
});

if (require("fs").existsSync(PUBLIC_DIR)) {
    app.use(express.static(PUBLIC_DIR));
    app.get("/", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));
}

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
