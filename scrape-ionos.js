import { chromium } from "playwright";
import fetch from "node-fetch";

const TARGET = "https://www.ionos.co.uk/websites/website-builder";
const PLANS = ["Starter", "Plus", "Pro", "Expert"];

// regex helpers
const GBP = /£\s*\d+(?:[.,]\d{1,2})?/;
const PER_MONTH_ALL = /£\s*\d+(?:[.,]\d{1,2})?\s*\/\s*month/gi;
const INTRO_TERM = /for\s+(\d+)\s+months/i;
// allow variants: "Then only £X/month", "Thereafter £X/month", sometimes with extra words before "/month"
const RENEW_LINE = /(?:Then\s+only|Thereafter|Then)\s+£\s*\d+(?:[.,]\d{1,2})?.{0,40}?\/\s*month/i;

function first(re, s) { const m = s.match(re); return m ? m[0] : ""; }
function firstNum(re, s) { const m = s.match(re); return m ? m[1] : ""; }
function numericVal(p) {
  const m = p.match(/£\s*(\d+(?:[.,]\d{1,2})?)/);
  return m ? parseFloat(m[1].replace(",", ".")) : NaN;
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

  // Ensure prices are visible
  await page.locator('text=/£\\s*\\d(?:[.,]\\d{1,2})?\\s*\\/\\s*month/i').first().waitFor({ timeout: 15000 });
  await page.waitForTimeout(2500); // settle lazy/animated content

  const results = [];

  for (const plan of PLANS) {
    // Find the plan heading (no XPath; use CSS + hasText)
    const heading = page.locator('h1,h2,h3,h4').filter({
      hasText: new RegExp(`\\b${plan}\\b`, "i"),
    }).first();

    if (!(await heading.count())) {
      console.warn(`No heading found for ${plan}`);
      continue;
    }

    // Climb ancestors to the tightest container that looks like the plan card
    const containerText = await heading.evaluate((el) => {
      function txt(node) { return (node.innerText || "").replace(/\s+/g, " ").trim(); }
      let node = el;
      let best = "";
      let bestScore = -1;
      for (let i = 0; i < 8 && node; i++) {
        const t = txt(node);
        if (t) {
          const poundCount = (t.match(/£\s*\d/g) || []).length;
          const hasMonth = /month/i.test(t);
          const hasCart = /Add to cart/i.test(t);
          // Prefer compact sections with 1–3 prices + "month" + "Add to cart"; penalise massive blobs
          const score = (hasMonth ? 3 : 0) + (hasCart ? 2 : 0) + Math.min(poundCount, 3) - (t.length > 6000 ? 5 : 0);
          if (score > bestScore) { best = t; bestScore = score; }
        }
        node = node.parentElement;
      }
      return best;
    });

    if (!containerText) {
      console.warn(`No container text for ${plan}`);
      continue;
    }

    // Collect monthly prices within this plan’s container
    const priceMatches = [];
    let m;
    while ((m = PER_MONTH_ALL.exec(containerText)) !== null) {
      priceMatches.push({ value: m[0].replace(/\s+/g, ""), index: m.index });
    }

    const termMatch = containerText.match(INTRO_TERM);
    const term = termMatch ? termMatch[1] : "";

    let intro = "";
    let renew = "";

    if (termMatch && priceMatches.length) {
      // Choose the monthly price immediately BEFORE "for N months"
      const termIndex = termMatch.index;
      const before = priceMatches.filter(p => p.index <= termIndex);
      if (before.length) {
        const nearest = before.reduce((a, b) => (b.index > a.index ? b : a));
        intro = nearest.value;
      }
    }

    // Renewal: explicit “Then only £X/month” wins
    const renewLine = first(RENEW_LINE, containerText);
    const renewFromLine = (renewLine.match(GBP)?.[0] || "").replace(/\s+/g, "");

    if (!intro && priceMatches.length) {
      // No term nearby → smaller price = intro, larger = renew
      const sorted = [...priceMatches].sort((a, b) => numericVal(a.value) - numericVal(b.value));
      if (sorted.length >= 2) {
        intro = sorted[0].value;
        renew = sorted[sorted.length - 1].value;
      } else {
        intro = sorted[0].value;
      }
    } else if (intro && priceMatches.length >= 2 && !renewLine) {
      // We have an intro → pick a different price as renew (prefer larger)
      const others = priceMatches.map(p => p.value).filter(v => v !== intro);
      if (others.length) renew = others.sort((a,b) => numericVal(a)-numericVal(b))[others.length - 1];
    }

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
