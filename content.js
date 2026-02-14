// PostPolice Content Script
// Extracts tweet text from Twitter/X and monitors for new tweets

(function () {
  "use strict";

  // Selector for tweet text elements (Twitter's data-testid attribute)
  const TWEET_TEXT_SELECTOR = '[data-testid="tweetText"]';

  // Debounce delay in milliseconds (1 second)
  const DEBOUNCE_DELAY = 1000;

  // Highlight color for detected tweets
  const HIGHLIGHT_COLOR = "rgba(29, 155, 240, 0.1)"; // Twitter blue with transparency
  const HIGHLIGHT_BORDER = "2px solid rgba(29, 155, 240, 0.5)";

  // Timer ID for debouncing
  let debounceTimer = null;

  // Track the last logged tweet count to avoid redundant logs
  let lastLoggedCount = 0;

  // Set to track already highlighted elements
  const highlightedElements = new WeakSet();

  // Track if AI is available
  let aiAvailable = false;

  /**
   * Checks if Chrome AI is available via background script.
   */
  async function checkAI() {
    try {
      const response = await chrome.runtime.sendMessage({ type: "CHECK_AI" });
      aiAvailable = response?.available || false;
      console.log("PostPolice: AI available:", aiAvailable);
    } catch (error) {
      console.log("PostPolice: Could not check AI status:", error.message);
      aiAvailable = false;
    }
  }

  /**
   * Analyzes tweets using Chrome's built-in AI via background script.
   * @param {string[]} tweets - Array of tweet texts to analyze
   */
  async function analyzeTweetsWithAI(tweets) {
    if (!aiAvailable || tweets.length === 0) return;

    try {
      console.log("PostPolice: Sending tweets to AI for analysis...");
      const response = await chrome.runtime.sendMessage({
        type: "ANALYZE_TWEETS",
        tweets: tweets,
      });

      if (response?.analysis) {
        console.log("=== PostPolice: AI Analysis ===");
        console.log(response.analysis);
      }
    } catch (error) {
      console.log("PostPolice: AI analysis failed:", error.message);
    }
  }

  /**
   * Checks if a tweet is an ad.
   * @param {Element} element - The tweet text element
   * @returns {boolean} True if the tweet is an ad
   */
  function isAdTweet(element) {
    const tweetContainer = element.closest("article");
    if (!tweetContainer) return false;
    
    // Check for "Ad" text in the tweet container
    // Twitter ads typically have a span with "Ad" text
    const adIndicators = tweetContainer.querySelectorAll('span');
    for (const span of adIndicators) {
      const text = span.textContent?.trim();
      if (text === "Ad" || text === "Promoted") {
        return true;
      }
    }
    return false;
  }

  /**
   * Applies highlight styling to a tweet element.
   * @param {Element} element - The tweet text element to highlight
   */
  function highlightTweet(element) {
    // Skip ads
    if (isAdTweet(element)) {
      return;
    }

    // Find the parent tweet container (article element)
    const tweetContainer = element.closest("article");
    if (tweetContainer && !highlightedElements.has(tweetContainer)) {
      tweetContainer.style.backgroundColor = HIGHLIGHT_COLOR;
      tweetContainer.style.border = HIGHLIGHT_BORDER;
      tweetContainer.style.borderRadius = "12px";
      tweetContainer.style.transition = "background-color 0.3s ease";
      highlightedElements.add(tweetContainer);
    }
  }

  /**
   * Extracts text content from all visible tweets on the page.
   * @returns {string[]} Array of tweet text strings
   */
  function extractTweetTexts() {
    const tweetElements = document.querySelectorAll(TWEET_TEXT_SELECTOR);
    const tweetTexts = [];

    tweetElements.forEach((element) => {
      // Skip ads
      if (isAdTweet(element)) {
        return;
      }

      // Get the text content, trimming whitespace
      const text = element.textContent?.trim();
      if (text) {
        tweetTexts.push(text);
        // Highlight the tweet
        highlightTweet(element);
      }
    });

    return tweetTexts;
  }

  /**
   * Logs the current tweets to the console.
   * Only logs if there's a change in tweet count.
   */
  async function logTweets() {
    const tweets = extractTweetTexts();
    const tweetCount = tweets.length;

    // Only log if the count has changed (new tweets loaded)
    if (tweetCount !== lastLoggedCount) {
      console.log("=== PostPolice: Tweet Update ===");
      console.log(`Total tweets visible: ${tweetCount}`);

      if (tweets.length > 0) {
        console.log("Newest tweet text:", tweets[0]);
        console.log("All tweet texts:", tweets);

        // Analyze with AI if available
        await analyzeTweetsWithAI(tweets);
      }

      lastLoggedCount = tweetCount;
    }
  }

  /**
   * Debounced version of logTweets.
   * Ensures logging happens at most once per DEBOUNCE_DELAY milliseconds.
   */
  function debouncedLogTweets() {
    // Clear any existing timer
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }

    // Set a new timer
    debounceTimer = setTimeout(() => {
      logTweets();
      debounceTimer = null;
    }, DEBOUNCE_DELAY);
  }

  /**
   * Sets up a MutationObserver to detect when new tweets are loaded.
   */
  function setupMutationObserver() {
    // Create observer that watches for DOM changes
    const observer = new MutationObserver((mutations) => {
      // Check if any mutation might have added new tweets
      let shouldCheck = false;

      for (const mutation of mutations) {
        // Check for added nodes that might contain tweets
        if (mutation.addedNodes.length > 0) {
          shouldCheck = true;
          break;
        }
      }

      // If potential new content was added, trigger debounced logging
      if (shouldCheck) {
        debouncedLogTweets();
      }
    });

    // Start observing the document body for changes
    observer.observe(document.body, {
      childList: true, // Watch for added/removed child elements
      subtree: true, // Watch the entire subtree
    });

    console.log("PostPolice: MutationObserver is now watching for new tweets");

    return observer;
  }

  /**
   * Initialize the extension
   */
  async function init() {
    console.log("PostPolice: Extension loaded on", window.location.href);

    // Check if Chrome's built-in AI is available
    await checkAI();

    // Initial extraction and logging
    await logTweets();

    // Set up observer for dynamic content
    setupMutationObserver();
  }

  // Run initialization when the DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    // DOM is already ready
    init();
  }
})();
