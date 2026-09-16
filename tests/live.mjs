// Live test against Lumen: page served from a static http server, LLM calls go browser -> Lumen (tests CORS too).
import http from "node:http";
import fs from "node:fs";
import { chromium } from "playwright";

const MODEL = process.argv[2] || "glm-5.3-flash";
const PROMPT = process.argv[3] || "Total revenue by region in sales_2025.xlsx; save a bar chart. Then tell me which department in planning_memo.docx has the largest budget request.";
const server = http.createServer((req, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end(fs.readFileSync(new URL("../index.html", import.meta.url))); });
await new Promise(r => server.listen(8766, r));
const browser = await chromium.launch();
const page = await browser.newPage();
page.on("pageerror", e => console.log("[pageerror]", e.message));
await page.goto(`http://localhost:8000/#endpoint=/v1&proxy=/proxy%3Furl%3D%7Benc%7D&reader=/proxy%3Furl%3D%7Benc%7D&model=${MODEL}&key=${encodeURIComponent(process.env.LUMEN_API_KEY || "")}`);
await page.waitForFunction(() => document.getElementById("pytext").textContent === "Python ready", null, { timeout: 180000 });
await page.click("#sample");
await page.waitForFunction(() => document.getElementById("files").textContent.includes("planning_memo.docx"), null, { timeout: 60000 });
await page.fill("#input", PROMPT);
await page.press("#input", "Enter");
await page.waitForFunction(() => !document.getElementById("stop").hidden, null, { timeout: 5000 }).catch(() => {});
await page.waitForFunction(() => document.getElementById("stop").hidden, null, { timeout: 400000 });
const out = await page.evaluate(() => [...document.querySelectorAll("#chat > *")].map(e => {
  if (e.classList.contains("tool")) return "[TOOL] " + e.querySelector(".name").textContent + " " + e.querySelector(".st").textContent + " :: " + e.querySelector(".brief").textContent.slice(0, 100) + "\n   -> " + e.querySelector(".res").textContent.slice(0, 300).replace(/\n/g, "\n      ");
  return "[" + e.className + "] " + e.innerText.slice(0, 800);
}).join("\n"));
console.log(out);
console.log("STEPINFO:", await page.textContent("#stepinfo"));
await page.screenshot({ path: `shot_live_${MODEL}.png` });
await browser.close(); server.close();
