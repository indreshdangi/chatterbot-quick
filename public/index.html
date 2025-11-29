// backend/server.js
// UPGRADED BRAIN: Memory Support + Concise Answers + History Handling

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

const MODEL_GEMINI = "gemini-2.5-pro-preview-03-25"; 
const MODEL_GROQ = "llama-3.1-8b-instant";        

const genAI = GEMINI_KEY ? new GoogleGenerativeAI(GEMINI_KEY) : null;

// --- STRICT SYSTEM INSTRUCTION (Bakwas Band, Kaam Chalu) ---
const SYSTEM_INSTRUCTION = `
You are Indresh 2.0, a smart AI assistant.
1. CONCISE: Keep answers short and direct unless asked for details.
2. TONE: Natural, conversational (Mix of Hindi/English like a human friend).
3. FORMAT: Use Markdown (Bold, Lists) but avoid excessive formatting for small talks.
4. MEMORY: Use the provided conversation history to answer contextually.
`;

app.post("/api/chat", async (req, res) => {
  const { message, history, model } = req.body; // Ab hum history bhi receive karenge
  const requestedModel = (model || "groq").toLowerCase(); 

  try {
    // ==========================================
    // OPTION 1: GEMINI (Powerful)
    // ==========================================
    if (requestedModel.includes("gemini")) {
        if (!genAI) return res.json({ output: { role: "assistant", content: "❌ Error: Gemini Key Missing" } });

        const geminiModel = genAI.getGenerativeModel({ 
            model: MODEL_GEMINI,
            systemInstruction: SYSTEM_INSTRUCTION 
        });

        // History format convert karna padega Gemini ke liye
        const chatHistory = (history || []).map(msg => ({
            role: msg.role === "user" ? "user" : "model",
            parts: [{ text: msg.content }]
        }));

        const chat = geminiModel.startChat({
            history: chatHistory
        });

        const result = await chat.sendMessage(message);
        const response = await result.response;
        return res.json({ output: { role: "assistant", content: response.text(), via: "2.5 Pro (Powerful)" } });
    } 
    
    // ==========================================
    // OPTION 2: GROQ (Fast - DEFAULT)
    // ==========================================
    else {
        if (!GROQ_KEY) return res.json({ output: { role: "assistant", content: "❌ Error: Groq Key Missing" } });

        // History prepare karo Groq ke liye
        const messages = [
            { role: "system", content: SYSTEM_INSTRUCTION },
            ...(history || []), // Purani baatein
            { role: "user", content: message } // Abhi ki baat
        ];

        const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${GROQ_KEY}`
            },
            body: JSON.stringify({
                model: MODEL_GROQ,
                messages: messages,
                temperature: 0.6, // Thoda creative kam, accurate zyada
                max_tokens: 1024  // Limit lagayi taaki bada essay na likhe
            })
        });

        const data = await response.json();
        const reply = data.choices?.[0]?.message?.content || "Error from Groq";
        return res.json({ output: { role: "assistant", content: reply, via: "3.1 8b (Fast)" } });
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
