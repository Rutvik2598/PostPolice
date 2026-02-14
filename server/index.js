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

// Metrics Counters
let cacheHits = 0;
let cacheMisses = 0;

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
            cacheHits++;
            console.log(`🟢 Cache HIT for key ${key.substring(0, 30)}...`);
            return res.json({ hit: true, summary: cached });
        }

        cacheMisses++;
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

        console.log("🤖 Proxying to Groq API (Summarize)...");

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
// POST /verify-fact
// Proxy to Groq API for Fact Verification
// Body: { claim: string, context: string }
// Returns: { verdict: string, reasoning: string }
// ------------------------------------
app.post("/verify-fact", async (req, res) => {
    try {
        const { claim, context } = req.body;
        if (!claim || !context) return res.status(400).json({ error: "claim and context are required" });

        console.log("🤖 Proxying to Groq API (Verify Fact)...");

        const systemPrompt = `You are a strict fact-checker. 
Compare the CLAIM against the EVIDENCE provided.
Return a JSON object with:
- "verdict": One of "VERIFIED", "FALSE", "UNCERTAIN"
- "reasoning": A short explanation (max 1 sentence)

Rules:
1. If evidence directly supports the claim -> VERIFIED
2. If evidence contradicts the claim -> FALSE
3. If evidence is unrelated or insufficient -> UNCERTAIN`;

        const userPrompt = `CLAIM: "${claim}"

EVIDENCE:
${context}

Verify the claim based ONLY on the evidence.`;

        const groqResponse = await fetch(GROQ_API_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${GROQ_API_KEY}`
            },
            body: JSON.stringify({
                model: "llama-3.1-8b-instant",
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userPrompt }
                ],
                temperature: 0.1,
                max_tokens: 256,
                response_format: { type: "json_object" }
            })
        });

        if (!groqResponse.ok) {
            const errText = await groqResponse.text();
            console.error("Groq API error:", groqResponse.status, errText);
            return res.status(groqResponse.status).json({ error: errText });
        }

        const data = await groqResponse.json();
        const content = data.choices?.[0]?.message?.content || "{}";
        console.log("✅ Groq returned verification:", content.substring(0, 100));

        let result = {};
        try {
            result = JSON.parse(content);
        } catch (e) {
            result = { verdict: "UNCERTAIN", reasoning: "Failed to parse API response" };
        }

        return res.json(result);
    } catch (err) {
        console.error("verify-fact error:", err.message);
        return res.status(500).json({ error: "verify-fact failed" });
    }
});

// ------------------------------------
// GET /metrics
// Returns: { cacheHits, cacheMisses, cacheKeys, memoryUsage }
// ------------------------------------
app.get("/metrics", async (req, res) => {
    try {
        const dbsize = await valkey.dbsize();
        const info = await valkey.info("memory");

        // Parse used_memory_human from INFO output
        const memoryMatch = info.match(/used_memory_human:(.*)/);
        const usedMemory = memoryMatch ? memoryMatch[1].trim() : "unknown";

        res.json({
            cacheHits,
            cacheMisses,
            totalKeys: dbsize,
            usedMemory: usedMemory
        });
    } catch (err) {
        console.error("metrics error:", err.message);
        res.status(500).json({ error: "metrics failed" });
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
