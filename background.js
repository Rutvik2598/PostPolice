// PostPolice Background Service Worker
// Handles AI analysis using Chrome's built-in Prompt API
// Detects verifiable claims and factual statements

let aiSession = null;

/**
 * Initializes Chrome's built-in AI session.
 * @returns {Promise<boolean>} True if AI is available and initialized
 */
async function initAI() {
    try {
        // Check if Chrome's built-in AI is available (use LanguageModel directly)
        if (typeof LanguageModel === "undefined") {
            console.log("PostPolice: Chrome AI not available in background");
            return false;
        }

        // Check availability
        const availability = await LanguageModel.availability();
        console.log("PostPolice: AI availability:", availability);

        if (availability === "unavailable") {
            console.log("PostPolice: Chrome AI model not available on this device");
            return false;
        }

        if (availability === "downloading") {
            console.log("PostPolice: Chrome AI model is still downloading...");
            return false;
        }

        // Create AI session with system prompt for extracting verifiable content
        aiSession = await LanguageModel.create({
            systemPrompt: `You are an AI assistant that reads text and extracts a **concise summary of verifiable content**.

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
- Elon Musk tweeted about the launch."`,
            expectedInputLanguages: ["en"],
            expectedOutputLanguages: ["en"],
        });

        console.log("PostPolice: Chrome AI initialized successfully");
        return true;
    } catch (error) {
        console.log("PostPolice: Failed to initialize Chrome AI:", error.message);
        return false;
    }
}

/**
 * Extracts verifiable content summary from text.
 * @param {string} content - Full text content to analyze
 * @returns {Promise<string>} Summary of verifiable content
 */
async function extractSummary(content) {
    if (!aiSession) {
        const initialized = await initAI();
        if (!initialized) {
            return "";
        }
    }

    try {
        const prompt = `Extract a concise summary of verifiable content from the following text. Return only factual statements and news that can be verified.

Text:
${content}

Verifiable summary:`;

        console.log("PostPolice: Extracting verifiable content...");
        const response = await aiSession.prompt(prompt);
        return response.trim();
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

    // Check AI availability
    if (message.type === "CHECK_AI") {
        initAI().then((available) => {
            sendResponse({ available });
        });
        return true;
    }
});

// Initialize AI when extension loads
initAI();

console.log("PostPolice: Background service worker loaded");
