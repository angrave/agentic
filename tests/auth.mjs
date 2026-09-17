// Auth prototype test: demo page (localhost:8000) + Worker (WORKER env) with simulated IdP.
import http from "node:http"; import fs from "node:fs"; import { chromium } from "playwright";
const WORKER = process.env.WORKER || "http://localhost:8787";
const PAGE_ORIGIN = process.env.PAGE || "http://localhost:8000";
const PAGE = PAGE_ORIGIN + "/auth-demo/";
let srv;
if (PAGE_ORIGIN.startsWith("http://localhost")) {
  srv = http.createServer((q, r) => { r.writeHead(200, { "Content-Type": "text/html" }); r.end(fs.readFileSync(new URL("../auth-demo/index.html", import.meta.url))); });
  await new Promise(x => srv.listen(8000, x));
}
let failed = 0;
const expect = (c, m, extra = "") => { console.log((c ? "ok  - " : "FAIL - ") + m + (c ? "" : " " + extra)); if (!c) failed++; };
const b = await chromium.launch();
const ctx = await b.newContext(); const p = await ctx.newPage();
p.on("pageerror", e => console.log("[pageerror]", e.message));

async function loginAs(identity) {
  await p.goto(PAGE + "#worker=" + encodeURIComponent(WORKER));
  await p.getByRole("button", { name: /Simulated Illinois IdP/ }).click();
  await p.waitForURL(/mock-idp\/authorize/);
  await p.check(`#id-${identity}`);
  await p.getByRole("button", { name: "Continue" }).click();
  await p.waitForURL(u => u.toString().startsWith(PAGE));
  await p.waitForFunction(() => !/Loading/.test(document.getElementById("status").textContent));
  return p.textContent("#status");
}
const lastOut = async (btn) => { await p.getByRole("button", { name: btn }).click(); await p.waitForFunction(() => /^HTTP|failed/.test(document.getElementById("out").textContent)); return p.textContent("#out"); };

let st = await loginAs("illinois");
expect(/Signed in as Alex Illini/.test(st), "Illinois identity allowed", st);
expect(!p.url().includes("session="), "session token removed from address bar", p.url());
let out = await lastOut("Who am I? (/auth/me)");
expect(out.startsWith("HTTP 200") && out.includes("aillini@illinois.edu"), "/auth/me with session → 200", out);
out = await lastOut("Call without a token");
expect(out.startsWith("HTTP 401"), "/auth/me without token → 401", out);
const token = await p.evaluate(() => sessionStorage.getItem("session"));

st = await loginAs("google");
expect(/Sign-in failed: .*only University of Illinois/.test(st), "personal Google identity denied", st);
st = await loginAs("spoof");
expect(/Sign-in failed/.test(st), "spoofed @illinois.edu email via Google denied", st);

// API-level attacks (from Node, no browser)
const f = (path, opts = {}) => fetch(WORKER + path, { redirect: "manual", ...opts });
let r = await f("/auth/me", { headers: { Authorization: "Bearer " + token } });
expect(r.status === 200, "valid token works from a script (expected: tokens are bearer credentials)");
const parts = token.split(".");
const forged = JSON.parse(Buffer.from(parts[1], "base64url")); forged.email = "evil@illinois.edu"; forged.exp += 99999;
r = await f("/auth/me", { headers: { Authorization: `Bearer ${parts[0]}.${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${parts[2]}` } });
expect(r.status === 401, "tampered session token rejected", r.status);
r = await f("/auth/login?provider=demo&return_to=" + encodeURIComponent("https://evil.example/"));
expect(r.status === 400, "return_to to foreign origin rejected", r.status);
r = await f("/auth/login?provider=demo&return_to=" + encodeURIComponent(PAGE));
const txCookie = (r.headers.get("set-cookie") || "").match(/oidc_tx=([^;]+)/)?.[1];
r = await f("/auth/me", { headers: { Authorization: "Bearer " + txCookie } });
expect(txCookie && r.status === 401, "login-transaction cookie cannot be replayed as a session", r.status);
r = await f("/auth/me", { headers: { Authorization: "Bearer " + token, Origin: "https://evil.example" } });
expect(r.status === 403, "disallowed browser Origin rejected", r.status);
r = await f("/auth/callback?state=x&code=y");
expect(r.status === 400, "callback without login cookie rejected", r.status);
r = await f("/v1/models", { headers: { Authorization: "Bearer " + token } });
expect(r.status === 503, "LLM proxy disabled while simulated IdP is on", r.status);
r = await f("/auth/config", { headers: { Origin: PAGE_ORIGIN } });
expect(r.headers.get("access-control-allow-origin") === PAGE_ORIGIN, "CORS allows the demo page origin");

await b.close(); srv?.close();
console.log(failed ? `${failed} FAILED` : "ALL AUTH TESTS PASSED");
process.exitCode = failed ? 1 : 0;
