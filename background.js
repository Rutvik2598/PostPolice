// PostPolice Background Service Worker
// Handles AI analysis using Chrome's built-in Prompt API

let aiSession = null;
const GOOGLE_API_KEY = "AIzaSyAxbD3ACIptwLm_mEbiUzV5zN2URQDWmlg";
const SEARCH_ENGINE_ID = "80df139cf704047fd";

/**
 * Initializes Chrome's built-in AI session.
 * @returns {Promise<boolean>} True if AI is available and initialized
 */
async function initAI() {
  try {
    // Check if Chrome's built-in AI is available
    const languageModel = self.ai?.languageModel;

    if (!languageModel) {
      console.log("PostPolice: Chrome AI not available in background");
      return false;
    }

    // Check capabilities
    const capabilities = await languageModel.capabilities();
    console.log("PostPolice: AI capabilities:", capabilities);

    if (capabilities.available === "no") {
      console.log("PostPolice: Chrome AI model not available on this device");
      return false;
    }

    // Wait for model to be ready if it's downloading
    if (capabilities.available === "after-download") {
      console.log("PostPolice: Chrome AI model is downloading, please wait...");
    }

    // Create AI session
    aiSession = await languageModel.create({
      systemPrompt:
        "You are a helpful assistant that analyzes social media posts. You can generate search queries to verify claims and assess the relevance of search results to a given text.",
    });

    console.log("PostPolice: Chrome AI initialized successfully");
    return true;
  } catch (error) {
    console.log("PostPolice: Failed to initialize Chrome AI:", error.message);
    return false;
  }
}

/**
 * Generates a search query for a tweet using AI.
 * @param {string} tweetText - The text of the tweet
 * @returns {Promise<string>} The generated search query
 */
async function generateSearchQuery(tweetText) {
  if (!aiSession) await initAI();
  if (!aiSession) return tweetText; // Fallback to tweet text

  try {
    const prompt = `Generate a single, concise Google search query to verify the following claim or topic found in a tweet. Return ONLY the query, no other text:\n\nTweet: "${tweetText}"`;
    const response = await aiSession.prompt(prompt);
    return response.trim().replace(/^"|"$/g, ''); // Remove quotes if present
  } catch (error) {
    console.log("PostPolice: Query generation failed:", error);
    return tweetText;
  }
}

/**
 * Performs a Google Custom Search.
 * @param {string} query - The search query
 * @returns {Promise<Array>} Array of search results
 */
async function performSearch(query) {
  console.log("PostPolice: PerformSearch called with query:", query);

  if (!GOOGLE_API_KEY || !SEARCH_ENGINE_ID) {
    console.log("PostPolice: API Keys missing.");
    return [];
  }


  const url = `https://customsearch.googleapis.com/customsearch/v1?key=${GOOGLE_API_KEY}&cx=${SEARCH_ENGINE_ID}&q=${encodeURIComponent(query)}`;

  try {
    const response = await fetch(url);
    const data = await response.json();
    if (data.items) {
      return data.items.map(item => ({
        title: item.title,
        link: item.link,
        snippet: item.snippet
      }));
    }
    return [];
  } catch (error) {
    console.error("PostPolice: Search failed:", error);
    return [];
  }
}

/**
 * Calculates relevance of a search result to the tweet using AI.
 * @param {string} tweetText - The original tweet
 * @param {object} result - A search result object
 * @returns {Promise<number>} Relevance score (0-100)
 */
async function calculateRelevance(tweetText, result) {
  if (!aiSession) await initAI();
  // Simple heuristic fallback if AI fails or isn't ready
  if (!aiSession) return 50;

  try {
    const prompt = `Rate the relevance of the following search result to the tweet on a scale of 0 to 100. Return ONLY the number.\n\nTweet: "${tweetText}"\n\nSearch Result Title: "${result.title}"\nSearch Result Snippet: "${result.snippet}"`;
    const response = await aiSession.prompt(prompt);
    const score = parseInt(response.match(/\d+/)?.[0] || "50", 10);
    return Math.min(100, Math.max(0, score));
  } catch (error) {
    console.log("PostPolice: Relevance calculation failed:", error);
    return 50;
  }
}

/**
 * Analyzes tweets using Chrome's built-in AI.
 * @param {string[]} tweets - Array of tweet texts to analyze
 * @returns {Promise<string>} AI analysis response
 */
async function analyzeTweets(tweets) {
  if (!aiSession) {
    const initialized = await initAI();
    if (!initialized) {
      return "AI not available";
    }
  }

  try {
    const prompt = `Analyze these ${tweets.length} tweets and provide a brief summary of the main topics, overall sentiment, and any interesting patterns:\n\n${tweets
      .slice(0, 10)
      .map((t, i) => `${i + 1}. ${t}`)
      .join("\n\n")}`;

    console.log("PostPolice: Sending tweets to AI for analysis...");
    const response = await aiSession.prompt(prompt);
    return response;
  } catch (error) {
    console.log("PostPolice: AI analysis failed:", error.message);
    return "AI analysis failed: " + error.message;
  }
}

/**
 * Handles tweet verification.
 * @param {string} tweetText - The tweet to verify
 * @returns {Promise<object>} Verification results
 */
async function verifyTweet(tweetText) {
  console.log("PostPolice: Verifying tweet:", tweetText);
  const query = await generateSearchQuery(tweetText);
  console.log("PostPolice: Generated query:", query);

  const searchResults = await performSearch(query);
  console.log("PostPolice: Search results:", searchResults);

  const resultsWithRelevance = await Promise.all(searchResults.slice(0, 3).map(async (result) => {
    const relevance = await calculateRelevance(tweetText, result);
    return { ...result, relevance };
  }));

  // Sort by relevance
  resultsWithRelevance.sort((a, b) => b.relevance - a.relevance);

  return {
    query: query,
    results: resultsWithRelevance
  };
}

// Listen for messages from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "ANALYZE_TWEETS") {
    analyzeTweets(message.tweets).then((response) => {
      sendResponse({ analysis: response });
    });
    // Return true to indicate async response
    return true;
  }

  if (message.type === "CHECK_AI") {
    initAI().then((available) => {
      sendResponse({ available });
    });
    return true;
  }

  if (message.type === "VERIFY_TWEET") {
    verifyTweet(message.tweetText).then((results) => {
      sendResponse(results);
    });
    return true;
  }
});

// Initialize AI when extension loads
initAI();

console.log("PostPolice: Background service worker loaded");
