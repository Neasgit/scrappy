import { chromium } from "playwright";
import fetch from "node-fetch";

const TARGET = "https://www.ionos.co.uk/websites/website-builder";
const PLANS = ["Starter","Plus","Pro","Expert"];

// helpers
const GBP = /£\s*\d+(?:[.,]\d{1,2})?/;
const PER_MONTH = /£\s*\d+(?:[.,]\d{1,2})?\s*\/\s*month/i;
const INTRO_TERM = /for\s+(\d+)\s+months/i;
const RENEW_LINE = /(?:Then\s+only|Thereafter|Then)\s+£\s*\d+(?:[.,]\d{1,2})?\s*\/\s*month/i;

function clean(s) { return (s || "").replace(/\s+/g, " ").trim(); }
function first(re, s) { const m = s.match(re); return m ? m[0] : ""; }
function firstNum(re, s) { const m = s.match(re); return m ? m[1] : ""; }

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

  // Wait until we actually see a pound sign or plan text on the page
  await page.waitForFunction(
    () =>
      document.body && /£|Starter|Plus|Pro|Expert/i.test(document.body.innerText),
    { timeout: 15000 }
  );

  // Some content is lazy/animated; give it a moment
  await page.waitForTimeout(2000);

  // Collect candidate blocks from real DOM (not just innerText slice)
  const blocks = await page.evaluate(() => {
    const getText = (el) => (el.innerText || "").replace(/\s+/g, " ").trim();
    const candidates = [];
    const nodes = Array.from(document.querySelectorAll("section, article, div, li"));
    for (const n of nodes) {
      const t = getText(n);
      if (!t) continue;
      // A good candidate contains a plan name + a price/month reference
      if (/(Starter|Plus|Pro|Expert)/i.test(t) && /£/.test(t) && /month/i.test(t)) {
        // keep it short-ish per block to avoid swallowing the whole page
        if (t.length < 4000) candidates.push(t);
      }
    }
    return candidates;
  });

  console.log("Candidate blocks found:", blocks.length);

  const out = [];
  for (const plan of PLANS) {
    // find the first block that clearly belongs to the plan
    const block = blocks.find((b) => new RegExp(`\\b${plan}\\b`, "i").test(b)) || "";
    if (!block) continue;

    const intro = first(PER_MONTH, block).replace(/\s+/g, "");
    const term = firstNum(INTRO_TERM, block);
    const renewLine = first(RENEW_LINE, block);
    const renew = first(GBP, renewLine).replace(/\s+/g, "");

    out.push({ plan, intro, term, renew, period: "/month", src: TARGET });
  }

  await browser.close();

  // Debug logging
  console.log("Extracted rows:");
  console.log(JSON.stringify(out, null, 2));

  // If nothing sensible, bail so we don't blank the sheet
  const valid = out.filter((r) => r.intro || r.renew);
  if (!valid.length) {
    console.error("No prices parsed — page markup or wording may have changed.");
    process.exit(2);
  }

  const hook = process.env.SHEET_WEBHOOK;
  if (!hook) {
    console.error("Missing SHEET_WEBHOOK env var.");
    process.exit(3);
  }

  console.log(`Sending ${valid.length} rows to Google Sheet…`);
  const res = await fetch(hook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(valid),
  });
  console.log("Sheet:", await res.text());
})();
