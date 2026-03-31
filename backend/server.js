// backend/server.js

const express = require("express");
const cors = require("cors");
const path = require("path");
const fetch = require("node-fetch"); // ✅ FIXED
const { GoogleGenerativeAI } = require("@google/generative-ai");
const rateLimit = require("express-rate-limit");
require("dotenv").config();

const app = express();

// ✅ CORS
app.use(cors({
  origin: "*"
}));

app.use(express.json({ limit: "10mb" }));

// ✅ Rate Limiter (testing friendly)
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000
});
app.use(limiter);

// ✅ PORT FIX
const PORT = process.env.PORT || 3000;

// ✅ ROOT ROUTE (VERY IMPORTANT)
app.get("/", (req, res) => {
  res.send("API is running 🚀");
});

const PUBLIC_DIR = path.join(__dirname, "..", "public");

// ✅ ENV
const GEMINI_KEY = (process.env.GEMINI_KEY || "").trim();
const GROQ_KEY = (process.env.GROQ_KEY || "").trim();

const genAI = GEMINI_KEY ? new GoogleGenerativeAI(GEMINI_KEY) : null;

// --- MODELS ---
const MODEL_FLASH = "gemini-2.5-flash";
const MODEL_PRO   = "gemini-2.5-pro";
const MODEL_GROQ  = "llama-3.1-8b-instant";

// --- SYSTEM ---
const SYSTEM_INSTRUCTION_INDRESH = `
You are Indresh 2.0, a smart, friendly, and helpful AI assistant.

CRITICAL IDENTITY RULES:
1. **CREATOR:** "Mujhe Indresh Dangi ne banaya hai."
2. Mirror user language.
3. Friendly tone.
4. Use tools for real-time info.
`;

// --- HISTORY CLEANER ---
function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];

  let formatted = history.map(msg => ({
    role: msg.role === "user" ? "user" : "model",
    parts: [{ text: msg.content }]
  }));

  formatted = formatted.filter(m => m.parts[0].text?.trim());

  while (formatted.length && formatted[0].role !== "user") {
    formatted.shift();
  }

  return formatted;
}

// --- CHAT ROUTE ---
app.post("/api/chat", async (req, res) => {
  try {
    const { message, history, model } = req.body;
    const requestedType = (model || "gemini").toLowerCase();

    const geminiHistory = sanitizeHistory(history);

    // ================= GEMINI =================
    if (requestedType.includes("gemini") || requestedType.includes("flash") || requestedType.includes("pro")) {
      if (!genAI) {
        return res.status(400).json({
          output: { role: "assistant", content: "❌ Error: Gemini API Key Missing" }
        });
      }

      const targetModelName = requestedType.includes("flash") ? MODEL_FLASH : MODEL_PRO;
      const displayModelName = targetModelName.replace("gemini-", "");

      const modelInstance = genAI.getGenerativeModel({
        model: targetModelName,
        systemInstruction: SYSTEM_INSTRUCTION_INDRESH,
        tools: [{ googleSearch: {} }]
      });

      const chat = modelInstance.startChat({
        history: geminiHistory,
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 8192
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

    // ================= GROQ =================
    else {
      if (!GROQ_KEY) {
        return res.status(400).json({
          output: { role: "assistant", content: "❌ Error: Groq API Key Missing" }
        });
      }

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

      return res.json({
        output: {
          role: "assistant",
          content: reply,
          via: "Indresh (Turbo)"
        }
      });
    }

  } catch (error) {
    console.error("Server Error:", error);

    return res.status(500).json({
      output: {
        role: "assistant",
        content: "⚠️ Server error. Check backend logs."
      }
    });
  }
});

// --- STATIC (optional) ---
if (require("fs").existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR));
}

// --- START SERVER ---
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
