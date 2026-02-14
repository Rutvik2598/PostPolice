// PostPolice Content Script
// Extracts verifiable content from any webpage using local AI
// Logs summary to console

(function () {
  "use strict";

  // ============================================
  // CONFIGURATION
  // ============================================

  // Selectors for content elements to extract text from
  const CONTENT_SELECTORS = [
    "p",
    "span",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "li",
    "td",
    "th",
    "blockquote",
    "article",
    "section",
    '[data-testid="tweetText"]', // Twitter/X specific
  ];

  // Selectors for elements to ignore
  const IGNORE_SELECTORS = [
    "script",
    "style",
    "noscript",
    "nav",
    "header",
    "footer",
    "aside",
    "iframe",
    "svg",
    "canvas",
    "video",
    "audio",
    ".nav",
    ".navbar",
    ".header",
    ".footer",
    ".sidebar",
    ".menu",
    ".ad",
    ".advertisement",
    '[role="navigation"]',
    '[role="banner"]',
    '[role="contentinfo"]',
  ];

  // Minimum text length to consider for analysis
  const MIN_TEXT_LENGTH = 20;

  // Debounce delay for MutationObserver (ms)
  const DEBOUNCE_DELAY = 2000;

  // ============================================
  // STATE
  // ============================================

  let aiAvailable = false;
  const processedNodes = new WeakSet();
  let debounceTimer = null;
  let isProcessing = false;

  // Store summaries for verification
  const summaries = [];

  // Expose summaries globally for external access
  window.postPoliceSummaries = summaries;

  // ============================================
  // TEXT EXTRACTION
  // ============================================

  function shouldIgnoreElement(element) {
    if (!element || !element.tagName) return true;

    for (const selector of IGNORE_SELECTORS) {
      try {
        if (element.matches(selector)) return true;
        if (element.closest(selector)) return true;
      } catch (e) {}
    }

    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") {
      return true;
    }

    return false;
  }

  function getDirectTextContent(element) {
    let text = "";
    for (const node of element.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.textContent;
      }
    }
    if (!text.trim()) {
      text = element.textContent || "";
    }
    return text;
  }

  function extractVisibleText() {
    const results = [];
    const selector = CONTENT_SELECTORS.join(", ");
    const elements = document.querySelectorAll(selector);

    elements.forEach((element) => {
      if (processedNodes.has(element)) return;
      if (shouldIgnoreElement(element)) return;

      const text = getDirectTextContent(element).trim();
      if (text.length < MIN_TEXT_LENGTH) return;

      results.push({ element, text });
    });

    return results;
  }

  // ============================================
  // LLM INTERACTION
  // ============================================

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

  async function extractSummaryWithAI(content) {
    if (!aiAvailable || !content) {
      return "";
    }

    try {
      console.log(`PostPolice: Analyzing content (${content.length} chars)...`);
      const response = await chrome.runtime.sendMessage({
        type: "EXTRACT_SUMMARY",
        content: content,
      });

      return response?.summary || "";
    } catch (error) {
      console.log("PostPolice: Summary extraction failed:", error.message);
      return "";
    }
  }

  // ============================================
  // MAIN PROCESSING
  // ============================================

  async function scanPage() {
    if (isProcessing || !aiAvailable) return;
    isProcessing = true;

    console.log("PostPolice: Scanning page for verifiable content...");

    try {
      const elements = extractVisibleText();
      console.log(`PostPolice: Found ${elements.length} text elements`);

      if (elements.length === 0) {
        isProcessing = false;
        return;
      }

      // Mark elements as processed
      elements.forEach(({ element }) => processedNodes.add(element));

      // Combine all text content
      const fullContent = elements.map(({ text }) => text).join("\n\n");
      console.log(`PostPolice: Combined content: ${fullContent.length} chars`);

      // Extract summary using AI
      const summary = await extractSummaryWithAI(fullContent);

      if (summary) {
        // Store summary in array for verification
        summaries.push({
          summary: summary,
          timestamp: Date.now(),
          url: window.location.href,
        });

        console.log("=== PostPolice: Verifiable Content Summary ===");
        console.log(summary);
        console.log("Stored in window.postPoliceSummaries array");
        console.log("==============================================");
      } else {
        console.log("PostPolice: No verifiable content found");
      }
    } catch (error) {
      console.log("PostPolice: Error scanning page:", error.message);
    }

    isProcessing = false;
  }

  // ============================================
  // MUTATION OBSERVER
  // ============================================

  function debouncedScan() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      scanPage();
      debounceTimer = null;
    }, DEBOUNCE_DELAY);
  }

  function setupMutationObserver() {
    const observer = new MutationObserver((mutations) => {
      let hasNewContent = false;

      for (const mutation of mutations) {
        if (mutation.addedNodes.length > 0) {
          for (const node of mutation.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE) {
              const element = node;
              if (
                CONTENT_SELECTORS.some((sel) => {
                  try {
                    return element.matches(sel) || element.querySelector(sel);
                  } catch {
                    return false;
                  }
                })
              ) {
                hasNewContent = true;
                break;
              }
            }
          }
        }
        if (hasNewContent) break;
      }

      if (hasNewContent) {
        debouncedScan();
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    console.log("PostPolice: MutationObserver active for dynamic content");
    return observer;
  }

  // ============================================
  // INITIALIZATION
  // ============================================

  async function init() {
    console.log("PostPolice: Initializing on", window.location.href);

    await checkAI();

    if (!aiAvailable) {
      console.log("PostPolice: AI not available, extension disabled");
      return;
    }

    await scanPage();
    setupMutationObserver();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
