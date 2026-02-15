// PostPolice Background Service Worker
// Handles AI analysis via local cache server (Groq key stored server-side)
// Extracts verifiable content summaries and searches for verification

// Cache bridge server URL
const CACHE_SERVER_URL = "http://localhost:3000";

// Whitelisted credible news sources
const WHITELIST_DOMAINS = [
    "reuters.com",
    "apnews.com",
    "bbc.com",
    "bbc.co.uk",
    "nytimes.com",
    "theguardian.com",
    "washingtonpost.com",
    "npr.org",
    "aljazeera.com",
    "forbes.com",
    "bloomberg.com",
    "cnn.com",
    "nbcnews.com",
    "cbsnews.com",
    "abcnews.go.com",
    "usatoday.com",
    "politico.com",
    "thehill.com",
    "axios.com",
    "time.com",
    "economist.com",
    "ft.com",
    "wsj.com",
    "nature.com",
    "sciencedaily.com",
    "snopes.com",
    "factcheck.org",
    "politifact.com"
];

const SYSTEM_PROMPT = `You are an AI assistant that reads text and extracts a **concise summary of verifiable content**.

STRICT LIMIT: Return EXACTLY or FEWER than 5 bullet points. NEVER return more than 5.

Guidelines:
1. Include only factual statements, news reports, or claims that can be verified later.
2. Ignore opinions, personal thoughts, jokes, speculation, or generic commentary.
3. Focus on content that could appear in a news article or report.
4. Return ONLY the top 5 most important verifiable bullet points. NEVER EXCEED 5 BULLET POINTS.
5. Return only **verifiable information**, without interpretation or judgment about truth.
6. Keep the summary concise and clear, suitable for feeding to a search API for verification.

Example input:
"NASA launched a new satellite today. Many people are excited. The weather was sunny. Elon Musk tweeted about the launch."

Example output:
"- NASA launched a new satellite today.
- Elon Musk tweeted about the launch."`;

/**
 * Checks the Valkey cache for a previously generated summary.
 * @param {string} content - The content to look up
 * @returns {Promise<string|null>} Cached summary or null
 */
async function checkSummaryCache(content) {
    try {
        const response = await fetch(`${CACHE_SERVER_URL}/check-summary`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content })
        });
        if (!response.ok) return null;
        const data = await response.json();
        if (data.hit) {
            console.log("PostPolice: ✅ Cache HIT — skipping AI call");
            return data.summary;
        }
        console.log("PostPolice: Cache MISS — will call Groq proxy");
        return null;
    } catch (err) {
        console.log("PostPolice: Cache server unreachable, proceeding without cache:", err.message);
        return null;
    }
}

/**
 * Stores a content→summary pair in Valkey cache.
 * @param {string} content - The original content
 * @param {string} summary - The generated summary
 */
async function storeSummaryInCache(content, summary) {
    try {
        await fetch(`${CACHE_SERVER_URL}/cache-summary`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content, summary })
        });
        console.log("PostPolice: 💾 Summary stored in cache");
    } catch (err) {
        console.log("PostPolice: Could not store in cache:", err.message);
    }
}

/**
 * Extracts verifiable content summary via server proxy to Groq, with Valkey caching.
 * @param {string} content - Full text content to analyze
 * @returns {Promise<string>} Summary of verifiable content
 */
async function extractSummary(content) {
    try {
        // 1. Check cache first
        const cachedSummary = await checkSummaryCache(content);
        if (cachedSummary) {
            return cachedSummary;
        }

        // 2. Cache miss — call server's /summarize proxy
        const userPrompt = `Extract the top 5 most important verifiable facts from the following text. Return ONLY bullet points, maximum 5.\n\nText:\n${content}\n\nVerifiable summary (STRICTLY max 5 bullets):`;

        console.log("PostPolice: Calling Groq via server proxy...");
        console.log("PostPolice: Content length:", content.length);

        const response = await fetch(`${CACHE_SERVER_URL}/summarize`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ systemPrompt: SYSTEM_PROMPT, userPrompt })
        });

        console.log("PostPolice: Response status:", response.status);

        if (!response.ok) {
            const errText = await response.text();
            console.error("PostPolice: Summarize error:", response.status, errText);
            return "";
        }

        const data = await response.json();
        let summary = (data.summary || "").trim();

        // 3. ENFORCE 5 BULLET POINT LIMIT (Fallback if AI misses instruction)
        const bulletLines = summary.split(/\n/).filter(line => line.trim().startsWith("-") || line.trim().startsWith("•") || line.trim().startsWith("*"));
        if (bulletLines.length > 5) {
            console.log(`PostPolice: AI returned ${bulletLines.length} points, truncating to 5.`);
            summary = bulletLines.slice(0, 5).join("\n");
        }

        console.log("PostPolice: Summary extracted successfully, length:", summary.length);

        // 4. Store in cache for next time
        if (summary) {
            storeSummaryInCache(content, summary);
        }

        return summary;
    } catch (error) {
        console.error("PostPolice: Extraction failed:", error.message, error.stack);
        return "";
    }
}

// ============================================
// SEARCH FUNCTIONALITY (DuckDuckGo)
// ============================================

/**
 * Checks if a URL belongs to a whitelisted domain.
 * @param {string} url - URL to check
 * @returns {boolean} True if whitelisted
 */
function isWhitelistedUrl(url) {
    try {
        const hostname = new URL(url).hostname.toLowerCase();
        return WHITELIST_DOMAINS.some(domain =>
            hostname === domain || hostname.endsWith('.' + domain)
        );
    } catch {
        return false;
    }
}

/**
 * Searches DuckDuckGo and returns whitelisted results.
 * @param {string} query - Search query (the claim/summary to verify)
 * @param {number} maxResults - Maximum results to return (default 5)
 * @returns {Promise<Array<{title: string, url: string, snippet: string}>>}
 */
async function searchDuckDuckGo(query, maxResults = 5) {
    try {
        // Truncate query to first 150 chars to leave room for site filters
        const truncatedQuery = query.substring(0, 150);

        // Build site filter string for whitelisted domains
        const siteFilters = WHITELIST_DOMAINS.slice(0, 10) // Use top 10 to keep query reasonable
            .map(domain => `site:${domain}`)
            .join(" OR ");

        // Combine query with site filters
        const fullQuery = `${truncatedQuery} (${siteFilters})`;

        console.log("PostPolice: Searching DuckDuckGo for:", fullQuery);

        // Use DuckDuckGo HTML endpoint
        const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(fullQuery)}`;
        console.log("PostPolice: Search URL:", searchUrl);

        const response = await fetch(searchUrl, {
            method: "GET",
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
            }
        });

        console.log("PostPolice: DuckDuckGo response status:", response.status);

        if (!response.ok) {
            console.log("PostPolice: DuckDuckGo search failed:", response.status);
            return [];
        }

        const html = await response.text();

        // Log full HTML response for debugging
        console.log("=== DUCKDUCKGO FULL HTML RESPONSE ===");
        console.log(html);
        console.log("=== END HTML RESPONSE ===");

        // Parse search results from HTML
        const results = parseDuckDuckGoResults(html);

        console.log(`PostPolice: Found ${results.length} results`);

        return results.slice(0, maxResults);
    } catch (error) {
        console.log("PostPolice: Search error:", error.message);
        return [];
    }
}

/**
 * Parses DuckDuckGo HTML search results.
 * @param {string} html - HTML content from DuckDuckGo
 * @returns {Array<{title: string, url: string, snippet: string}>}
 */
function parseDuckDuckGoResults(html) {
    const results = [];

    console.log("PostPolice: HTML response length:", html.length);
    console.log("PostPolice: HTML sample:", html.substring(0, 500));

    // Alternative: Parse using result blocks
    const resultBlocks = html.split(/class="result\s/);
    console.log("PostPolice: Found", resultBlocks.length - 1, "result blocks");

    for (let i = 1; i < resultBlocks.length; i++) {
        const block = resultBlocks[i];

        // Extract URL - look for the actual link, not DDG redirect
        const urlMatch = block.match(/href="\/\/duckduckgo\.com\/l\/\?uddg=([^&"]+)/);
        const directUrlMatch = block.match(/class="result__url"[^>]*href="([^"]*)"/);

        let url = "";
        if (urlMatch) {
            url = decodeURIComponent(urlMatch[1]);
        } else if (directUrlMatch) {
            url = directUrlMatch[1];
            if (!url.startsWith("http")) {
                url = "https://" + url;
            }
        }

        // Extract title
        const titleMatch = block.match(/class="result__a"[^>]*>([^<]+)</);
        const title = titleMatch ? titleMatch[1].trim() : "";

        // Extract snippet
        const snippetMatch = block.match(/class="result__snippet"[^>]*>([^<]+)/);
        const snippet = snippetMatch ? snippetMatch[1].trim() : "";

        console.log(`PostPolice: Result ${i}: URL="${url.substring(0, 50)}", title="${title.substring(0, 30)}"`);

        if (url && title) {
            results.push({ url, title, snippet });
        }
    }

    console.log("PostPolice: Total parsed results:", results.length);
    if (results.length > 0) {
        console.log("PostPolice: All URLs found:", results.map(r => r.url));
    }

    return results;
}

/**
 * Searches for verification sources for a claim.
 * @param {string} claim - The claim to search for
 * @returns {Promise<{claim: string, sources: Array}>}
 */
async function searchForVerification(claim) {
    const sources = await searchDuckDuckGo(claim);
    return {
        claim,
        sources,
        searchedAt: Date.now()
    };
}

// Listen for messages from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Extract verifiable summary
    if (message.type === "EXTRACT_SUMMARY") {
        extractSummary(message.content).then((summary) => {
            sendResponse({ summary });
        });
        return true;
    }

    // Search for verification sources
    if (message.type === "SEARCH_CLAIM") {
        searchForVerification(message.claim).then((result) => {
            sendResponse(result);
        });
        return true;
    }

    // Verify a fact using Groq via server proxy
    if (message.type === "VERIFY_FACT") {
        console.log("PostPolice: Verifying fact via proxy...");
        fetch(`${CACHE_SERVER_URL}/verify-fact`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                claim: message.statement,
                // Simple context for now: just join the links. 
                // ideally we should fetch the content of these links first
                context: "Links provided: " + (message.links || []).join(", ")
            })
        })
            .then(res => res.json())
            .then(data => sendResponse(data))
            .catch(err => {
                console.error("PostPolice: Verify failed", err);
                sendResponse({ verdict: "UNCERTAIN", reasoning: "Verification server error" });
            });
        return true;
    }

    // Check AI availability (always available with API)
    if (message.type === "CHECK_AI") {
        sendResponse({ available: true });
        return true;
    }
});

console.log("PostPolice: Background service worker loaded (Valkey Cache + Groq Proxy)");
