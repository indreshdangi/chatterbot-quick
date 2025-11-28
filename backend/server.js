// backend/server.js

// ULTIMATE DEBUG VERSION

// इसमें हम Env Variables पर भरोसा नहीं करेंगे, सीधे कोड में Key डालेंगे।



const express = require("express");

const cors = require("cors");

const path = require("path");

const { GoogleGenerativeAI } = require("@google/generative-ai");

const fetch = require("node-fetch");



const app = express();

app.use(cors());

app.use(express.json({ limit: "4mb" }));



const PUBLIC_DIR = path.join(__dirname, "..", "public");



// ⚠️⚠️⚠️ यहाँ अपनी असली API KEY पेस्ट करो (Quotes के अंदर) ⚠️⚠️⚠️

// टेस्ट के बाद इसे हटा देना!

const DIRECT_GEMINI_KEY = "AIzaSyBk-ZK0yhYfZxyJufNmG8Sd67uTbcc608k"; 



const genAI = new GoogleGenerativeAI(DIRECT_GEMINI_KEY);



app.post("/api/chat", async (req, res) => {

  try {

    const message = req.body.message || "";

    const modelKey = req.body.model || "";

    

    console.log("User asked:", message);

    console.log("Frontend sent model:", modelKey);



    // अगर यूजर ने Gemini मांगा है (या Frontend ने कुछ भी भेजा हो)

    // हम जबरदस्ती Gemini ही चलाएंगे टेस्ट के लिए

    if (modelKey.includes("gemini") || modelKey.includes("2.5")) {

        

        console.log("Attemping Gemini with HARDCODED Key...");

        

        // सबसे सुरक्षित मॉडल (Pro) use करेंगे जो कभी fail नहीं होता

        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });



        const result = await model.generateContent(message);

        const response = await result.response;

        const text = response.text();



        return res.json({ output: { role: "assistant", content: text, via: "gemini-test-mode" } });

    }



    // Fallback to Groq logic here... (अगर Groq भी चाहिए तो)

    return res.json({ output: { role: "assistant", content: "Groq testing disabled for now. Only testing Gemini.", via: "system" } });



  } catch (error) {

    console.error("GEMINI FATAL ERROR:", error);

    // यह Error सीधे Chat में दिखेगा ताकि हमें पता चले क्या हुआ

    return res.json({ output: { role: "assistant", content: `❌ ERROR: ${error.message}`, via: "error-log" } });

  }

});



if (require("fs").existsSync(PUBLIC_DIR)) {

  app.use(express.static(PUBLIC_DIR));

  app.get("/", (req,res) => res.sendFile(path.join(PUBLIC_DIR,"index.html")));

}



app.listen(3000, () => console.log("Test Server Running..."));
