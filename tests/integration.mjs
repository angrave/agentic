// End-to-end: real index.html + real gateway Worker (wrangler dev) + mock Lumen upstream.
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const ROOT = new URL("../", import.meta.url).pathname;
const GW = "http://127.0.0.1:8789";
let failed = 0;
const expect = (c, m, extra = "") => { console.log((c ? "ok  - " : "FAIL - ") + m + (c ? "" : "  → " + extra)); if (!c) failed++; };

let calls = 0;
const upstream = http.createServer(async (req, res) => {
  let body = ""; for await (const c of req) body += c;
  res.writeHead(200, { "Content-Type": "application/json" });
  if (req.url === "/v1/models") return res.end('{"data":[{"id":"m"}]}');
  calls++;
  const j = JSON.parse(body);
  const hasTool = j.messages.some(m => m.role === "tool");
  const msg = hasTool
    ? { role: "assistant", content: "Downloaded it: " + j.messages.filter(m => m.role === "tool").at(-1).content.slice(0, 60) }
    : { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "fetch_url", arguments: JSON.stringify({ url: "https://example.com/", save_as: "example.html" }) } }] };
  res.end(JSON.stringify({ choices: [{ message: msg }], usage: { total_tokens: 1234 } }));
});
await new Promise(r => upstream.listen(9912, r));
const page = http.createServer((q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(fs.readFileSync(path.join(ROOT, "index.html"))); });
await new Promise(r => page.listen(8000, r));

const envFile = path.join(ROOT, "auth", ".dev.vars.integration-test");
fs.writeFileSync(envFile, `SESSION_SECRET="${"i".repeat(40)}"\nLUMEN_API_KEY="upstream-test-key"\n`);
const vars = { UPSTREAM: "http://localhost:9912/v1", EMAIL_LOGIN: "true", ALLOWED_ORIGINS: "http://localhost:8000" };
const dev = spawn("npx", ["wrangler", "dev", "--port", "8789", "--ip", "127.0.0.1", "--env-file", envFile, "--persist-to", fs.mkdtempSync("/tmp/integ-"), ...Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`])], { cwd: path.join(ROOT, "auth"), stdio: ["ignore", "pipe", "pipe"] });
let log = ""; dev.stdout.on("data", d => log += d); dev.stderr.on("data", d => log += d);
const cleanup = () => { dev.kill(); upstream.close(); page.close(); try { fs.unlinkSync(envFile); } catch {} };
for (let i = 0; !log.includes("Ready on"); i++) { if (i > 120) { console.log(log); cleanup(); process.exit(1); } await new Promise(r => setTimeout(r, 500)); }

const b = await chromium.launch();
try {
  const p = await (await b.newContext()).newPage();
  p.on("pageerror", e => console.log("[pageerror]", e.message));
  await p.goto(`http://localhost:8000/#gateway=${encodeURIComponent(GW)}&model=m`);
  const dlg = p.getByRole("dialog");
  await dlg.waitFor({ timeout: 10000 });
  expect(await dlg.isVisible(), "sign-in dialog shown when signed out");
  await dlg.getByLabel(/email/i).fill("someone@gmail.com");
  await dlg.getByRole("button", { name: /sign in/i }).click();
  await p.waitForFunction(() => /illinois/i.test(document.querySelector("dialog [role=alert]")?.textContent || ""), null, { timeout: 10000 });
  expect(true, "gateway's error message for non-Illinois email shown in dialog");
  await dlg.getByLabel(/email/i).fill("tester1@illinois.edu");
  await dlg.getByRole("button", { name: /sign in/i }).click();
  await dlg.waitFor({ state: "hidden", timeout: 10000 });
  expect((await p.textContent("body")).includes("tester1@illinois.edu"), "signed in; email shown");
  await p.waitForFunction(() => document.getElementById("pytext").textContent.startsWith("Python ready"), null, { timeout: 180000 });
  await p.fill("#input", "download example.com");
  await p.press("#input", "Enter");
  await p.waitForFunction(() => document.body.innerText.includes("Downloaded it:"), null, { timeout: 60000 });
  const txt = await p.innerText("#chat");
  expect(calls === 2, "two LLM calls went through the gateway", calls);
  expect(/Saved \d+ bytes to example\.html/.test(txt), "fetch_url tool worked (direct or via gateway proxy)", txt.slice(0, 400));
  expect((await p.textContent("#files")).includes("example.html"), "downloaded file appears in Files");
} catch (e) {
  failed++; console.log("FAIL - exception:", e.message);
} finally {
  await b.close(); cleanup();
}
console.log(failed ? `${failed} FAILED` : "ALL INTEGRATION TESTS PASSED");
process.exit(failed ? 1 : 0);
