import { chromium } from "playwright";
import fetch from "node-fetch";

const TARGET = "https://www.ionos.co.uk/websites/website-builder";
const PLANS = ["Starter", "Plus", "Pro"];
const GBP = /£\s*\d+(?:[.,]\d{1,2})?/;
const PER_MONTH_ALL = /£\s*\d+(?:[.,]\d{1,2})?\s*\/\s*month/gi;
const INTRO_TERM = /for\s+(\d+)\s+months?/i;
const RENEW_LINE = /(?:Then\s+only|Thereafter|Then|After\s+promo|After\s+\d+\s+months)\s+£\s*\d+(?:[.,]\d{1,2})?.{0,40}?\/\s*month/i;

const fmtMoney = (s) => {
  if (!s) return "";
  // normalize spaces around the pound and before "per month"
  // examples in → "£ 6/month", "£10/month", "£ 10 per month"
  let t = s.replace(/\s+/g, " ").trim();
  // collapse "£ 6" → "£6"
  t = t.replace(/£\s+(\d)/g, "£$1");
  // ensure " per month" spacing
  t = t.replace(/\s*\/\s*month/i, " per month");
  t = t.replace(/(£\d+(?:[.,]\d{1,2})?)(?!\sper month)/i, "$1");
  return t;
};

function first(re, s) { const m = s.match(re); return m ? m[0] : ""; }
function numericVal(p) { const m = p.match(/£\s*(\d+(?:[.,]\d{1,2})?)/); return m ? parseFloat(m[1]) : NaN; }

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale:"en-GB", timezoneId:"Europe/London" });
  const page = await context.newPage();
  await page.goto(TARGET, { waitUntil:"networkidle" });

  for (const label of ["Accept all","Allow all","Accept"]) {
    try { await page.locator(`button:has-text("${label}")`).first().click({ timeout: 1500 }); } catch {}
  }

  await page.locator('text=/£\\s*\\d.*\\/\\s*month/i').first().waitFor({ timeout:15000 });
  await page.waitForTimeout(2000);

  const rows = [];
  for (const plan of PLANS) {
    const heading = page.locator('h1,h2,h3,h4').filter({ hasText:new RegExp(`\\b${plan}\\b`, "i") }).first();
    if (!(await heading.count())) continue;

    const containerText = await heading.evaluate(el=>{
      const txt=n=> (n.innerText||"").replace(/\s+/g," ").trim();
      let node=el,best="",bestScore=-1;
      for(let i=0;i<8&&node;i++){
        const t=txt(node);
        if(t){
          const pound=(t.match(/£\s*\d/g)||[]).length,hasMonth=/month/i.test(t),hasCart=/Add to cart/i.test(t);
          const s=(hasMonth?3:0)+(hasCart?2:0)+Math.min(pound,3)-(t.length>6000?5:0);
          if(s>bestScore){best=t;bestScore=s;}
        }
        node=node.parentElement;
      }
      return best;
    });
    if(!containerText) continue;

    const priceMatches=[...containerText.matchAll(PER_MONTH_ALL)].map(m=>({value:m[0].replace(/\s+/g," "),index:m.index}));
    const termMatch=containerText.match(INTRO_TERM);
    const duration=termMatch?`${termMatch[1]} months`:"";

    let introductoryOffer="", standardPrice="";
    if(termMatch&&priceMatches.length){
      const before=priceMatches.filter(p=>p.index<=termMatch.index);
      if(before.length){ introductoryOffer = fmtMoney(before.at(-1).value); }
    }

    const renewLine=first(RENEW_LINE,containerText);
    const renewRaw=(renewLine.match(GBP)?.[0]||"");
    if (renewRaw) standardPrice = fmtMoney(renewRaw + " per month");

    if(!introductoryOffer&&priceMatches.length){
      const sorted=[...priceMatches].sort((a,b)=>numericVal(a.value)-numericVal(b.value));
      if(sorted.length>=2){ introductoryOffer=fmtMoney(sorted[0].value); standardPrice=fmtMoney(sorted.at(-1).value); }
      else introductoryOffer=fmtMoney(sorted[0].value);
    } else if(introductoryOffer&&!standardPrice&&priceMatches.length>=2){
      const others=priceMatches.map(p=>p.value).filter(v=>fmtMoney(v)!==introductoryOffer);
      if(others.length) standardPrice=fmtMoney(others.sort((a,b)=>numericVal(a)-numericVal(b)).at(-1));
    }

    rows.push({ plan, introductoryOffer, duration, standardPrice, src:TARGET });
  }

  console.log("Extracted rows:", JSON.stringify(rows,null,2));

  const valid=rows.filter(r=>r.introductoryOffer||r.standardPrice);
  if(!valid.length){ console.error("No prices parsed."); process.exit(2); }

  const hook=process.env.SHEET_WEBHOOK;
  const token=process.env.WEBHOOK_TOKEN;
  if(!hook||!token){ console.error("Missing SHEET_WEBHOOK or WEBHOOK_TOKEN."); process.exit(3); }

  const res=await fetch(`${hook}?token=${encodeURIComponent(token)}`,{
    method:"POST",
    headers:{ "Content-Type":"application/json", "x-auth":token },
    body:JSON.stringify(valid)
  });
  console.log("Sheet:",await res.text());
})();
