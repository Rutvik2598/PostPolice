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

  // Store verification results (contains claims and their source links)
  const verificationResults = [];

  // Store all links organized by claim
  const claimLinks = [];

  // Expose globally for external access
  window.postPoliceSummaries = summaries;
  window.postPoliceVerifications = verificationResults;
  window.postPoliceLinks = claimLinks;

  // ============================================
  // VERIFICATION SEARCH
  // ============================================

  /**
   * Searches for verification sources for a claim.
   * @param {string} claim - The claim to search for
   * @returns {Promise<{claim: string, sources: Array}>}
   */
  async function searchForClaim(claim) {
    try {
      const response = await chrome.runtime.sendMessage({
        type: "SEARCH_CLAIM",
        claim: claim,
      });
      return response;
    } catch (error) {
      console.log("PostPolice: Search failed:", error.message);
      return { claim, sources: [] };
    }
  }

  /**
   * Fact-checks a claim using scraped links: fetches HTML from links and gets Gemini verdict.
   * @param {string} statement - The claim to verify
   * @param {string[]} links - URLs (e.g. from DuckDuckGo results)
   * @returns {Promise<{verdict: string, reasoning: string, raw: string, htmlSize: number}>}
   */
  async function verifyClaimWithLinks(statement, links) {
    try {
      const response = await chrome.runtime.sendMessage({
        type: "VERIFY_FACT",
        statement: statement,
        links: links,
      });
      return response || { verdict: "UNCERTAIN", reasoning: "No response", raw: "", htmlSize: 0 };
    } catch (error) {
      console.log("PostPolice: Fact check failed:", error.message);
      return { verdict: "UNCERTAIN", reasoning: error.message, raw: "", htmlSize: 0 };
    }
  }

  /**
   * Searches for verification sources for all stored summaries.
   * Call this from console: window.postPoliceVerify()
   */
  async function verifyAllSummaries() {
    console.log("PostPolice: Starting verification for", summaries.length, "summaries...");

    for (let i = 0; i < summaries.length; i++) {
      const summary = summaries[i];
      console.log(`\nPostPolice: Searching for summary ${i + 1}/${summaries.length}...`);
      console.log("Summary:", summary.summary.substring(0, 100) + "...");

      const result = await searchForClaim(summary.summary);

      verificationResults.push({
        summaryIndex: i,
        summary: summary.summary,
        sources: result.sources,
        searchedAt: result.searchedAt,
      });

      if (result.sources.length > 0) {
        console.log(`Found ${result.sources.length} sources from credible news sites:`);
        result.sources.forEach((source, j) => {
          console.log(`  ${j + 1}. ${source.title}`);
          console.log(`     URL: ${source.url}`);
          console.log(`     Snippet: ${source.snippet}`);
        });
      } else {
        console.log("No sources found from whitelisted news sites.");
      }
    }

    console.log("\n=== Verification Complete ===");
    console.log("Results stored in window.postPoliceVerifications");
    return verificationResults;
  }

  // Expose verify function globally
  window.postPoliceVerify = verifyAllSummaries;
  window.postPoliceSearch = searchForClaim;

  // ============================================
  // TEXT EXTRACTION
  // ============================================

  function shouldIgnoreElement(element) {
    if (!element || !element.tagName) return true;

    for (const selector of IGNORE_SELECTORS) {
      try {
        if (element.matches(selector)) return true;
        if (element.closest(selector)) return true;
      } catch (e) { }
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
        const summaryObj = {
          summary: summary,
          timestamp: Date.now(),
          url: window.location.href,
        };
        summaries.push(summaryObj);

        console.log("=== PostPolice: Verifiable Content Summary ===");
        console.log(summary);
        console.log("==============================================");

        // Split summary into individual claims (by newlines or bullet points)
        // STRICTLY LIMIT TO TOP 5 CLAIMS
        const claims = summary
          .split(/\n|(?=- )/)
          .map(line => line.replace(/^[-•*]\s*/, '').trim())
          .filter(line => line.length > 10)
          .slice(0, 5);

        console.log(`\nPostPolice: Found ${claims.length} individual claims to verify (max 5 enforced)`);

        // Search for each claim separately, then fact-check using scraped links
        for (let i = 0; i < claims.length; i++) {
          const claim = claims[i];
          console.log(`\n--- Searching claim ${i + 1}/${claims.length}: "${claim.substring(0, 60)}..." ---`);

          const searchResult = await searchForClaim(claim);

          // Extract just the URLs from sources
          const links = searchResult.sources.map(source => source.url);

          // Store claim with its links
          const claimLinkObj = {
            claim: claim,
            links: links,
            sources: searchResult.sources,
            searchedAt: searchResult.searchedAt,
          };
          claimLinks.push(claimLinkObj);

          const verificationObj = {
            summaryIndex: summaries.length - 1,
            claim: claim,
            sources: searchResult.sources,
            searchedAt: searchResult.searchedAt,
          };
          verificationResults.push(verificationObj);

          if (searchResult.sources.length > 0) {
            console.log(`Found ${searchResult.sources.length} sources:`);
            searchResult.sources.forEach((source, j) => {
              console.log(`  ${j + 1}. ${source.title}`);
              console.log(`     URL: ${source.url}`);
            });
            console.log(`Links array: [${links.join(', ')}]`);

            // Fact-check: fetch HTML from links and get Gemini verdict
            console.log(`PostPolice: Fact-checking claim against ${links.length} link(s)...`);
            const verdictResult = await verifyClaimWithLinks(claim, links);
            claimLinkObj.verdict = verdictResult.verdict;
            claimLinkObj.reasoning = verdictResult.reasoning;
            claimLinkObj.raw = verdictResult.raw;
            claimLinkObj.htmlSize = verdictResult.htmlSize;
            verificationObj.verdict = verdictResult.verdict;
            verificationObj.reasoning = verdictResult.reasoning;
            verificationObj.raw = verdictResult.raw;
            verificationObj.htmlSize = verdictResult.htmlSize;
            console.log(`PostPolice: Verdict for claim: ${verdictResult.verdict}`);
            console.log(`PostPolice: Reasoning: ${verdictResult.reasoning || '(none)'}`);
          } else {
            console.log("No sources found for this claim.");
          }

          // Small delay between searches to avoid rate limiting
          if (i < claims.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        }

        console.log("\n=== PostPolice: Verification Complete ===");
        console.log("All claim links and verdicts stored in window.postPoliceLinks and window.postPoliceVerifications");
        claimLinks.forEach((item, idx) => {
          console.log(`  Claim ${idx + 1}: ${item.verdict || "—"} | ${(item.claim || "").substring(0, 50)}...`);
        });
        console.log(claimLinks);
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
