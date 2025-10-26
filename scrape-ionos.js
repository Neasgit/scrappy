import { chromium } from "playwright";
import fetch from "node-fetch";

const TARGET = "https://www.ionos.co.uk/websites/website-builder";
const PLANS = ["Starter","Plus","Pro","Expert"];

// regex helpers
const GBP = /£\s*\d+(?:[.,]\d{1,2})?/;
const PER_MONTH_ALL = /£\s*\d+(?:[.,]\d{1,2})?\s*\/\s*month/gi;
const INTRO_TERM = /for\s+(\d+)\s+months/i;
// allow variants: "Then only £X/month", "Thereafter £X/month", sometimes with extra words before "/month"
const RENEW_LINE = /(?:Then\s+only|Thereafter|Then)\s+£\s*\d+(?:[.,]\d{1,2})?.{0,40}?\/\s*month/i;

function idxOfNearestPriceBefore(termIndex, priceMatches) {
  // priceMatches: array of {value, index}
  const before = priceMatches.filter(p => p.index <= termIndex);
  if (!before.length) return -1;
  // nearest = greatest index <= termIndex
  let best = 0;
  for (let i = 1; i < before.length; i++) {
    if (before[i].index > before[best].index) best = i;
  }
  return priceMatches.indexOf(before[best]); // position in original array
}
function numericVal(p) {
  const m = p.match(/£\s*(\d+(?:[.,]\d{1,2})?)/);
  if (!m) return NaN;
  return parseFloat(m[1].replace(",", "."));
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: "en-GB",
    timezoneId: "Europe/London",
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141 Safari/537.36",
  });
  const page = await context.newPage();

  console.log("Opening:", TARGET);
  await page.goto(TARGET, { waitUntil: "networkidle" });

  // Dismiss cookie banners if present
  for (const label of ["Accept all", "Allow all", "Accept"]) {
    try { await page.locator(`button:has-text("${label}")`).first().click({ timeout: 1500 }); } catch {}
  }

  // Wait until we actually see a £/month anywhere
  await page.locator('text=/£\\s*\\d(?:[.,]\\d{1,2})?\\s*\\/\\s*month/i').first().waitFor({ timeout: 15000 });
  await page.waitForTimeout(2500); // settle animations/lazy blocks

  // Collect candidate blocks from the DOM
  const blocks = await page.evaluate(() => {
    const getText = (el) => (el.innerText || "").replace(/\s+/g, " ").trim();
    const out = [];
    const nodes = Array.from(document.querySelectorAll("section, article, div, li"));
    for (const n of nodes) {
      const t = getText(n);
      if (!t) continue;
      if (/(Starter|Plus|Pro|Expert)/i.test(t) && /£/.test(t) && /month/i.test(t) && t.length < 6000) {
        out.push(t);
      }
    }
    return out;
  });

  console.log("Candidate blocks found:", blocks.length);

  const results = [];
  for (const plan of PLANS) {
    const block = blocks.find(b => new RegExp(`\\b${plan}\\b`, "i").test(b)) || "";
    if (!block) continue;

    // Gather all monthly prices with their string indices
    const priceMatches = [];
    let m;
    while ((m = PER_MONTH_ALL.exec(block)) !== null) {
      priceMatches.push({ value: m[0].replace(/\s+/g, ""), index: m.index });
    }

    // Find intro term (N months)
    const termMatch = block.match(INTRO_TERM);
    const term = termMatch ? termMatch[1] : "";

    let intro = "";
    let renew = "";

    if (termMatch && priceMatches.length) {
      // prefer price nearest before "for N months"
      const termIndex = termMatch.index;
      const idx = idxOfNearestPriceBefore(termIndex, priceMatches);
      if (idx >= 0) intro = priceMatches[idx].value;
    }

    // Renewal: explicit "Then only £X/month" (or similar)
    const renewLine = block.match(RENEW_LINE)?.[0] || "";
    const renewFromLine = (renewLine.match(GBP)?.[0] || "").replace(/\s+/g, "");

    // Fallback resolution between multiple prices:
    // If we have 2+ monthly prices and intro picked one, choose the "other" as renewal.
    // When ambiguous, pick the larger as renewal, smaller as intro.
    if (!intro && priceMatches.length) {
      // No term nearby — use heuristic: smaller = intro, larger = renew.
      const sorted = [...priceMatches].sort((a, b) => numericVal(a.value) - numericVal(b.value));
      if (sorted.length >= 2) {
        intro = sorted[0].value;
        renew = sorted[sorted.length - 1].value;
      } else {
        intro = sorted[0].value;
      }
    } else if (intro && priceMatches.length >= 2 && !renewLine) {
      // We had an intro; pick another distinct price for renew (prefer larger)
      const others = priceMatches.map(p => p.value).filter(v => v !== intro);
      if (others.length) {
        renew = others.sort((a,b) => numericVal(a)-numericVal(b))[others.length - 1];
      }
    }

    // If explicit renew line exists, let it win.
    if (renewFromLine) renew = renewFromLine;

    results.push({ plan, intro, term, renew, period: "/month", src: TARGET });
  }

  await browser.close();

  console.log("Extracted rows:");
  console.log(JSON.stringify(results, null, 2));

  const valid = results.filter(r => r.intro || r.renew);
  if (!valid.length) {
    console.error("No prices parsed — possible markup/text change.");
    process.exit(2);
  }

  const hook = process.env.SHEET_WEBHOOK;
  if (!hook) { console.error("Missing SHEET_WEBHOOK env var."); process.exit(3); }

  console.log(`Sending ${valid.length} rows to Google Sheet…`);
  const res = await fetch(hook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(valid),
  });
  console.log("Sheet:", await res.text());
})();
