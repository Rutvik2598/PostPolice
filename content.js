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
   * Creates a verification button for a tweet.
   * @param {string} tweetText - The text of the tweet
   * @returns {Element} The button element
   */
  function createVerifyButton(tweetText) {
    const button = document.createElement("button");
    button.textContent = "Verify";
    button.style.backgroundColor = "#1d9bf0";
    button.style.color = "white";
    button.style.border = "none";
    button.style.borderRadius = "16px";
    button.style.padding = "4px 12px";
    button.style.fontSize = "12px";
    button.style.cursor = "pointer";
    button.style.marginLeft = "10px";
    button.style.marginTop = "5px";
    button.style.fontWeight = "bold";
    button.style.zIndex = "1000";

    button.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      button.disabled = true;
      button.textContent = "Verifying...";

      try {
        const response = await chrome.runtime.sendMessage({
          type: "VERIFY_TWEET",
          tweetText: tweetText
        });

        showVerificationResults(button, response);
      } catch (error) {
        console.error("Verification failed:", error);
        button.textContent = "Error";
      } finally {
        button.disabled = false;
        if (button.textContent === "Verifying...") button.textContent = "Verify";
      }
    });

    return button;
  }

  /**
   * Displays verification results near the button.
   * @param {Element} button - The verify button
   * @param {object} data - Verification results
   */
  function showVerificationResults(button, data) {
    // Remove existing results if any
    const existing = button.nextElementSibling;
    if (existing && existing.classList.contains("postpolice-results")) {
      existing.remove();
    }

    const container = document.createElement("div");
    container.className = "postpolice-results";
    container.style.marginTop = "10px";
    container.style.padding = "10px";
    container.style.backgroundColor = "#f7f9f9";
    container.style.borderRadius = "8px";
    container.style.border = "1px solid #cfd9de";
    container.style.fontSize = "13px";
    container.style.color = "#0f1419";
    container.style.maxWidth = "400px";

    const queryDiv = document.createElement("div");
    queryDiv.style.marginBottom = "8px";
    queryDiv.innerHTML = `<strong>Search Query:</strong> <em>${data.query}</em>`;
    container.appendChild(queryDiv);

    if (data.results && data.results.length > 0) {
      data.results.forEach(result => {
        const item = document.createElement("div");
        item.style.marginBottom = "8px";
        item.style.paddingBottom = "8px";
        item.style.borderBottom = "1px solid #eff3f4";

        const relevanceColor = result.relevance > 70 ? "green" : (result.relevance > 40 ? "orange" : "red");

        item.innerHTML = `
          <div style="font-weight: bold; margin-bottom: 2px;">
            <a href="${result.link}" target="_blank" style="text-decoration: none; color: #1d9bf0;">${result.title}</a>
          </div>
          <div style="font-size: 11px; color: #536471; margin-bottom: 4px;">${result.snippet}</div>
          <div style="font-size: 11px; font-weight: bold; color: ${relevanceColor};">
            Relevance: ${result.relevance}%
          </div>
        `;
        container.appendChild(item);
      });
    } else {
      const noResults = document.createElement("div");
      noResults.textContent = "No relevant results found.";
      container.appendChild(noResults);
    }

    // Insert after the button's container (usually the action bar or text)
    // We'll insert it after the button for simplicity in this implementation
    button.parentNode.insertBefore(container, button.nextSibling);
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

      // Add Verify button
      // We look for the tweet text to append the button after it, 
      // or we can append it to the tweet container.
      // Appending to the text element's parent ensures it flows with content.
      const button = createVerifyButton(element.textContent.trim());
      element.parentNode.appendChild(button);

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
