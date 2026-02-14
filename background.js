// PostPolice Background Service Worker
// Handles AI analysis using Gemini Flash 2.0 API
// Extracts verifiable content summaries

const GEMINI_API_KEY = "AIzaSyCz9jvbY2zqbW2SYq-Hb9iWs6zAnal1Lmw";
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${GEMINI_API_KEY}`;

const SYSTEM_PROMPT = `You are an AI assistant that reads text and extracts a **concise summary of verifiable content**.

Guidelines:
1. Include only factual statements, news reports, or claims that can be verified later.
2. Ignore opinions, personal thoughts, jokes, speculation, or generic commentary.
3. Focus on content that could appear in a news article or report.
4. Summarize multiple statements into a short, coherent paragraph or bullet points.
5. Return only **verifiable information**, without interpretation or judgment about truth.
6. Keep the summary concise and clear, suitable for feeding to a search API for verification.

Example input:
"NASA launched a new satellite today. Many people are excited. The weather was sunny. Elon Musk tweeted about the launch."

Example output:
"- NASA launched a new satellite today.
- Elon Musk tweeted about the launch."`;

/**
 * Extracts verifiable content summary using Gemini API.
 * @param {string} content - Full text content to analyze
 * @returns {Promise<string>} Summary of verifiable content
 */
async function extractSummary(content) {
    try {
        const prompt = `Extract a concise summary of verifiable content from the following text. Return only factual statements and news that can be verified.

Text:
${content}

Verifiable summary:`;

        console.log("PostPolice: Calling Gemini API...");
        
        const response = await fetch(GEMINI_API_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                systemInstruction: {
                    parts: [{ text: SYSTEM_PROMPT }]
                },
                contents: [{
                    parts: [{ text: prompt }]
                }],
                generationConfig: {
                    temperature: 0.3,
                    maxOutputTokens: 1024,
                }
            })
        });

        if (!response.ok) {
            const error = await response.text();
            console.log("PostPolice: Gemini API error:", error);
            return "";
        }

        const data = await response.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
        console.log("PostPolice: Summary extracted successfully");
        return text.trim();
    } catch (error) {
        console.log("PostPolice: Extraction failed:", error.message);
        return "";
    }
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

    // Check AI availability (always available with API)
    if (message.type === "CHECK_AI") {
        sendResponse({ available: true });
        return true;
    }
});

console.log("PostPolice: Background service worker loaded (Gemini Flash API)");
