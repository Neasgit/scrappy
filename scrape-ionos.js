import { chromium } from "playwright";
import fetch from "node-fetch";

const TARGET = "https://www.ionos.co.uk/websites/website-builder";
const PLANS = ["Starter","Plus","Pro","Expert"];

function grab(r, s){ const m = s.match(r); return m ? m[0] : ""; }
function grabNum(r, s){ const m = s.match(r); return m ? m[1] : ""; }

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(TARGET, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);

  const txt = await page.evaluate(() => document.body.innerText.replace(/\s+/g," "));
  const out = [];

  for (const plan of PLANS) {
    const i = txt.search(new RegExp(`\\b${plan}\\b`, "i"));
    if (i === -1) continue;
    const win = txt.slice(Math.max(0, i - 800), Math.min(txt.length, i + 1800));
    const intro = grab(/£\s*\d+(?:[.,]\d{1,2})?\s*\/\s*month/i, win).replace(/\s+/g,"");
    const term  = grabNum(/for\s+(\d+)\s+months/i, win);
    const renew = grab(/£\s*\d+(?:[.,]\d{1,2})?(?=.*Then\s+only)/i, win).replace(/\s+/g,"");
    out.push({ plan, intro, term, renew, period:"/month", src: TARGET });
  }

  await browser.close();

  if (!out.length) { console.error("No prices found."); process.exit(2); }

  const hook = process.env.SHEET_WEBHOOK;
  if (!hook) { console.error("Missing SHEET_WEBHOOK env var."); process.exit(3); }

  const res = await fetch(hook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(out)
  });
  console.log("Sheet:", await res.text());
})();
