
// backend/server.js
// INDRESH 2.0 - Render deployment

const express = require("express");
const cors = require("cors");
const path = require("path");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const rateLimit = require("express-rate-limit");
require("dotenv").config();

const app = express();

// Existing middleware
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100
});
app.use(limiter);

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "..", "public");

// Gemini configuration
const GEMINI_KEY = (process.env.GEMINI_KEY || "").trim();
const genAI = GEMINI_KEY ? new GoogleGenerativeAI(GEMINI_KEY) : null;

// Cloudflare Workers AI configuration
const CLOUDFLARE_ACCOUNT_ID =
    (process.env.CLOUDFLARE_ACCOUNT_ID || "").trim();

const CLOUDFLARE_API_TOKEN =
    (process.env.CLOUDFLARE_API_TOKEN || "").trim();

// Model routing
const MODEL_GEMMA_SPEED = "@cf/google/gemma-4-26b-a4b-it";
const MODEL_PRO = "gemini-2.5-flash";

// Existing Turbo model retained
const MODEL_GROQ = "gemini-2.5-flash-8b";

// Original system prompt
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

// Gemma does not receive Gemini's native Google Search tool.
const SYSTEM_INSTRUCTION_GEMMA = SYSTEM_INSTRUCTION_INDRESH.replace(
    "5. **Capabilities:** USE GOOGLE SEARCH tool for real-time facts and current affairs. Provide minute, deep researched details if asked.",
    "5. **Capabilities:** If live web search is unavailable, do not claim to have searched or verified current facts. Clearly say when information needs current verification."
);

// Gemini history conversion
function sanitizeHistory(history) {
    if (!Array.isArray(history) || history.length === 0) return [];

    let formatted = history.map((msg) => ({
        role: msg.role === "user" ? "user" : "model",
        parts: [{
            text: typeof msg.content === "string" ? msg.content : ""
        }]
    }));

    formatted = formatted.filter(
        (msg) => msg.parts[0].text && msg.parts[0].text.trim() !== ""
    );

    while (formatted.length > 0 && formatted[0].role !== "user") {
        formatted.shift();
    }

    return formatted;
}

// Cloudflare history conversion
function sanitizeCloudflareMessages(history, currentMessage) {
    const formatted = Array.isArray(history)
        ? history.map((msg) => ({
            role: msg.role === "user" ? "user" : "assistant",
            content: typeof msg.content === "string" ? msg.content : ""
        })).filter((msg) => msg.content.trim() !== "")
        : [];

    while (formatted.length > 0 && formatted[0].role !== "user") {
        formatted.shift();
    }

    const lastMessage = formatted[formatted.length - 1];

    if (
        !lastMessage ||
        lastMessage.role !== "user" ||
        lastMessage.content.trim() !== currentMessage.trim()
    ) {
        formatted.push({
            role: "user",
            content: currentMessage
        });
    }

    return formatted;
}

// Gemma API
async function generateWithGemma(message, history) {
    if (!CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_API_TOKEN) {
        throw new Error(
            "Cloudflare credentials missing. Check CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in Render Environment."
        );
    }

    const messages = [
        {
            role: "system",
            content: SYSTEM_INSTRUCTION_GEMMA
        },
        ...sanitizeCloudflareMessages(history, message)
    ];

const endpoint =
    `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/run/${MODEL_GEMMA_SPEED}`;

const response = await fetch(endpoint, {
    method: "POST",
    headers: {
        "Authorization": `Bearer ${CLOUDFLARE_API_TOKEN}`,
        "Content-Type": "application/json"
    },
    body: JSON.stringify({
        messages,
        temperature: 0.7,
        max_tokens: 8192,
        chat_template_kwargs: {
            enable_thinking: false
        }
    })
});

let data;

try {
    data = await response.json();
} catch (parseError) {
    throw new Error(
        `Cloudflare Workers AI returned an unreadable response (HTTP ${response.status}).`
    );
}
    }

    if (!response.ok || data.success === false) {
        const apiErrors = Array.isArray(data.errors)
            ? data.errors.map(
                (item) =>
                    item.message || item.code || JSON.stringify(item)
            ).join("; ")
            : "";

        throw new Error(
            `Cloudflare Workers AI HTTP ${response.status}: ${apiErrors || "Request failed"}`
        );
    }

    const resultData = data?.result ?? data;

const generatedText =
    resultData?.choices?.[0]?.message?.content ??
    resultData?.choices?.[0]?.text ??
    resultData?.response ??
    resultData?.output_text ??
    resultData?.text ??
    data?.response ??
    (typeof resultData === "string" ? resultData : null);

    if (typeof generatedText !== "string" || !generatedText.trim()) {
        throw new Error(
            "Cloudflare Workers AI returned an empty or unexpected response format."
        );
    }

    return generatedText.trim();
}

// Main chat API
app.post("/api/chat", async (req, res) => {
    const { message, history, model } = req.body || {};

    const requestedType =
        (typeof model === "string" ? model : "gemini-flash").toLowerCase();

    const geminiHistory = sanitizeHistory(history);

    try {

        // PRO MODE - Gemini 2.5 Flash
        if (
            requestedType.includes("pro") ||
            requestedType.includes("deep")
        ) {
            if (!genAI) {
                return res.json({
                    output: {
                        role: "assistant",
                        content: "❌ Error: Gemini API Key Missing"
                    }
                });
            }

            console.log(`Using Pro mode model: ${MODEL_PRO}`);

            const modelInstance = genAI.getGenerativeModel({
                model: MODEL_PRO,
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
                    via: "Indresh (2.5 Flash - Pro)"
                }
            });
        }

        // SPEED MODE - Cloudflare Gemma 4
        else if (
            requestedType.includes("speed") ||
            requestedType.includes("flash") ||
            requestedType.includes("gemini") ||
            requestedType.includes("gemma")
        ) {
            console.log(`Using Speed mode model: ${MODEL_GEMMA_SPEED}`);

            const text = await generateWithGemma(message, history);

            return res.json({
                output: {
                    role: "assistant",
                    content: text,
                    via: "Indresh (Gemma 4 Speed)"
                }
            });
        }

        // Existing Turbo branch retained
        else if (requestedType.includes("turbo")) {
            if (!genAI) {
                return res.json({
                    output: {
                        role: "assistant",
                        content: "❌ Error: AI Key Missing"
                    }
                });
            }

            const displayModelName =
                MODEL_GROQ.replace("gemini-", "");

            console.log(`Using Model: ${MODEL_GROQ}`);

            const modelInstance = genAI.getGenerativeModel({
                model: MODEL_GROQ,
                systemInstruction: SYSTEM_INSTRUCTION_INDRESH
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

        return res.json({
            output: {
                role: "assistant",
                content: "❌ Error: Unknown Model Requested"
            }
        });

    } catch (error) {
        console.error("Server Error:", error.message);

        let userMsg = `⚠️ Error: ${error.message}.`;

        if (error.message.includes("404")) {
            userMsg =
                "⚠️ API Error: Model or endpoint not found. Check the configured model ID.";
        } else if (error.message.includes("429")) {
            userMsg =
                "⚠️ Cloudflare/Gemini request limit or capacity reached. Check your provider usage and try again later.";
        }

        return res.json({
            output: {
                role: "assistant",
                content: userMsg
            }
        });
    }
});

// Serve frontend
if (require("fs").existsSync(PUBLIC_DIR)) {
    app.use(express.static(PUBLIC_DIR));
    app.get("/", (req, res) =>
        res.sendFile(path.join(PUBLIC_DIR, "index.html"))
    );
}

app.listen(PORT, () =>
    console.log(`Server running on port ${PORT}`)
);
