// PostPolice Background Service Worker
// Handles AI analysis using Chrome's built-in Prompt API

let aiSession = null;

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
        "You are a helpful assistant that analyzes social media posts. Provide brief, insightful analysis of the content, sentiment, and any notable patterns. Keep responses concise.",
    });

    console.log("PostPolice: Chrome AI initialized successfully");
    return true;
  } catch (error) {
    console.log("PostPolice: Failed to initialize Chrome AI:", error.message);
    return false;
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
});

// Initialize AI when extension loads
initAI();

console.log("PostPolice: Background service worker loaded");
