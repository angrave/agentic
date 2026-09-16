// E2E test: serves index.html + a scripted mock OpenAI-compatible API, drives it with Playwright.
import http from "node:http";
import fs from "node:fs";
import { chromium } from "playwright";

const APP = new URL("../index.html", import.meta.url);
const requests = [];
const tc = (name, args, raw) => ({ id: "c" + Math.random().toString(36).slice(2, 8), type: "function", function: { name, arguments: raw ?? JSON.stringify(args) } });
const SCRIPT = [
  () => ({ content: "Let me look.", tool_calls: [tc("list_files", {})] }),
  () => ({ content: null, tool_calls: [tc("read_file", { path: "sales_2025.xlsx" }), tc("read_file", { path: "planning_memo.docx" })] }),
  () => ({ content: null, tool_calls: [tc("run_python", {}, '{"code": "import pandas as pd\\nimport matplotlib.pyplot as plt\\ndf = pd.read_excel(\'sales_2025.xlsx\')\\ns = df.groupby(\'Region\')[\'Revenue\'].sum()\\nprint(s)\\ns.plot.bar()\\ns.to_excel(\'by_region.xlsx\')\\nlen(df)"}')] }),
  () => ({ content: null, tool_calls: [tc("run_python", { code: "1/0" }), tc("read_file", null, "{not json")] }),
  () => ({ content: null, tool_calls: [tc("fetch_url", { url: "http://localhost:8765/data.csv", save_as: "data.csv" })] }),
  () => ({ content: '<think>need to check files</think>\n<tool_call>{"name": "list_files", "arguments": {}}</tool_call>' }),
  () => ({ content: "## Done\nRevenue by region saved to **by_region.xlsx**." }),
];

const server = http.createServer(async (req, res) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" };
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  if (req.url === "/" || req.url.startsWith("/index.html")) { res.writeHead(200, { "Content-Type": "text/html" }); return res.end(fs.readFileSync(APP)); }
  if (req.url === "/data.csv") { res.writeHead(200, { "Content-Type": "text/csv", ...cors }); return res.end("a,b\n1,2\n3,4\n"); }
  if (req.url === "/v1/models") { res.writeHead(200, { "Content-Type": "application/json", ...cors }); return res.end(JSON.stringify({ data: [{ id: "mock-model" }] })); }
  if (req.url === "/v1/chat/completions") {
    let body = ""; for await (const c of req) body += c;
    const j = JSON.parse(body);
    requests.push(j);
    const i = requests.length - 1;
    const msg = SCRIPT[Math.min(i, SCRIPT.length - 1)]();
    res.writeHead(200, { "Content-Type": "application/json", ...cors });
    return res.end(JSON.stringify({ choices: [{ message: { role: "assistant", ...msg }, finish_reason: msg.tool_calls ? "tool_calls" : "stop" }], usage: { total_tokens: 123 } }));
  }
  res.writeHead(404); res.end();
});
await new Promise(r => server.listen(8765, r));

const browser = await chromium.launch();
const page = await browser.newPage({ acceptDownloads: true });
page.on("console", m => { if (m.type() === "error" || m.type() === "warning") console.log("[console]", m.text()); });
page.on("pageerror", e => console.log("[pageerror]", e.message));
page.on("dialog", d => d.accept());
const fail = (m) => { console.error("FAIL:", m); process.exitCode = 1; };

await page.goto("http://localhost:8765/#endpoint=http://localhost:8765/v1&key=testkey&model=mock-model");
if (page.url().includes("testkey")) fail("key left in address bar");
const t0 = Date.now();
await page.waitForFunction(() => document.getElementById("pytext").textContent === "Python ready", null, { timeout: 180000 });
console.log("Python ready in", (Date.now() - t0) / 1000, "s");
await page.click("#sample");
await page.waitForFunction(() => document.getElementById("files").textContent.includes("planning_memo.docx"), null, { timeout: 60000 });
await page.click("#settings > summary");
await page.click("#loadmodels");
await page.fill("#input", "Analyze my files");
await page.press("#input", "Enter");
await page.waitForFunction(() => document.body.innerText.includes("Revenue by region saved"), null, { timeout: 120000 });

const tools = requests.flatMap(r => r.messages.filter(m => m.role === "tool"));
const last = requests[requests.length - 1].messages;
const toolContents = last.filter(m => m.role === "tool").map(m => m.content);
console.log("Requests:", requests.length);
const expect = (cond, m) => cond ? console.log("ok  -", m) : fail(m);
expect(requests.length === SCRIPT.length, "all scripted steps executed");
expect(requests[0].tools?.length === 6, "6 tools sent");
expect(toolContents[0].includes("sales_2025.xlsx") && toolContents[0].includes("planning_memo.docx"), "list_files output");
expect(toolContents[1].includes("Sheet 'Sales'") && toolContents[1].includes("Revenue"), "xlsx preview");
expect(toolContents[2].includes("Marketing") && toolContents[2].includes("Table 1"), "docx preview");
expect(/North\s+\d/.test(toolContents[3]) && toolContents[3].includes("Result: 144") && toolContents[3].includes("figure_1.png") && toolContents[3].includes("by_region.xlsx"), "run_python stdout/result/figure/file");
expect(toolContents[4].includes("ZeroDivisionError"), "python error reported");
expect(toolContents[5].startsWith("ERROR: Tool arguments were not valid JSON"), "bad JSON args reported");
expect(toolContents[6].includes("Saved 12 bytes to data.csv"), "fetch_url save");
expect(toolContents[7].includes("data.csv") && toolContents[7].includes("by_region.xlsx"), "text <tool_call> fallback executed");
const asst = last.filter(m => m.role === "assistant");
expect(asst.every(m => !m.tool_calls || m.tool_calls.every(t => last.some(x => x.role === "tool" && x.tool_call_id === t.id))), "every tool_call has a response");
expect(await page.locator(".tool img").count() >= 1, "chart image rendered");
expect(await page.locator(".think").count() >= 1, "thinking shown");
expect((await page.locator("#files").innerText()).includes("figure_1.png"), "files panel updated");
await page.screenshot({ path: "shot_mock.png", fullPage: false });

// Restart python: mirrored files should be restored
await page.click("#restartpy");
await page.waitForFunction(() => document.getElementById("pytext").textContent === "Python ready", null, { timeout: 180000 });
await page.waitForFunction(() => document.getElementById("files").textContent.includes("data.csv"), null, { timeout: 30000 }).then(() => console.log("ok  - files restored after restart"), () => fail("files restored after restart"));

await browser.close();
server.close();
console.log(process.exitCode ? "SOME TESTS FAILED" : "ALL TESTS PASSED");
