// Gateway limits test. Starts a mock Lumen upstream and `wrangler dev` with small limits, then checks
// sign-in, route allowlist, request hygiene, concurrency, rate, hourly bytes/tokens, token estimation,
// web proxy protections, event budget and new-user caps.
// Run: cd tests && node limits.mjs   (needs npx wrangler; no Cloudflare account needed for dev)
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const AUTH_DIR = new URL("../auth/", import.meta.url).pathname;
const W = "http://127.0.0.1:8788";
const ORIGIN = "http://localhost:8000";
let failed = 0;
const expect = (c, m, extra = "") => { console.log((c ? "ok  - " : "FAIL - ") + m + (c ? "" : "  → " + extra)); if (!c) failed++; };

// ---------- mock upstream ----------
const seen = [];
const upstream = http.createServer(async (req, res) => {
  let body = ""; for await (const c of req) body += c;
  if (req.url === "/v1/models") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end('{"data":[{"id":"m"}]}'); }
  if (req.url === "/v1/chat/completions") {
    const j = JSON.parse(body);
    seen.push({ auth: req.headers.authorization, max_tokens: j.max_tokens });
    const cmd = j.messages?.at(-1)?.content || "";
    const num = (k) => Number((cmd.match(new RegExp(k + ":(\\d+)")) || [])[1] || 0);
    if (num("sleep")) await new Promise(r => setTimeout(r, num("sleep")));
    const out = { choices: [{ message: { role: "assistant", content: "x".repeat(num("out")) || "ok" } }] };
    if (!cmd.includes("nousage")) out.usage = { total_tokens: num("tokens") || 50 };
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(out));
  }
  res.writeHead(404); res.end();
});
await new Promise(r => upstream.listen(9911, r));

// ---------- wrangler dev ----------
const envFile = path.join(AUTH_DIR, ".dev.vars.limits-test");
fs.writeFileSync(envFile, `SESSION_SECRET="${"s".repeat(40)}"\nLUMEN_API_KEY="upstream-test-key"\n`);
const vars = {
  UPSTREAM: "http://localhost:9911/v1", RATE_LIMIT: "4", RATE_WINDOW_S: "20", HOUR_BYTES: "300000", HOUR_TOKENS: "20000",
  EVENT_TOKENS: "60000", MAX_USERS: "16", NEW_USERS_PER_IP: "14", MAX_BODY_BYTES: "100000", PROXY_MAX_BYTES: "10000",
  MAX_OUTPUT_TOKENS: "100", UPSTREAM_TIMEOUT_MS: "3000", DENYLIST: "email:blocked@illinois.edu", ALLOWED_ORIGINS: ORIGIN, EMAIL_LOGIN: "true",
};
const args = ["wrangler", "dev", "--port", "8788", "--ip", "127.0.0.1", "--env-file", envFile, "--persist-to", fs.mkdtempSync("/tmp/limits-"), ...Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`])];
const dev = spawn("npx", args, { cwd: AUTH_DIR, stdio: ["ignore", "pipe", "pipe"] });
let devLog = "";
dev.stdout.on("data", d => devLog += d); dev.stderr.on("data", d => devLog += d);
const cleanup = () => { dev.kill(); upstream.close(); try { fs.unlinkSync(envFile); } catch {} };
for (let i = 0; !devLog.includes("Ready on"); i++) { if (i > 120) { console.log(devLog); cleanup(); process.exit(1); } await new Promise(r => setTimeout(r, 500)); }

const call = (p, { token, method = "GET", body, headers = {}, ip } = {}) => fetch(W + p, {
  method, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  headers: { Origin: ORIGIN, "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}), ...(ip ? { "CF-Connecting-IP": ip } : {}), ...headers },
});
const login = async (email, ip = "10.1.1.1") => { const r = await call("/auth/email-login", { method: "POST", body: { email }, ip }); return { r, j: await r.json() }; };
const token = async (netid, ip) => { const { r, j } = await login(netid + "@illinois.edu", ip); if (!j.session) throw new Error("login failed " + JSON.stringify(j)); return j.session; };
const chat = (tok, content, extra = {}) => call("/v1/chat/completions", { token: tok, method: "POST", body: { model: "m", messages: [{ role: "user", content }], ...extra } });

try {
  // --- sign-in ---
  const cfg = await (await call("/auth/config")).json();
  expect(cfg.providers.some(p => p.id === "email" && p.type === "form") && cfg.llm_proxy === true, "config offers email form and LLM proxy", JSON.stringify(cfg));
  let { r, j } = await login("someone@gmail.com");
  expect(r.status === 400 && j.error === "bad_request", "non-Illinois email rejected", r.status);
  ({ r, j } = await login("alex+2@illinois.edu"));
  expect(r.status === 400, "plus-addressed alias rejected (no identity minting)", r.status);
  ({ r, j } = await login("blocked@illinois.edu"));
  expect(r.status === 403 && j.error === "forbidden", "denylisted email rejected", r.status);
  ({ r, j } = await login("  AMisc@Illinois.EDU "));
  expect(r.status === 200 && j.user.email === "amisc@illinois.edu" && r.headers.get("access-control-allow-origin") === ORIGIN, "valid email signs in (normalised, CORS)", JSON.stringify(j));
  const misc = j.session;

  // --- auth + route allowlist + hygiene ---
  r = await chat(null, "hi");
  j = await r.json();
  expect(r.status === 401 && j.error === "not_signed_in" && r.headers.get("access-control-allow-origin") === ORIGIN, "no session → 401 JSON with CORS", r.status);
  r = await call("/v1/embeddings", { token: misc, method: "POST", body: {} });
  expect(r.status === 404, "non-allowlisted upstream path → 404", r.status);
  r = await chat(misc, "hi", { stream: true });
  expect(r.status === 400, "stream:true rejected", r.status);
  r = await call("/v1/chat/completions", { token: misc, method: "POST", body: "{" + "x".repeat(120000) });
  expect(r.status === 413, "oversized body → 413", r.status);
  r = await chat(misc, "hi", { max_tokens: 999999 });
  expect(r.status === 200 && seen.at(-1).max_tokens === 100 && seen.at(-1).auth === "Bearer upstream-test-key", "max_tokens capped; server-side key used; session token not forwarded", JSON.stringify(seen.at(-1)));
  expect(r.headers.get("access-control-expose-headers")?.includes("Retry-After") && r.headers.get("x-usage-hour-tokens") === "50", "usage headers exposed", [...r.headers].join(";"));
  r = await call("/v1/models", { token: misc });
  expect(r.status === 200, "GET /v1/models works", r.status);

  // --- concurrency ---
  const c1 = await token("aconc"), c2 = await token("bconc");
  const slow = chat(c1, "sleep:1500");
  await new Promise(res => setTimeout(res, 300));
  r = await chat(c1, "hi"); j = await r.json();
  expect(r.status === 429 && j.error === "busy" && r.headers.get("retry-after"), "second concurrent request from same user → 429 busy", r.status + JSON.stringify(j));
  r = await chat(c2, "hi");
  expect(r.status === 200, "another user is not blocked meanwhile", r.status);
  expect((await slow).status === 200, "first (slow) request completes", "");
  r = await chat(c1, "hi");
  expect(r.status === 200, "same user can continue after completion", r.status);

  // --- timeout releases the lock ---
  const to = await token("atimeout");
  r = await chat(to, "sleep:4000"); j = await r.json();
  expect(r.status === 504 && j.error === "upstream_timeout", "slow upstream → 504 timeout", r.status);
  r = await chat(to, "hi");
  expect(r.status === 200, "user not locked after timeout", r.status);

  // --- rate ---
  const rt = await token("arate");
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await chat(rt, "hi")).status);
  r = await chat(rt, "hi"); j = await r.json();
  expect(codes.slice(0, 4).every(c => c === 200) && codes[4] === 429, "4 requests allowed per 20 s, 5th → 429", codes.join(","));
  expect(j.error === "rate" && j.retry_after > 0 && j.retry_after <= 20, "rate error has retry_after ≤ window", JSON.stringify(j));

  // --- hourly bytes ---
  const hb = await token("abytes");
  r = await chat(hb, "out:300000");
  expect(r.status === 200, "large response allowed while under budget (charged after)", r.status);
  r = await chat(hb, "hi"); j = await r.json();
  expect(r.status === 429 && j.error === "hour_bytes" && j.retry_after > 3000, "next request → 429 hour_bytes, retry in ~1h", JSON.stringify(j));

  // --- hourly tokens ---
  const ht = await token("atokens");
  r = await chat(ht, "tokens:21000");
  expect(r.status === 200, "request reporting 21k tokens allowed (under budget beforehand)", r.status);
  r = await chat(ht, "hi"); j = await r.json();
  expect(r.status === 429 && j.error === "hour_tokens", "next request → 429 hour_tokens", JSON.stringify(j));

  // --- token estimate when usage missing ---
  const es = await token("aestim");
  r = await chat(es, "nousage out:40000");
  const est = Number(r.headers.get("x-usage-hour-tokens"));
  expect(r.status === 200 && est >= 10000 && est <= 10200, "tokens estimated as bytes/4 when upstream omits usage", est);

  // --- web proxy ---
  const px = await token("aproxy");
  r = await call("/proxy?url=" + encodeURIComponent("https://example.com/"));
  expect(r.status === 401, "proxy requires sign-in", r.status);
  r = await call("/proxy?url=" + encodeURIComponent("https://example.com/"), { token: px });
  expect(r.status === 200 && Number(r.headers.get("x-usage-hour-bytes")) > 100, "proxy fetch works and bytes are counted", r.status + " " + r.headers.get("x-usage-hour-bytes"));
  for (const bad of ["http://localhost:9911/v1/models", "http://127.0.0.1/", "http://169.254.169.254/latest/meta-data/", "http://[::1]/", "http://192.168.1.1/"]) {
    r = await call("/proxy?url=" + encodeURIComponent(bad), { token: px });
    expect(r.status === 403, "proxy blocks private target " + bad, r.status);
  }
  r = await call("/proxy?url=" + encodeURIComponent("https://raw.githubusercontent.com/mwaskom/seaborn-data/master/penguins.csv"), { token: px });
  expect(r.status === 413, "proxy download over size cap → 413", r.status);

  // --- event budget (global) ---
  const ev = await token("aevent");
  r = await chat(ev, "tokens:40000");
  expect(r.status === 200, "big request pushes event total over budget", r.status);
  r = await chat(misc, "hi"); j = await r.json();
  expect(r.status === 503 && j.error === "event_budget", "any user → 503 event_budget afterwards", JSON.stringify(j));
  r = await call("/proxy?url=" + encodeURIComponent("https://example.com/"), { token: px });
  expect(r.status === 200, "web proxy still works after LLM budget is used up", r.status);

  // --- new identities: per-IP window and event cap ---
  let n = 10; // users created so far from 10.1.1.1 (misc, conc×2, timeout, rate, bytes, tokens, estim, proxy, event)
  const re = await login("amisc@illinois.edu");
  expect(re.r.status === 200, "re-login of an existing user doesn't count as new", re.r.status);
  const statuses = [];
  for (let i = 0; i < 5; i++) statuses.push((await login(`anew${i}@illinois.edu`, "10.1.1.1")).r.status);
  expect(statuses.slice(0, 4).every(s => s === 200) && statuses[4] === 429, `per-IP new identities capped at 14 per window`, statuses.join(","));
  const other = [];
  for (let i = 0; i < 3; i++) other.push(await login(`bnew${i}@illinois.edu`, "10.2.2.2"));
  const ipHonoured = other[0].r.status === 200;
  if (ipHonoured) {
    expect(other[0].r.status === 200 && other[1].r.status === 200 && other[2].r.status === 503 && other[2].j.error === "max_users", "event capped at 16 distinct users", other.map(o => o.r.status).join(","));
  } else {
    console.log("skip - max_users check (local dev ignores CF-Connecting-IP; per-IP window blocked first: " + other[0].r.status + ")");
  }
} catch (e) {
  failed++; console.log("FAIL - exception:", e.stack);
} finally {
  cleanup();
}
console.log(failed ? `${failed} FAILED` : "ALL LIMIT TESTS PASSED");
process.exit(failed ? 1 : 0);
