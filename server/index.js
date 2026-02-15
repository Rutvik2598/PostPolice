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
// POST /clear-cache
// Calls valkey.flushall()
// ------------------------------------
app.post("/clear-cache", async (req, res) => {
    try {
        await valkey.flushall();
        console.log("🧹 Cache cleared (FLUSHALL)");
        res.json({ success: true, message: "Cache cleared" });
    } catch (err) {
        console.error("clear-cache error:", err.message);
        res.status(500).json({ error: "failed to clear cache" });
    }
});

// ------------------------------------
// POST /reset-stats
// Resets hit/miss counters
// ------------------------------------
app.post("/reset-stats", (req, res) => {
    cacheHits = 0;
    cacheMisses = 0;
    console.log("📊 Stats reset");
    res.json({ success: true, message: "Stats reset" });
});

// ------------------------------------
// GET /metrics
// Returns: JSON or HTML Dashboard
// ------------------------------------
app.get("/metrics", async (req, res) => {
    try {
        const dbsize = await valkey.dbsize();
        const info = await valkey.info("memory");
        const memoryMatch = info.match(/used_memory_human:(.*)/);
        const usedMemory = memoryMatch ? memoryMatch[1].trim() : "unknown";

        const stats = {
            cacheHits,
            cacheMisses,
            totalKeys: dbsize,
            usedMemory: usedMemory,
            uptime: process.uptime()
        };

        // If requested from browser (Accept: text/html), serve a beautiful UI
        if (req.headers.accept && req.headers.accept.includes("text/html")) {
            const hitRate = stats.cacheHits + stats.cacheMisses > 0
                ? ((stats.cacheHits / (stats.cacheHits + stats.cacheMisses)) * 100).toFixed(1)
                : 0;

            return res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>PostPolice | Cache Metrics</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg: #0a0a0c;
            --card: #16161e;
            --accent: #7c4dff;
            --text: #ffffff;
            --text-dim: #a0a0b0;
            --success: #00e676;
            --error: #ff5252;
        }
        body {
            font-family: 'Inter', sans-serif;
            background: var(--bg);
            color: var(--text);
            margin: 0;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
        }
        .container {
            width: 100%;
            max-width: 800px;
            padding: 40px;
        }
        header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 40px;
        }
        h1 { font-weight: 800; margin: 0; letter-spacing: -1px; }
        .grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
            gap: 20px;
            margin-bottom: 40px;
        }
        .card {
            background: var(--card);
            padding: 24px;
            border-radius: 16px;
            border: 1px solid rgba(255,255,255,0.05);
            transition: transform 0.2s;
        }
        .card:hover { transform: translateY(-4px); }
        .label { color: var(--text-dim); font-size: 13px; font-weight: 600; text-transform: uppercase; margin-bottom: 8px; }
        .value { font-size: 32px; font-weight: 800; }
        .value.hits { color: var(--success); }
        .value.misses { color: var(--error); }
        .actions {
            display: flex;
            gap: 16px;
        }
        button {
            padding: 12px 24px;
            border-radius: 12px;
            border: none;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
            background: rgba(255,255,255,0.05);
            color: var(--text);
        }
        button:hover { background: rgba(255,255,255,0.1); }
        button.primary { background: var(--accent); }
        button.primary:hover { background: #6e40ff; padding: 12px 32px; }
        .status { margin-top: 20px; font-size: 14px; color: var(--text-dim); }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>PostPolice <span style="color:var(--accent)">Metrics</span></h1>
            <div class="uptime">Uptime: ${Math.floor(stats.uptime / 60)}m</div>
        </header>

        <div class="grid">
            <div class="card">
                <div class="label">Cache Hits</div>
                <div class="value hits">${stats.cacheHits}</div>
            </div>
            <div class="card">
                <div class="label">Cache Misses</div>
                <div class="value misses">${stats.cacheMisses}</div>
            </div>
            <div class="card">
                <div class="label">Hit Rate</div>
                <div class="value">${hitRate}%</div>
            </div>
            <div class="card">
                <div class="label">Total Keys</div>
                <div class="value">${stats.totalKeys}</div>
            </div>
            <div class="card">
                <div class="label">Memory Used</div>
                <div class="value">${stats.usedMemory}</div>
            </div>
        </div>

        <div class="actions">
            <button class="primary" onclick="doAction('/clear-cache')">Clear Cache</button>
            <button onclick="doAction('/reset-stats')">Reset Stats</button>
            <button onclick="location.reload()">Refresh Data</button>
        </div>

        <div class="status" id="status">Ready</div>
    </div>

    <script>
        async function doAction(endpoint) {
            const btn = event.target;
            const originalText = btn.innerText;
            btn.innerText = 'Processing...';
            btn.disabled = true;

            try {
                const res = await fetch(endpoint, { method: 'POST' });
                const data = await res.json();
                document.getElementById('status').innerText = data.message || 'Action completed';
                setTimeout(() => location.reload(), 1000);
            } catch (err) {
                document.getElementById('status').innerText = 'Error: ' + err.message;
                btn.innerText = originalText;
                btn.disabled = false;
            }
        }
    </script>
</body>
</html>
            `);
        }

        res.json(stats);
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

