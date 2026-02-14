/**
 * Test script for factChecker.js
 *
 * Usage:
 *   node testFactChecker.js              # run all tests (fetch + full fact check)
 *   node testFactChecker.js --fetch-only # only test HTML fetch/concat (no Gemini API)
 */

const { verifyFact, fetchAndConcatHtml, verifyWithGemini } = require("./factChecker.js");

const TEST_URL = "https://www.cnn.com/2022/03/08/india/indian-students-stuck-sumy-ukraine-intl-hnk-dst/index.html";
const STATEMENT_ON_PAGE = "Sumy evacuation successfully completed";

function log(msg, data = null) {
  console.log(msg);
  if (data != null) console.log(data);
}

async function testFetchAndConcat() {
  console.log("\n--- Test 1: fetchAndConcatHtml ---");
  const links = [TEST_URL];
  const blob = await fetchAndConcatHtml(links);
  const hasSource = blob.includes("SOURCE: " + TEST_URL);
  const hasHtml = blob.includes("<") && blob.includes(">"); // looks like HTML
  if (!blob || blob.length < 100) throw new Error("Expected non-empty HTML blob");
  if (!hasSource) throw new Error("Expected SOURCE marker in blob");
  if (!hasHtml) throw new Error("Expected page content in blob (HTML-like)");
  log("OK: Fetched and concatenated HTML, size =", blob.length + " chars");
  return blob;
}

async function testVerifyWithGemini(htmlBlob) {
  console.log("\n--- Test 2: verifyWithGemini (mock HTML) ---");
  const smallHtml = `<html><body><p>${STATEMENT_ON_PAGE}</p></body></html>`;
  const result = await verifyWithGemini(STATEMENT_ON_PAGE, smallHtml);
  const validVerdict = ["TRUE", "FALSE", "UNCERTAIN"].includes(result.verdict);
  if (!validVerdict) throw new Error("Invalid verdict: " + result.verdict);
  if (!result.raw) throw new Error("Expected raw response");
  log("OK: Verdict =", result.verdict);
  log("   Reasoning:", result.reasoning || "(none)");
  return result;
}

async function testVerifyFactFull() {
  console.log("\n--- Test 3: verifyFact (full flow) ---");
  const result = await verifyFact(STATEMENT_ON_PAGE, [TEST_URL]);
  const validVerdict = ["TRUE", "FALSE", "UNCERTAIN"].includes(result.verdict);
  if (!validVerdict) throw new Error("Invalid verdict: " + result.verdict);
  if (typeof result.htmlSize !== "number") throw new Error("Expected htmlSize");
  log("OK: Full flow completed");
  log("   Statement:", STATEMENT_ON_PAGE);
  log("   Verdict:", result.verdict);
  log("   Reasoning:", result.reasoning || "(none)");
  log("   HTML size:", result.htmlSize);
  return result;
}

async function testInvalidInputs() {
  console.log("\n--- Test 4: invalid inputs ---");
  try {
    await verifyFact("", ["https://example.com"]);
    throw new Error("Should have thrown for empty statement");
  } catch (e) {
    if (!e.message.includes("required")) throw e;
    log("OK: Rejects empty statement");
  }
  try {
    await verifyFact("Some fact", []);
    throw new Error("Should have thrown for no links");
  } catch (e) {
    if (!e.message.includes("required")) throw e;
    log("OK: Rejects empty links");
  }
}

async function run(skipApi = false) {
  console.log("PostPolice factChecker.js – test run");
  const start = Date.now();

  try {
    await testFetchAndConcat();
    await testInvalidInputs();

    if (!skipApi) {
      await testVerifyWithGemini("<html><body>test</body></html>");
      await testVerifyFactFull();
    } else {
      console.log("\n(Skipping Gemini API tests; use without --fetch-only to run full tests)");
    }

    console.log("\n--- All tests passed ---");
    console.log("Duration:", Date.now() - start, "ms");
  } catch (err) {
    console.error("\nTest failed:", err.message);
    if (err.message.includes("Gemini API") || err.message.includes("fetch")) {
      console.error("Tip: Run with --fetch-only to test only HTML fetch (no API key needed for example.com).");
    }
    process.exit(1);
  }
}

const skipApi = process.argv.includes("--fetch-only");
run(skipApi);
