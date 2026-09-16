import http from "node:http"; import fs from "node:fs"; import { chromium } from "playwright"; import AxeBuilder from "@axe-core/playwright";
let n = 0;
const S = [
  { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "run_python", arguments: JSON.stringify({ code: "import matplotlib.pyplot as plt\nplt.bar([1,2],[3,4])\nprint('hi')" }) } }] },
  { content: "<think>done</think>## Result\n| a | b |\n|---|---|\n| 1 | 2 |\n\n[link](https://example.com)" },
];
const srv = http.createServer(async (q, r) => {
  if (q.url.startsWith("/v1/chat")) { for await (const _ of q); const m = S[Math.min(n++, 1)]; r.writeHead(200, { "Content-Type": "application/json" }); return r.end(JSON.stringify({ choices: [{ message: { role: "assistant", ...m } }] })); }
  r.writeHead(200, { "Content-Type": "text/html" }); r.end(fs.readFileSync(new URL("../index.html", import.meta.url)));
});
await new Promise(x => srv.listen(8768, x));
const b = await chromium.launch(); const p = await (await b.newContext()).newPage();
p.on("pageerror", e => console.log("[pageerror]", e.message));
const scan = async (label) => {
  const r = await new AxeBuilder({ page: p }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"]).analyze();
  console.log(`\n=== ${label}: ${r.violations.length} violation types`);
  for (const v of r.violations) console.log(`- [${v.impact}] ${v.id}: ${v.help}\n    ` + v.nodes.slice(0, 4).map(x => x.target.join(" ") + (x.failureSummary ? " :: " + x.failureSummary.split("\n").slice(1, 2).join("") : "")).join("\n    "));
};
await p.goto("http://localhost:8768/");
await p.waitForFunction(() => document.getElementById("pytext").textContent.startsWith("Python ready"), null, { timeout: 180000 });
await scan("initial");
console.log("settings collapsed by default:", await p.evaluate(() => !document.getElementById("settings").open && !document.getElementById("apikey").checkVisibility()));
// keyboard: tab order from top
const order = [];
for (let i = 0; i < 14; i++) { await p.keyboard.press("Tab"); order.push(await p.evaluate(() => { const e = document.activeElement; return (e.id || e.tagName) + (e.getAttribute("aria-label") ? "[" + e.getAttribute("aria-label") + "]" : ""); })); }
console.log("tab order:", order.join(" > "));
console.log("headings:", await p.evaluate(() => [...document.querySelectorAll("h1,h2,h3")].map(h => h.tagName + ":" + h.textContent.trim().slice(0, 30)).join(" | ")));
await p.evaluate(() => { const d = document.querySelector("#settings"); if (d) d.open = true; });
await p.fill("#endpoint", "/v1"); await p.dispatchEvent("#endpoint", "change");
await p.fill("#apikey", "k"); await p.dispatchEvent("#apikey", "change");
await p.fill("#model", "m"); await p.dispatchEvent("#model", "change");
await p.click("#sample");
await p.waitForFunction(() => document.getElementById("files").textContent.includes("planning_memo.docx"), null, { timeout: 60000 });
await p.fill("#input", "go"); await p.focus("#send"); await p.keyboard.press("Enter");
console.log("focus moved to Stop while busy:", await p.evaluate(() => document.activeElement.id));
await p.waitForFunction(() => document.body.querySelector(".msg.assistant a"), null, { timeout: 30000 }).catch(async e => { console.log(await p.innerText("#chat")); throw e; });
await p.evaluate(() => document.querySelectorAll("details").forEach(d => d.open = true));
await scan("after conversation (all details open)");
await p.click("#showraw");
await scan("raw dialog open");
await p.keyboard.press("Escape");
await p.setViewportSize({ width: 320, height: 700 });
const overflow = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
console.log("\n320px reflow horizontal overflow:", overflow);
if (overflow) console.log(await p.evaluate(() => [...document.querySelectorAll("body *")].filter(e => e.getBoundingClientRect().right > window.innerWidth + 1 && !e.closest("pre")).slice(0, 8).map(e => e.tagName + "#" + e.id + "." + e.className + " right=" + Math.round(e.getBoundingClientRect().right)).join("\n")));
console.log("focus back after done:", await p.evaluate(() => document.activeElement.id));
await b.close(); srv.close();
