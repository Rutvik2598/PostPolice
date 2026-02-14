/**
 * PostPolice Fact Checker
 * Fetches HTML from given links, concatenates them, and uses Gemini API
 * to verify whether a fact statement is true or false based on the content.
 *
 * Usage (Node.js):
 *   node factChecker.js "fact statement" "url1" "url2" "url3"
 *   node factChecker.js --statement "fact" --urls "url1" "url2"
 *
 * Usage as module:
 *   const { verifyFact } = require('./factChecker');
 *   const result = await verifyFact(statement, links);
 */

(function () {
  "use strict";

  // const GEMINI_API_KEY = "AIzaSyCSfEBPGkFQN7XNewBhadTRqb8KLnSag7E";
  const GEMINI_API_KEY = "AIzaSyCz9jvbY2zqbW2SYq-Hb9iWs6zAnal1Lmw";
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`;

// Max HTML size to send to Gemini (to avoid token limits; ~1M chars ≈ 250k tokens)
const MAX_HTML_SIZE = 500_000;

const VERIFICATION_PROMPT = `You are a fact-checker. You will be given:
1. A FACT STATEMENT to verify
2. HTML content from one or more web pages (raw HTML, possibly from multiple sources)

Your task: Determine if the FACT STATEMENT is TRUE or FALSE based SOLELY on the provided HTML content.

Rules:
- Base your answer ONLY on evidence found in the provided HTML. Do not use external knowledge.
- If the HTML clearly supports the statement, answer TRUE.
- If the HTML clearly contradicts the statement, answer FALSE.
- If the HTML does not contain enough information to verify, answer UNCERTAIN.

Respond in this exact format:
VERDICT: [TRUE | FALSE | UNCERTAIN]`;

/**
 * Fetches HTML content from a URL.
 * @param {string} url - The URL to fetch
 * @returns {Promise<string>} The HTML content
 */
async function fetchHtml(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const html = await res.text();
    return html;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetches HTML from multiple URLs and concatenates them into one blob.
 * @param {string[]} links - Array of URLs
 * @returns {Promise<string>} Concatenated HTML with separators
 */
async function fetchAndConcatHtml(links) {
  const chunks = [];

  for (const url of links) {
    try {
      const html = await fetchHtml(url);
      chunks.push(`\n\n<!-- ========== SOURCE: ${url} ========== -->\n\n${html}`);
    } catch (err) {
      chunks.push(
        `\n\n<!-- ========== SOURCE: ${url} - FETCH FAILED: ${err.message} ========== -->\n\n`
      );
    }
  }

  let blob = chunks.join("");
  if (blob.length > MAX_HTML_SIZE) {
    blob = blob.slice(0, MAX_HTML_SIZE) + "\n\n<!-- ... TRUNCATED ... -->";
  }
  return blob;
}

/**
 * Calls Gemini API to verify a fact statement against the HTML blob.
 * @param {string} statement - The fact statement to verify
 * @param {string} htmlBlob - Concatenated HTML content
 * @returns {Promise<{ verdict: string, reasoning: string, raw: string }>}
 */
async function verifyWithGemini(statement, htmlBlob) {
  const prompt = `FACT STATEMENT TO VERIFY:
"${statement}"

HTML CONTENT (from one or more web pages):
${htmlBlob}

Based ONLY on the HTML above, is the fact statement TRUE, FALSE, or UNCERTAIN?
Respond in the required format:`;

  const response = await fetch(GEMINI_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: VERIFICATION_PROMPT + "\n\n" + prompt }] }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 1024,
      },
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini API error: ${response.status} - ${errText}`);
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";

  const verdictMatch = text.match(/VERDICT:\s*(TRUE|FALSE|UNCERTAIN)/i);
  const reasoningMatch = text.match(/REASONING:\s*(.+?)(?=\n\n|$)/is);

  return {
    verdict: verdictMatch ? verdictMatch[1].toUpperCase() : "UNCERTAIN",
    reasoning: reasoningMatch ? reasoningMatch[1].trim() : "",
    raw: text.trim(),
  };
}

/**
 * Main entry: fetches HTML from links, concatenates, and verifies the fact.
 * @param {string} statement - The fact statement to verify
 * @param {string[]} links - Array of URLs to fetch HTML from
 * @returns {Promise<{ verdict: string, reasoning: string, raw: string, htmlSize: number }>}
 */
async function verifyFact(statement, links) {
  if (!statement || !links?.length) {
    throw new Error("Statement and at least one link are required");
  }

  const htmlBlob = await fetchAndConcatHtml(links);
  const result = await verifyWithGemini(statement, htmlBlob);
  return {
    ...result,
    htmlSize: htmlBlob.length,
  };
}

// CLI usage
if (typeof require !== "undefined" && require.main === module) {
  const args = process.argv.slice(2);
  let statement = "";
  const urls = [];

  if (args.includes("--statement") && args.includes("--urls")) {
    const sIdx = args.indexOf("--statement");
    const uIdx = args.indexOf("--urls");
    statement = args[sIdx + 1] || "";
    urls.push(...(args[uIdx + 1] || "").split(",").map((u) => u.trim()));
  } else if (args.length >= 2) {
    statement = args[0];
    urls.push(...args.slice(1));
  }

  if (!statement || urls.length === 0) {
    console.error(`Usage:
  node factChecker.js "fact statement" "url1" "url2" ...
  node factChecker.js --statement "fact" --urls "url1,url2,url3"`);
    process.exit(1);
  }

  verifyFact(statement, urls)
    .then((result) => {
      console.log("\n=== PostPolice Fact Check ===\n");
      console.log("Statement:", statement);
      console.log("Sources:", urls.length, "URL(s)");
      console.log("HTML size:", result.htmlSize, "chars");
      console.log("\nVERDICT:", result.verdict);
      console.log("REASONING:", result.reasoning);
      console.log("\n--- Raw response ---\n", result.raw);
    })
    .catch((err) => {
      console.error("Error:", err.message);
      process.exit(1);
    });
}

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { verifyFact, fetchAndConcatHtml, verifyWithGemini };
  } else if (typeof self !== "undefined") {
    self.postPoliceFactChecker = { verifyFact, fetchAndConcatHtml, verifyWithGemini };
  }
})();
