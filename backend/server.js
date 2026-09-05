// backend/server.js
// INDRESH 2.0 - RAILWAY DEPLOYMENT (api.indservices.in)

const express = require("express");
const cors = require("cors");
const path = require("path");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const rateLimit = require('express-rate-limit'); 
require("dotenv").config();

const app = express();

// Railway Deployment ke liye CORS settings (api.indservices.in)
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Rate Limiter
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

// --- 🔥 MODELS (Using 2.5 Flash for Speed, 2.5 Flash-8B for Turbo & 2.5 Pro for Deep) ---
const MODEL_FLASH = "gemini-2.5-flash"; 
const MODEL_PRO   = "gemini-2.5-pro";
const MODEL_GROQ  = "gemini-2.5-flash-8b"; // Changed Turbo from Llama to 2.5 Flash-8B

// --- SYSTEM PROMPT (Deep Research, Formatting Fix & Custom Identity) ---
const SYSTEM_INSTRUCTION_INDRESH = `
You are Indresh 2.0, a smart, friendly, and highly intelligent AI assistant.

CRITICAL IDENTITY RULES:
1. **CREATOR:** If asked "Who made you?", "Tumhe kisne banaya?", or about your origin, YOU MUST REPLY: **"Mujhe Indresh Dangi ne banaya hai."** (or "I was created by Indresh Dangi."). 
   - NEVER say you were made by Google.
   
2. **Language Mirroring:** Detect the user's language (Hindi, English, or Hinglish) and reply in the EXACT SAME language.
   
3. **Tone & Quality:** Friendly, direct, and helpful. Use your full power to give deep, perfect, and creative solutions.

4. **Formatting Fix:** ALWAYS write standard email addresses (e.g., example@domain.com). NEVER write the words "dot" or "at". Write numbers properly.

5. **Capabilities:** USE GOOGLE SEARCH tool for real-time facts and current affairs. Provide minute, deep researched details if asked.
`;

// --- HISTORY CLEANER ---
function sanitizeHistory(history) {
    if (!Array.isArray(history) || history.length === 0) return [];
    
    let formatted = history.map(msg => ({
        role: msg.role === "user" ? "user" : "model",
        parts: [{ text: msg.content }]
    }));

    formatted = formatted.filter(m => m.parts[0].text && m.parts[0].text.trim() !== "");

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
        // GEMINI MODE (Handles Speed, Deep, and default Gemini requests)
        // ==========================================
        if (requestedType.includes("gemini") || requestedType.includes("flash") || requestedType.includes("pro") || requestedType.includes("speed") || requestedType.includes("deep")) {
            if (!genAI) return res.json({ output: { role: "assistant", content: "❌ Error: AI Key Missing" } });

            // Route "speed" to MODEL_FLASH, "deep" and "pro" to MODEL_PRO, defaults to MODEL_FLASH
            let targetModelName = MODEL_FLASH;
            if (requestedType.includes("pro") || requestedType.includes("deep")) {
                targetModelName = MODEL_PRO;
            }
            
            // LABEL FIX: 'gemini-' hata kar sirf '2.5-flash' ya '2.5-pro' dikhana hai
            const displayModelName = targetModelName.replace("gemini-", "");

            console.log(`Using Model: ${targetModelName}`);

            const modelInstance = genAI.getGenerativeModel({
                model: targetModelName,
                systemInstruction: SYSTEM_INSTRUCTION_INDRESH,
                tools: [{ googleSearch: {} }] // Google Search Active!
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
                    via: `Indresh (${displayModelName})` 
                } 
            });
        } 
        
        // ==========================================
        // TURBO MODE (Now using Gemini 2.5 Flash-8B instead of Groq)
        // ==========================================
        else if (requestedType.includes("turbo")) {
             if (!genAI) return res.json({ output: { role: "assistant", content: "❌ Error: AI Key Missing" } });
             
             const displayModelName = MODEL_GROQ.replace("gemini-", "");
             console.log(`Using Model: ${MODEL_GROQ}`);
             
             const modelInstance = genAI.getGenerativeModel({
                 model: MODEL_GROQ,
                 systemInstruction: SYSTEM_INSTRUCTION_INDRESH,
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
                     via: `Indresh (${displayModelName})` 
                 } 
             });
        }
        else {
             return res.json({ output: { role: "assistant", content: "❌ Error: Unknown Model Requested" } });
        }

    } catch (error) {
        console.error("Server Error:", error.message);
        
        let userMsg = `⚠️ Error: ${error.message}.`;
        if(error.message.includes("404")) {
            userMsg = `⚠️ Google API Error: Model update checking... Switch to Pro or Turbo.`;
        }

        return res.json({ 
            output: { 
                role: "assistant", 
                content: userMsg 
            } 
        });
    }
});

if (require("fs").existsSync(PUBLIC_DIR)) {
    app.use(express.static(PUBLIC_DIR));
    app.get("/", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));
}

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
