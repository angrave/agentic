// Gateway-mode test for index.html: a stub sign-in gateway (auth-limits-plan.md section 9 contract)
// plus a static server; drives the app with Playwright.
import http from "node:http";
import fs from "node:fs";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";

const APP_PORT = 8789, GW_PORT = 8790;
const APP_ORIGIN = `http://localhost:${APP_PORT}`, GW = `http://localhost:${GW_PORT}`;
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

const state = { issued: null, chatCalls: [], rateOnce: true, force401: false };
const cors = { "Access-Control-Allow-Origin": APP_ORIGIN, "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Expose-Headers": "Retry-After, X-Usage-Hour-Bytes, X-Usage-Hour-Tokens" };
const send = (res, status, obj, extra = {}) => { res.writeHead(status, { "Content-Type": "application/json", ...cors, ...extra }); res.end(JSON.stringify(obj)); };

const gateway = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  let body = ""; for await (const c of req) body += c;
  const url = new URL(req.url, GW);
  if (url.pathname === "/auth/config") return send(res, 200, { providers: [{ id: "email", label: "Illinois email", type: "form" }], llm_proxy: true });
  if (url.pathname === "/auth/email-login" && req.method === "POST") {
    const { email } = JSON.parse(body || "{}");
    if (!/^[a-z][a-z0-9]{1,7}@illinois\.edu$/.test(email || "")) return send(res, 400, { error: "bad_request", message: "Use your NetID email address (netid@illinois.edu)." });
    state.issued = `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ typ: "session", sub: "email:" + email, email, exp: Math.floor(Date.now() / 1000) + 3600 })}.stubsig`;
    return send(res, 200, { session: state.issued, user: { email } });
  }
  const auth = req.headers.authorization || "";
  if (url.pathname === "/v1/models") {
    if (auth !== "Bearer " + state.issued) return send(res, 401, { error: "not_signed_in", message: "Please sign in." });
    return send(res, 200, { data: [{ id: "stub-model" }] });
  }
  if (url.pathname === "/v1/chat/completions") {
    state.chatCalls.push({ auth, body });
    if (state.force401 || auth !== "Bearer " + state.issued) return send(res, 401, { error: "not_signed_in", message: "Your session has expired. Please sign in again." });
    if (state.rateOnce) { state.rateOnce = false; return send(res, 429, { error: "rate", message: "Too many requests", retry_after: 1 }, { "Retry-After": "1" }); }
    return send(res, 200, { choices: [{ message: { role: "assistant", content: "Hello from the gateway" }, finish_reason: "stop" }], usage: { total_tokens: 42 } });
  }
  send(res, 404, { error: "not_found", message: "Not found" });
});
const app = http.createServer((req, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end(fs.readFileSync(new URL("../index.html", import.meta.url))); });
await Promise.all([new Promise((r) => gateway.listen(GW_PORT, r)), new Promise((r) => app.listen(APP_PORT, r))]);

let failed = 0;
const expect = (c, m, extra = "") => { console.log((c ? "ok  - " : "FAIL - ") + m + (c || !extra ? "" : " :: " + extra)); if (!c) failed++; };
const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
const dialogOpen = () => page.evaluate(() => document.getElementById("signindlg").open);

try {
  // An API key in the link must NOT be sent in gateway mode.
  await page.goto(`${APP_ORIGIN}/#gateway=${encodeURIComponent(GW)}&model=stub-model&key=sk-should-not-be-sent`);
  await page.waitForFunction(() => document.getElementById("signindlg").open && !document.getElementById("signin-form").hidden, null, { timeout: 15000 });
  expect(await dialogOpen(), "sign-in dialog shown when signed out");
  expect(!page.url().includes("sk-should"), "setup link parameters removed from the address bar");
  expect(await page.evaluate(() => document.activeElement.id) === "signin-email", "focus moves to the email field");

  const axe = await new AxeBuilder({ page }).include("#signindlg").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"]).analyze();
  expect(axe.violations.length === 0, "sign-in dialog has 0 axe violations", axe.violations.map((v) => v.id).join(", "));

  await page.fill("#signin-email", "pat@gmail.com");
  await page.click("#signin-submit");
  await page.waitForFunction(() => document.getElementById("signin-error").textContent.length > 0);
  expect((await page.textContent("#signin-error")).includes("NetID email"), "non-Illinois email shows the server's message");
  expect(await page.getAttribute("#signin-error", "role") === "alert", "error is announced (role=alert)");
  expect(await dialogOpen(), "dialog stays open after a failed sign-in");

  await page.fill("#signin-email", "aillini@illinois.edu");
  await page.click("#signin-submit");
  await page.waitForFunction(() => !document.getElementById("signindlg").open);
  expect(true, "valid sign-in closes the dialog");
  expect((await page.textContent("#gwstatus")).includes("Signed in as aillini@illinois.edu"), "header shows the signed-in user");
  expect(await page.evaluate(() => document.getElementById("lbl-apikey").hidden), "API key field hidden in gateway mode");

  await page.waitForFunction(() => document.getElementById("pytext").textContent.startsWith("Python ready"), null, { timeout: 180000 });
  await page.evaluate(() => { window.__steps = []; new MutationObserver(() => window.__steps.push(document.getElementById("stepinfo").textContent)).observe(document.getElementById("stepinfo"), { childList: true, characterData: true, subtree: true }); });
  await page.fill("#input", "hello");
  await page.press("#input", "Enter");
  await page.waitForFunction(() => document.body.innerText.includes("Hello from the gateway"), null, { timeout: 30000 });
  expect(true, "chat works through the gateway");
  expect(state.chatCalls.length === 2, "one 429 then a successful retry (2 calls)", String(state.chatCalls.length));
  expect(state.chatCalls.every((c) => c.auth === "Bearer " + state.issued), "every chat call carries the session token");
  expect(state.chatCalls.every((c) => !c.body.includes("sk-should-not-be-sent") && !c.auth.includes("sk-")), "API key never sent");
  const steps = await page.evaluate(() => window.__steps);
  expect(steps.some((t) => /Too many requests — retrying in 1s/.test(t)), "retry countdown shown in the status line", steps.join(" | "));

  state.force401 = true;
  await page.fill("#input", "again please");
  await page.press("#input", "Enter");
  await page.waitForFunction(() => document.getElementById("signindlg").open, null, { timeout: 15000 });
  expect(true, "401 reopens the sign-in dialog");
  expect((await page.textContent("#signin-error")).includes("session has expired"), "dialog shows why", await page.textContent("#signin-error"));
  expect(await page.evaluate(() => localStorage.getItem("acl_session")) === null, "expired session cleared");
  expect(await page.inputValue("#input") === "again please", "unsent message kept in the input box", await page.inputValue("#input"));
  expect(await page.evaluate(() => document.body.innerText.includes("Hello from the gateway")), "conversation kept after 401");

  // Sending while signed out opens sign-in instead of calling the gateway.
  await page.click("#signin-close");
  const before = state.chatCalls.length;
  await page.press("#input", "Enter");
  await page.waitForFunction(() => document.getElementById("signindlg").open);
  expect(state.chatCalls.length === before, "no chat call while signed out");
} catch (e) {
  failed++;
  console.log("FAIL - exception:", e.message);
} finally {
  await browser.close();
  gateway.close(); app.close();
}
console.log(failed ? `${failed} FAILED` : "ALL GATEWAY APP TESTS PASSED");
process.exitCode = failed ? 1 : 0;
