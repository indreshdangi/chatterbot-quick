// backend/server.js
// INDRESH 2.0 - Render deployment

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const rateLimit = require("express-rate-limit");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Rate-limit only chat API calls. Static files and the homepage must never
// be blocked by chat traffic. Render provides the original client IP as the
// first address in X-Forwarded-For.
const chatLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        const forwardedFor = req.get("x-forwarded-for");
        const firstForwardedIp = typeof forwardedFor === "string"
            ? forwardedFor.split(",")[0].trim()
            : "";
        return firstForwardedIp || req.ip || req.socket.remoteAddress || "unknown";
    },
    handler: (_req, res) => {
        res.status(429).json({
            output: {
                role: "assistant",
                content: "You have sent too many messages in a short time. Please wait a minute and try again."
            }
        });
    }
});

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "..", "public");

// API keys
const GEMINI_KEY = (process.env.GEMINI_KEY || "").trim();
const CLOUDFLARE_ACCOUNT_ID =
    (process.env.CLOUDFLARE_ACCOUNT_ID || "").trim();
const CLOUDFLARE_API_TOKEN =
    (process.env.CLOUDFLARE_API_TOKEN || "").trim();

// Model routing
const MODEL_GEMMA_SPEED = "@cf/google/gemma-4-26b-a4b-it";
const MODEL_CLOUDFLARE_PRO = "@cf/nvidia/nemotron-3-120b-a12b";
const MODEL_GEMINI_SEARCH = "gemini-2.5-flash-lite";

// Original system prompt for Gemini Search mode
const SYSTEM_INSTRUCTION_INDRESH = `
You are Indresh 2.0, a smart, friendly, and highly intelligent AI assistant.

CRITICAL IDENTITY RULES:
1. **CREATOR:** If asked "Who made you?", "Tumhe kisne banaya?", or about your origin, YOU MUST REPLY: **"Mujhe Indresh Dangi ne banaya hai."** (or "I was created by Indresh Dangi.").
   - NEVER say you were made by Google.

2. **Language Mirroring:** Detect the user's language (Hindi, English, or Hinglish) and reply in the EXACT SAME language.

3. **Tone & Quality:** Friendly, direct, and helpful. Use your full power to give deep, perfect, and creative solutions.

4. **Formatting Fix:** ALWAYS write standard email addresses (e.g., example@domain.com). NEVER write the words "dot" or "at". Write numbers properly.

5. **Capabilities:** Use Google Search grounding when it can improve factual accuracy, especially for current events, local information, prices, schedules, and recent updates. Distinguish confirmed information from uncertainty and cite sources returned by Google Search.
`;

// Cloudflare models do not have Google's built-in Search tool.
const SYSTEM_INSTRUCTION_CLOUDFLARE = SYSTEM_INSTRUCTION_INDRESH.replace(
    "5. **Capabilities:** Use Google Search grounding when it can improve factual accuracy, especially for current events, local information, prices, schedules, and recent updates. Distinguish confirmed information from uncertainty and cite sources returned by Google Search.",
    "5. **Capabilities:** You do not have live web search in this mode. Do not claim to have searched or verified current facts. Clearly state when information may be outdated and needs current verification."
);

// Convert browser chat history to Gemini's expected format.
// The browser includes the current user message in history before the API call,
// so remove that final copy; it is appended separately below.
function sanitizeHistory(history, currentMessage) {
    if (!Array.isArray(history) || history.length === 0) return [];

    let formatted = history.map((msg) => ({
        role: msg && msg.role === "user" ? "user" : "model",
        parts: [{
            text: msg && typeof msg.content === "string" ? msg.content : ""
        }]
    }));

    formatted = formatted.filter(
        (msg) => msg.parts[0].text && msg.parts[0].text.trim() !== ""
    );

    const lastMessage = formatted[formatted.length - 1];
    if (
        currentMessage &&
        lastMessage &&
        lastMessage.role === "user" &&
        lastMessage.parts[0].text.trim() === currentMessage.trim()
    ) {
        formatted.pop();
    }

    while (formatted.length > 0 && formatted[0].role !== "user") {
        formatted.shift();
    }

    return formatted;
}

// Convert browser history to Cloudflare's messages format.
function sanitizeCloudflareMessages(history, currentMessage) {
    const formatted = Array.isArray(history)
        ? history.map((msg) => ({
            role: msg && msg.role === "user" ? "user" : "assistant",
            content: msg && typeof msg.content === "string" ? msg.content : ""
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

function extractTextContent(value) {
    if (typeof value === "string") return value;

    if (Array.isArray(value)) {
        return value.map((part) => {
            if (typeof part === "string") return part;
            if (part && typeof part.text === "string") return part.text;
            if (part && typeof part.content === "string") return part.content;
            return "";
        }).join("");
    }

    return null;
}

// Shared Cloudflare Workers AI runner for Speed and Pro.
async function generateWithCloudflare(
    modelId,
    message,
    history,
    options = {}
) {
    if (!CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_API_TOKEN) {
        throw new Error(
            "Cloudflare credentials missing. Check CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in Render Environment."
        );
    }

    const messages = [
        {
            role: "system",
            content: SYSTEM_INSTRUCTION_CLOUDFLARE
        },
        ...sanitizeCloudflareMessages(history, message)
    ];

    const requestBody = {
        messages,
        temperature: options.temperature ?? 0.7,
        max_completion_tokens: options.maxCompletionTokens ?? 8192
    };

    if (options.topP !== undefined) {
        requestBody.top_p = options.topP;
    }
    if (options.chatTemplateKwargs) {
        requestBody.chat_template_kwargs = options.chatTemplateKwargs;
    }

    const endpoint =
        `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/run/${modelId}`;

    const response = await fetch(endpoint, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${CLOUDFLARE_API_TOKEN}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify(requestBody)
    });

    let data;
    try {
        data = await response.json();
    } catch (parseError) {
        throw new Error(
            `Cloudflare Workers AI returned an unreadable response (HTTP ${response.status}).`
        );
    }

    if (!response.ok || data?.success === false) {
        const apiErrors = Array.isArray(data?.errors)
            ? data.errors.map((item) =>
                item.message || item.code || JSON.stringify(item)
            ).join("; ")
            : "";

        throw new Error(
            `Cloudflare Workers AI HTTP ${response.status}: ${apiErrors || "Request failed"}`
        );
    }

    const resultData = data && data.result !== undefined ? data.result : data;
    const candidates = [
        resultData && resultData.response,
        resultData && resultData.choices &&
            resultData.choices[0] && resultData.choices[0].message &&
            resultData.choices[0].message.content,
        resultData && resultData.choices &&
            resultData.choices[0] && resultData.choices[0].text,
        resultData && resultData.output_text,
        resultData && resultData.text,
        resultData && resultData.generated_text,
        data && data.response,
        typeof resultData === "string" ? resultData : null
    ];

    let generatedText = null;
    for (const candidate of candidates) {
        const candidateText = extractTextContent(candidate);
        if (typeof candidateText === "string" && candidateText.trim()) {
            generatedText = candidateText.trim();
            break;
        }
    }

    if (!generatedText) {
        const returnedFields = resultData && typeof resultData === "object"
            ? Object.keys(resultData).join(", ")
            : typeof resultData;
        throw new Error(
            `Cloudflare Workers AI returned an empty or unexpected response format. Returned fields: ${returnedFields || "none"}`
        );
    }

    return generatedText;
}

// Gemini 2.5 Flash-Lite + built-in Google Search grounding.
// This is the selected Free Tier Search route (up to 500 RPD shared with
// Gemini 2.5 Flash, subject to the active project's quota and eligibility).
async function generateWithGeminiSearch(message, history) {
    if (!GEMINI_KEY) {
        throw new Error("Gemini API key missing. Add GEMINI_KEY in Render Environment.");
    }

    const priorMessages = sanitizeHistory(history, message);
    const contents = [
        ...priorMessages,
        {
            role: "user",
            parts: [{ text: message }]
        }
    ];

    const endpoint =
        `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_GEMINI_SEARCH}:generateContent`;

    const response = await fetch(endpoint, {
        method: "POST",
        headers: {
            "x-goog-api-key": GEMINI_KEY,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            systemInstruction: {
                parts: [{ text: SYSTEM_INSTRUCTION_INDRESH }]
            },
            contents,
            tools: [{ google_search: {} }],
            generationConfig: {
                temperature: 0.7,
                maxOutputTokens: 8192
            }
        })
    });

    let data;
    try {
        data = await response.json();
    } catch (parseError) {
        throw new Error(
            `Gemini Search returned an unreadable response (HTTP ${response.status}).`
        );
    }

    if (!response.ok) {
        const apiMessage =
            data?.error?.message ||
            data?.message ||
            `HTTP ${response.status}`;

        if (response.status === 429) {
            throw new Error(
                `Google Search quota/rate limit reached. The Free Tier allowance is up to 500 requests per day, shared by Gemini 2.5 Flash and Flash-Lite. Details: ${apiMessage}`
            );
        }

        if (
            response.status === 403 ||
            (response.status === 400 && /ground|search|tool|model/i.test(apiMessage))
        ) {
            throw new Error(
                `Google Search is unavailable for this API project/model or its current Free Tier access. Check the project's AI Studio quota and model access. Details: ${apiMessage}`
            );
        }

        throw new Error(`Gemini Search API HTTP ${response.status}: ${apiMessage}`);
    }

    const candidate = data?.candidates?.[0];
    const responseParts = candidate?.content?.parts || [];
    const answer = responseParts
        .filter((part) => typeof part.text === "string")
        .map((part) => part.text)
        .join("")
        .trim();

    if (!answer) {
        const blockReason = candidate?.finishReason || data?.promptFeedback?.blockReason;
        throw new Error(
            `Gemini Search returned no text${blockReason ? ` (reason: ${blockReason})` : ""}.`
        );
    }

    // Include source links from Google's grounding metadata in the existing
    // Markdown bubble so users can open the sources used in the answer.
    const groundingChunks =
        candidate?.groundingMetadata?.groundingChunks ||
        candidate?.groundingMetadata?.grounding_chunks ||
        [];

    const sources = [];
    const seenUrls = new Set();

    for (const chunk of groundingChunks) {
        const web = chunk?.web || chunk?.retrievedContext;
        const uri = web?.uri || web?.url;
        const title = (web?.title || web?.displayName || "Source")
            .replace(/[\[\]]/g, "");

        if (!uri || seenUrls.has(uri)) continue;

        try {
            const parsedUrl = new URL(uri);
            if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
                continue;
            }
            seenUrls.add(uri);
            sources.push(`- [${title}](${uri})`);
        } catch (e) {
            // Ignore malformed source URLs.
        }

        if (sources.length >= 6) break;
    }

    return sources.length
        ? `${answer}\n\n**Sources**\n${sources.join("\n")}`
        : answer;
}

// Main chat API
app.post("/api/chat", chatLimiter, async (req, res) => {
    const body = req.body || {};
    const message = typeof body.message === "string" ? body.message.trim() : "";
    const history = body.history;
    const requestedType =
        (typeof body.model === "string" ? body.model : "cloudflare-speed").toLowerCase();
    const searchEnabled =
        body.searchEnabled === true || requestedType === "gemini-search";

    if (!message) {
        return res.status(400).json({
            output: {
                role: "assistant",
                content: "Please enter a message."
            }
        });
    }

    // Search button overrides the selected Cloudflare mode only while ON.
    if (searchEnabled) {
        try {
            console.log(`Using Google Search model: ${MODEL_GEMINI_SEARCH}`);
            const text = await generateWithGeminiSearch(message, history);

            return res.json({
                output: {
                    role: "assistant",
                    content: text,
                    via: "Indresh"
                }
            });
        } catch (error) {
            console.error("Online Search Error:", error.message);
            const isQuotaError = /429|quota|rate.?limit/i.test(error.message);
            return res.json({
                output: {
                    role: "assistant",
                    content: isQuotaError
                        ? "⚠️ Online Search daily limit reached. Please try again later."
                        : "⚠️ Online Search is temporarily unavailable. Please try again shortly."
                }
            });
        }
    }

    // Offline mode is a UI placeholder for a future local model.
    if (
        requestedType === "offline" ||
        requestedType === "groq" ||
        requestedType.includes("turbo")
    ) {
        return res.json({
            output: {
                role: "assistant",
                content: "💻 Offline Mode is coming soon. This option will be available in a future update.",
                via: "Coming Soon"
            }
        });
    }

    try {
        // PRO MODE: Cloudflare-hosted NVIDIA Nemotron 3 Super 120B.
        if (
            requestedType.includes("pro") ||
            requestedType.includes("deep")
        ) {
            console.log(`Using Pro mode model: ${MODEL_CLOUDFLARE_PRO}`);

            const text = await generateWithCloudflare(
                MODEL_CLOUDFLARE_PRO,
                message,
                history,
                {
                    temperature: 1.0,
                    topP: 0.95,
                    maxCompletionTokens: 4096,
                    chatTemplateKwargs: {
                        enable_thinking: true,
                        low_effort: true
                    }
                }
            );

            return res.json({
                output: {
                    role: "assistant",
                    content: text,
                    via: "Indresh"
                }
            });
        }

        // SPEED MODE: Cloudflare-hosted Gemma 4.
        if (
            requestedType.includes("speed") ||
            requestedType.includes("flash") ||
            requestedType.includes("gemini") ||
            requestedType.includes("gemma")
        ) {
            console.log(`Using Speed mode model: ${MODEL_GEMMA_SPEED}`);

            const text = await generateWithCloudflare(
                MODEL_GEMMA_SPEED,
                message,
                history,
                {
                    temperature: 0.7,
                    maxCompletionTokens: 8192,
                    chatTemplateKwargs: {
                        enable_thinking: false
                    }
                }
            );

            return res.json({
                output: {
                    role: "assistant",
                    content: text,
                    via: "Indresh"
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

        let userMsg = "⚠️ Something went wrong. Please try again in a moment.";

        if (error.message.includes("404")) {
            userMsg = "⚠️ This response mode is temporarily unavailable. Please try again later.";
        } else if (error.message.includes("429")) {
            userMsg = "⚠️ The daily AI usage limit or capacity has been reached. Please try again later.";
        } else if (error.message.includes("403")) {
            userMsg = "⚠️ This response mode is not available for the current account.";
        }

        return res.json({
            output: {
                role: "assistant",
                content: userMsg
            }
        });
    }
});

// Lightweight health endpoint for diagnostics / optional Render health checks.
app.get("/healthz", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.status(200).json({ status: "ok" });
});

// Always fetch the latest HTML document. The service worker also uses
// network-first navigation so old UI markup cannot remain pinned in cache.
app.use((req, res, next) => {
    if (req.method === "GET" && (req.path === "/" || req.path === "/index.html")) {
        res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
        res.set("Pragma", "no-cache");
        res.set("Expires", "0");
    }
    next();
});

// Serve frontend
if (fs.existsSync(PUBLIC_DIR)) {
    app.use(express.static(PUBLIC_DIR, {
        etag: true,
        setHeaders: (res, filePath) => {
            if (path.basename(filePath) === "index.html") {
                res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
                res.setHeader("Pragma", "no-cache");
                res.setHeader("Expires", "0");
            }
        }
    }));
    app.get("/", (req, res) => {
        res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
        res.sendFile(path.join(PUBLIC_DIR, "index.html"));
    });
}

app.listen(PORT, () =>
    console.log(`Server running on port ${PORT}`)
);



