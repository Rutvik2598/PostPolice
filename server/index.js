require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const Valkey = require("iovalkey");

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

const PORT = 3000;
const TTL_SECONDS = 600; // 10 minutes

// Connect to local Valkey instance
const valkey = new Valkey({
    host: "127.0.0.1",
    port: 6379,
    lazyConnect: true,
    retryStrategy(times) {
        if (times > 3) return null; // stop retrying after 3 attempts
        return Math.min(times * 200, 2000);
    },
});

valkey
    .connect()
    .then(() => console.log("✅ Connected to Valkey"))
    .catch((err) => console.error("❌ Valkey connection failed:", err.message));

// ------------------------------------
// Utility: hash content to a cache key
// ------------------------------------
function hashContent(content) {
    return "summary:" + crypto.createHash("sha256").update(content).digest("hex");
}

// ------------------------------------
// POST /check-summary
// Body: { content: string }
// Returns: { hit: boolean, summary?: string }
// ------------------------------------
app.post("/check-summary", async (req, res) => {
    try {
        const { content } = req.body;
        if (!content) return res.status(400).json({ error: "content is required" });

        const key = hashContent(content);
        const cached = await valkey.get(key);

        if (cached) {
            console.log(`🟢 Cache HIT for key ${key.substring(0, 30)}...`);
            return res.json({ hit: true, summary: cached });
        }

        console.log(`🔴 Cache MISS for key ${key.substring(0, 30)}...`);
        return res.json({ hit: false });
    } catch (err) {
        console.error("check-summary error:", err.message);
        return res.status(500).json({ error: "cache check failed" });
    }
});

// ------------------------------------
// POST /cache-summary
// Body: { content: string, summary: string }
// Returns: { stored: boolean }
// ------------------------------------
app.post("/cache-summary", async (req, res) => {
    try {
        const { content, summary } = req.body;
        if (!content || !summary) {
            return res.status(400).json({ error: "content and summary are required" });
        }

        const key = hashContent(content);
        await valkey.set(key, summary, "EX", TTL_SECONDS);

        console.log(`💾 Cached summary for key ${key.substring(0, 30)}... (TTL: ${TTL_SECONDS}s)`);
        return res.json({ stored: true });
    } catch (err) {
        console.error("cache-summary error:", err.message);
        return res.status(500).json({ error: "cache store failed" });
    }
});

// ------------------------------------
// POST /summarize
// Proxy to Groq API (keeps key server-side)
// Body: { systemPrompt: string, userPrompt: string }
// Returns: { summary: string }
// ------------------------------------
app.post("/summarize", async (req, res) => {
    try {
        const { systemPrompt, userPrompt } = req.body;
        if (!userPrompt) return res.status(400).json({ error: "userPrompt is required" });

        console.log("🤖 Proxying to Groq API...");

        const groqResponse = await fetch(GROQ_API_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${GROQ_API_KEY}`
            },
            body: JSON.stringify({
                model: "llama-3.1-8b-instant",
                messages: [
                    { role: "system", content: systemPrompt || "Extract verifiable facts." },
                    { role: "user", content: userPrompt }
                ],
                temperature: 0.3,
                max_tokens: 1024
            })
        });

        if (!groqResponse.ok) {
            const errText = await groqResponse.text();
            console.error("Groq API error:", groqResponse.status, errText);
            return res.status(groqResponse.status).json({ error: errText });
        }

        const data = await groqResponse.json();
        const summary = data.choices?.[0]?.message?.content || "";
        console.log("✅ Groq returned summary, length:", summary.length);
        return res.json({ summary: summary.trim() });
    } catch (err) {
        console.error("summarize error:", err.message);
        return res.status(500).json({ error: "summarize failed" });
    }
});

// ------------------------------------
// GET /health
// ------------------------------------
app.get("/health", async (req, res) => {
    try {
        await valkey.ping();
        res.json({ status: "ok", valkey: "connected" });
    } catch {
        res.json({ status: "ok", valkey: "disconnected" });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 PostPolice Cache Server running on http://localhost:${PORT}`);
});
