import { chromium } from "playwright";
import fetch from "node-fetch";

const TARGET = "https://www.ionos.co.uk/websites/website-builder";
const PLANS = ["Starter","Plus","Pro","Expert"];

// helpers
const GBP = /£\s*\d+(?:[.,]\d{1,2})?/;
const PER_MONTH = /£\s*\d+(?:[.,]\d{1,2})?\s*\/\s*month/i;
const INTRO_TERM = /for\s+(\d+)\s+months/i;
// allow variants: "Then only £X/month", "Thereafter £X/month", sometimes with extra words before "/month"
const RENEW_LINE = /(?:Then\s+only|Thereafter|Then)\s+£\s*\d+(?:[.,]\d{1,2})?.{0,40}?\/\s*month/i;

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

  // Handle cookie banner if present
  try {
    await page.locator('button:has-text("Accept all")').first().click({ timeout: 2000 });
  } catch {}
  try {
    await page.locator('button:has-text("Allow all")').first().click({ timeout: 2000 });
  } catch {}
  try {
    await page.locator('button:has-text("Accept")').first().click({ timeout: 2000 });
  } catch {}

  // Wait until we actually see a £/month anywhere
  await page.locator('text=/£\\s*\\d(?:[.,]\\d{1,2})?\\s*\\/\\s*month/i').first().waitFor({ timeout: 15000 });
  // Extra settling time for lazy blocks/animations
  await page.waitForTimeout(2500);

  // Collect candidate blocks from real DOM (not just innerText slice)
  const blocks = await page.evaluate(() => {
    const getText = (el) => (el.innerText || "").replace(/\s+/g, " ").trim();
    const candidates = [];
    const nodes = Array.from(document.querySelectorAll("section, article, div, li"));
    for (const n of nodes) {
      const t = getText(n);
      if (!t) continue;
      if (/(Starter|Plus|Pro|Expert)/i.test(t) && /£/.test(t) && /month/i.test(t) && t.length < 5000) {
        candidates.push(t);
      }
    }
    return candidates;
  });

  console.log("Candidate blocks found:", blocks.length);

  const out = [];
  for (const plan of PLANS) {
    const block = blocks.find((b) => new RegExp(`\\b${plan}\\b`, "i").test(b)) || "";
    if (!block) continue;

    const intro = (first(PER_MONTH, block) || "").replace(/\s+/g, "");
    const term = firstNum(INTRO_TERM, block) || "";
    const renewLine = first(RENEW_LINE, block) || "";
    const renew = (first(GBP, renewLine) || "").replace(/\s+/g, "");

    out.push({ plan, intro, term, renew, period: "/month", src: TARGET });
  }

  await browser.close();

  console.log("Extracted rows:");
  console.log(JSON.stringify(out, null, 2));

  const valid = out.filter((r) => r.intro || r.renew);
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
