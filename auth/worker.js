// Auth gateway prototype: OIDC login (CILogon / Google / Microsoft) done by the Worker,
// then a short-lived signed session token that the static GitHub Pages site sends as
// `Authorization: Bearer <token>` (no third-party cookies needed).
//
// Endpoints
//   GET  /auth/config                    -> which providers are enabled (for the login buttons)
//   GET  /auth/login?provider=&return_to= -> redirect to the identity provider (PKCE + state + nonce)
//   GET  /auth/callback                  -> code exchange, ID-token verification, policy check,
//                                           redirect back to return_to#session=<token>
//   GET  /auth/me                        -> the signed-in user (requires Bearer session)
//   POST /auth/email-login {email}       -> interim sign-in with an @illinois.edu address (EMAIL_LOGIN="true")
//   GET  /v1/models, POST /v1/chat/completions, GET /proxy?url=
//                                        -> require a Bearer session; run through the per-user limiter
//                                           (limiter.js), which adds the LUMEN_API_KEY secret upstream
//
// Configuration (wrangler.toml [vars] + `wrangler secret put`):
//   ALLOWED_ORIGINS  comma-separated origins allowed to call the Worker and to be return_to targets
//   PROVIDERS        JSON: { name: { label, issuer, client_id, scope?, auth_params?, rules: [...] } }
//   SESSION_TTL      seconds (default 28800 = 8h)
//   UPSTREAM         LLM API base (default https://lumen.ncsa.illinois.edu/v1)
//   EMAIL_LOGIN      "true" to enable email sign-in (unverified identity; replace with CILogon)
//   EVENT_ID         name of the event; a new value starts a fresh user registry and event token budget
//   EVENT_ENDS       ISO date/time; no sessions are issued or accepted after it
//   DENYLIST         comma-separated subs or emails to block
//   Limits (see limiter.js): RATE_LIMIT, RATE_WINDOW_S, HOUR_BYTES, HOUR_TOKENS, EVENT_TOKENS, MAX_USERS, ...
//   secrets: SESSION_SECRET (random, >= 32 chars), <NAME>_CLIENT_SECRET per provider (optional,
//            e.g. CILOGON_CLIENT_SECRET), LUMEN_API_KEY (optional)
//
//   MOCK_IDP_PRIVATE_JWK  secret; when set, adds a SIMULATED identity provider ("demo") for trying the
//                         flow without a registered client. The LLM proxy is disabled while it is on.
//
// A rule is { claim, equals | in | endsWith | contains | isTrue, message? }. All rules must pass.
// `contains` matches one item of a ";"- or ","-separated list (e.g. CILogon `affiliation`).

import { handleMockIdp } from "./mock-idp.js";
import { UserLimiter, GlobalBudget, limits, errorResponse, isBlockedHost, globalBudget } from "./limiter.js";
export { UserLimiter, GlobalBudget };

const enc = new TextEncoder();
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlJson = (obj) => b64url(enc.encode(JSON.stringify(obj)));
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const parseB64urlJson = (s) => JSON.parse(new TextDecoder().decode(fromB64url(s)));
const randomToken = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const now = () => Math.floor(Date.now() / 1000);

// ---------- HMAC-signed tokens (session + login transaction) ----------
async function hmacKey(secret) {
  if (!secret || secret.length < 32) throw new Error("SESSION_SECRET is missing or shorter than 32 characters");
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
async function signToken(payload, secret) {
  const body = b64urlJson({ alg: "HS256", typ: "JWT" }) + "." + b64urlJson(payload);
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(body));
  return body + "." + b64url(sig);
}
// Every signed payload carries `typ` ("session", "login_tx", "mock_code"); callers must check it so one
// kind of token can never be replayed as another.
async function verifyToken(token, secret, typ) {
  const parts = (token || "").split(".");
  if (parts.length !== 3) return null;
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), fromB64url(parts[2]), enc.encode(parts[0] + "." + parts[1]));
  if (!ok) return null;
  const payload = parseB64urlJson(parts[1]);
  if (typ && payload.typ !== typ) return null;
  return payload.exp && payload.exp > now() ? payload : null;
}

// ---------- OIDC discovery + ID token verification (RS256) ----------
const cache = new Map(); // per-isolate cache: url -> { value, expires }
// A Worker cannot fetch its own workers.dev URL, so calls to the built-in simulated IdP are handled in-process.
let selfCtx = null; // { origin, env }
function ifetch(input, init) {
  const u = new URL(typeof input === "string" ? input : input.url);
  if (selfCtx && u.origin === selfCtx.origin && u.pathname.startsWith("/mock-idp")) {
    return handleMockIdp(new Request(u, init), selfCtx.env, u, { signToken, verifyToken });
  }
  return fetch(input, init);
}
async function cachedJson(url, ttl = 3600) {
  const hit = cache.get(url);
  if (hit && hit.expires > Date.now()) return hit.value;
  const r = await ifetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`Fetch ${url} failed: HTTP ${r.status}`);
  const value = await r.json();
  cache.set(url, { value, expires: Date.now() + ttl * 1000 });
  return value;
}
const discovery = (issuer) => cachedJson(issuer.replace(/\/+$/, "") + "/.well-known/openid-configuration");

async function verifyIdToken(idToken, provider, nonce) {
  const [h, p, s] = (idToken || "").split(".");
  if (!s) throw new Error("ID token is not a JWT");
  const header = parseB64urlJson(h), claims = parseB64urlJson(p);
  if (header.alg !== "RS256") throw new Error("Unsupported ID token alg " + header.alg);
  const meta = await discovery(provider.issuer);
  let jwks = await cachedJson(meta.jwks_uri);
  let jwk = jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk) { cache.delete(meta.jwks_uri); jwks = await cachedJson(meta.jwks_uri); jwk = jwks.keys.find((k) => k.kid === header.kid); }
  if (!jwk) throw new Error("Signing key not found in JWKS");
  const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, fromB64url(s), enc.encode(h + "." + p)))) throw new Error("Bad ID token signature");
  // Microsoft's multi-tenant discovery document uses a {tenantid} placeholder in the issuer.
  const expectedIss = meta.issuer.replace("{tenantid}", claims.tid || "");
  if (claims.iss !== expectedIss) throw new Error(`Unexpected issuer ${claims.iss}`);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(provider.client_id)) throw new Error("ID token audience mismatch");
  const t = now();
  if (!(claims.exp > t - 60)) throw new Error("ID token expired");
  if (claims.nbf && claims.nbf > t + 60) throw new Error("ID token not yet valid");
  if (nonce && claims.nonce !== nonce) throw new Error("Nonce mismatch");
  return claims;
}

function checkRules(claims, rules = []) {
  if (!rules.length) throw new Error("Provider has no access rules configured (refusing to allow everyone)");
  for (const r of rules) {
    const v = claims[r.claim];
    const pass =
      ("equals" in r && v === r.equals) ||
      ("in" in r && r.in.includes(v)) ||
      ("endsWith" in r && typeof v === "string" && v.toLowerCase().endsWith(r.endsWith.toLowerCase())) ||
      ("contains" in r && typeof v === "string" && v.split(/[;,]\s*/).map((x) => x.toLowerCase()).includes(r.contains.toLowerCase())) ||
      ("isTrue" in r && (v === true || v === "true"));
    if (!pass) return `Access limited: ${r.message || `claim "${r.claim}" did not match`} (got ${JSON.stringify(v ?? null)})`;
  }
  return null;
}

// ---------- HTTP helpers ----------
function config(env, selfOrigin) {
  const origins = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const providers = JSON.parse(env.PROVIDERS || "{}");
  if (env.MOCK_IDP_PRIVATE_JWK) {
    providers.demo = {
      label: "Simulated Illinois IdP (demo)", issuer: selfOrigin + "/mock-idp", client_id: "demo-client", demo: true,
      rules: [{ claim: "idp", equals: "urn:mace:incommon:uiuc.edu", message: "only University of Illinois (Shibboleth) logins are accepted" }],
    };
  }
  const eventEnds = env.EVENT_ENDS ? Math.floor(Date.parse(env.EVENT_ENDS) / 1000) : null;
  const denylist = new Set((env.DENYLIST || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
  return { origins, providers, ttl: parseInt(env.SESSION_TTL || "28800"), eventEnds, denylist, emailLogin: env.EMAIL_LOGIN === "true" };
}
function corsHeaders(origin, cfg) {
  if (!cfg.origins.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Max-Age": "86400", Vary: "Origin",
    "Access-Control-Expose-Headers": "Retry-After, X-Usage-Hour-Bytes, X-Usage-Hour-Tokens, X-Limit-Hour-Bytes, X-Limit-Hour-Tokens",
  };
}
const json = (obj, status, headers) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...headers } });
function cookie(req, name) {
  const m = (req.headers.get("Cookie") || "").match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
  return m ? m[1] : null;
}
function redirectBack(returnTo, params, extraHeaders = {}) {
  return new Response(null, { status: 302, headers: { Location: returnTo.split("#")[0] + "#" + new URLSearchParams(params), "Cache-Control": "no-store", ...extraHeaders } });
}
function allowedReturnTo(returnTo, cfg) {
  try { return cfg.origins.includes(new URL(returnTo).origin); } catch { return false; }
}
async function sessionFrom(req, env) {
  const m = (req.headers.get("Authorization") || "").match(/^Bearer\s+(.+)$/i);
  return m ? verifyToken(m[1], env.SESSION_SECRET, "session") : null;
}

// ---------- Routes ----------
async function login(req, env, cfg, url) {
  const name = url.searchParams.get("provider");
  const returnTo = url.searchParams.get("return_to") || "";
  const provider = cfg.providers[name];
  if (!allowedReturnTo(returnTo, cfg)) return new Response("return_to origin not allowed", { status: 400 });
  if (!provider) return redirectBack(returnTo, { auth_error: "Unknown provider " + name });
  const meta = await discovery(provider.issuer);
  const tx = { typ: "login_tx", provider: name, state: randomToken(), nonce: randomToken(), verifier: randomToken(48), return_to: returnTo, exp: now() + 600 };
  const challenge = b64url(await crypto.subtle.digest("SHA-256", enc.encode(tx.verifier)));
  const auth = new URL(meta.authorization_endpoint);
  const q = {
    client_id: provider.client_id, response_type: "code", redirect_uri: url.origin + "/auth/callback",
    scope: provider.scope || "openid email profile", state: tx.state, nonce: tx.nonce,
    code_challenge: challenge, code_challenge_method: "S256", ...(provider.auth_params || {}),
  };
  for (const [k, v] of Object.entries(q)) auth.searchParams.set(k, v);
  const txCookie = await signToken(tx, env.SESSION_SECRET);
  return new Response(null, { status: 302, headers: {
    Location: auth.toString(), "Cache-Control": "no-store",
    // First-party cookie on the Worker's own origin, only used during this redirect round-trip.
    "Set-Cookie": `oidc_tx=${txCookie}; Path=/auth/callback; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
  } });
}

async function callback(req, env, cfg, url) {
  const clear = { "Set-Cookie": "oidc_tx=; Path=/auth/callback; HttpOnly; Secure; SameSite=Lax; Max-Age=0" };
  const tx = await verifyToken(cookie(req, "oidc_tx"), env.SESSION_SECRET, "login_tx");
  if (!tx) return new Response("Login session expired or missing. Please start again.", { status: 400, headers: clear });
  const fail = (msg) => redirectBack(tx.return_to, { auth_error: msg }, clear);
  if (url.searchParams.get("state") !== tx.state) return fail("State mismatch");
  if (url.searchParams.get("error")) return fail(url.searchParams.get("error_description") || url.searchParams.get("error"));
  const provider = cfg.providers[tx.provider];
  try {
    const meta = await discovery(provider.issuer);
    const body = new URLSearchParams({
      grant_type: "authorization_code", code: url.searchParams.get("code") || "",
      redirect_uri: url.origin + "/auth/callback", client_id: provider.client_id, code_verifier: tx.verifier,
    });
    const secret = env[tx.provider.toUpperCase() + "_CLIENT_SECRET"];
    if (secret) body.set("client_secret", secret);
    const r = await ifetch(meta.token_endpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body });
    const tok = await r.json().catch(() => ({}));
    if (!r.ok || !tok.id_token) return fail("Token exchange failed: " + (tok.error_description || tok.error || "HTTP " + r.status));
    const claims = await verifyIdToken(tok.id_token, provider, tx.nonce);
    const denied = checkRules(claims, provider.rules);
    if (denied) return fail(denied);
    const t = now();
    const session = {
      typ: "session", sub: `${tx.provider}:${claims.sub}`, provider: tx.provider,
      email: claims.email || claims.eppn || claims.preferred_username || null,
      name: claims.name || [claims.given_name, claims.family_name].filter(Boolean).join(" ") || null,
      idp: claims.idp_name || claims.idp || claims.hd || claims.tid || null,
      iat: t, exp: Math.min(t + cfg.ttl, cfg.eventEnds || Infinity),
    };
    return redirectBack(tx.return_to, { session: await signToken(session, env.SESSION_SECRET) }, clear);
  } catch (e) {
    return fail(e.message);
  }
}

const NETID_EMAIL = /^[a-z][a-z0-9]{1,7}@illinois\.edu$/;

async function emailLogin(req, env, cfg) {
  if (!cfg.emailLogin) return errorResponse(404, "not_found", "Email sign-in is not enabled.");
  if (cfg.eventEnds && now() >= cfg.eventEnds) return errorResponse(403, "forbidden", "This event has ended.");
  let email = "";
  try { email = String((await req.json()).email || "").trim().toLowerCase(); } catch {}
  if (!NETID_EMAIL.test(email)) return errorResponse(400, "bad_request", "Please enter your University of Illinois email address (netid@illinois.edu).");
  const sub = "email:" + email;
  if (cfg.denylist.has(sub) || cfg.denylist.has(email)) return errorResponse(403, "forbidden", "This account has been blocked. Please contact the trainer.");
  const reg = await globalBudget(env).fetch("https://global/register", { method: "POST", body: JSON.stringify({ sub, ip: req.headers.get("CF-Connecting-IP") || "" }) });
  if (!reg.ok) return reg;
  const t = now();
  const session = { typ: "session", sub, provider: "email", email, name: null, idp: "unverified email", iat: t, exp: Math.min(t + 36000, cfg.eventEnds || Infinity) };
  return Response.json({ session: await signToken(session, env.SESSION_SECRET), user: { email, exp: session.exp } });
}

async function readBodyCapped(req, maxBytes) {
  const reader = req.body?.getReader();
  if (!reader) return "";
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) { all.set(c, off); off += c.byteLength; }
  return new TextDecoder().decode(all);
}

// Build the job for the user's limiter, or return an error Response.
async function limitedJob(req, env, url, session) {
  const L = limits(env);
  const needsKey = () => {
    if (env.MOCK_IDP_PRIVATE_JWK) return errorResponse(503, "upstream_error", "LLM access is disabled while the simulated identity provider is enabled.");
    if (!env.LUMEN_API_KEY) return errorResponse(503, "upstream_error", "LLM access is not configured (LUMEN_API_KEY secret missing).");
    return null;
  };
  if (url.pathname === "/v1/models" && req.method === "GET") {
    return needsKey() || { kind: "llm", sub: session.sub, method: "GET", path: "/models" };
  }
  if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
    const missing = needsKey();
    if (missing) return missing;
    const text = await readBodyCapped(req, L.maxBodyBytes);
    if (text === null) return errorResponse(413, "too_large", `Request too large (limit ${Math.round(L.maxBodyBytes / 1000)} KB). Start a new chat to shorten the conversation.`);
    let body;
    try { body = JSON.parse(text); } catch { return errorResponse(400, "bad_request", "Request body must be JSON."); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return errorResponse(400, "bad_request", "Request body must be a JSON object.");
    if (body.stream) return errorResponse(400, "bad_request", "Streaming responses are not supported by this gateway.");
    body.max_tokens = Math.min(Number(body.max_tokens) || L.maxOutputTokens, L.maxOutputTokens);
    if (body.max_completion_tokens !== undefined) body.max_completion_tokens = Math.min(Number(body.max_completion_tokens) || L.maxOutputTokens, L.maxOutputTokens);
    return { kind: "llm", sub: session.sub, method: "POST", path: "/chat/completions", body: JSON.stringify(body) };
  }
  if (url.pathname === "/proxy" && req.method === "GET") {
    const target = url.searchParams.get("url") || "";
    if (!/^https?:\/\//i.test(target)) return errorResponse(400, "bad_request", "url must start with http:// or https://");
    // Reject obviously private targets before they use up rate limit (redirects are re-checked in the limiter).
    try { if (isBlockedHost(new URL(target).hostname)) return errorResponse(403, "forbidden", "Private or local addresses cannot be fetched."); }
    catch { return errorResponse(400, "bad_request", "Invalid URL."); }
    return { kind: "proxy", sub: session.sub, url: target };
  }
  return errorResponse(404, "not_found", "Not found.");
}

function withCors(resp, cors) {
  const headers = new Headers(resp.headers);
  for (const [k, v] of Object.entries(cors)) headers.set(k, v);
  return new Response(resp.body, { status: resp.status, headers });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    selfCtx = { origin: url.origin, env };
    const cfg = config(env, url.origin);
    if (url.pathname.startsWith("/mock-idp")) {
      return env.MOCK_IDP_PRIVATE_JWK ? handleMockIdp(req, env, url, { signToken, verifyToken }) : new Response("Not found", { status: 404 });
    }
    const origin = req.headers.get("Origin") || "";
    const cors = corsHeaders(origin, cfg);
    if (req.method === "OPTIONS") return new Response(null, { status: cors["Access-Control-Allow-Origin"] ? 204 : 403, headers: cors });
    try {
      if (url.pathname === "/auth/config") {
        const providers = Object.entries(cfg.providers).map(([id, p]) => ({ id, label: p.label || id, type: "redirect" }));
        if (cfg.emailLogin) providers.unshift({ id: "email", label: "Illinois email address", type: "form" });
        return json({ providers, llm_proxy: !!env.LUMEN_API_KEY && !env.MOCK_IDP_PRIVATE_JWK }, 200, cors);
      }
      if (url.pathname === "/auth/login") return await login(req, env, cfg, url);
      if (url.pathname === "/auth/callback") return await callback(req, env, cfg, url);
      if (origin && !cors["Access-Control-Allow-Origin"]) return json({ error: "forbidden", message: "Origin not allowed" }, 403);
      if (url.pathname === "/auth/email-login" && req.method === "POST") return withCors(await emailLogin(req, env, cfg), cors);

      const session = await sessionFrom(req, env);
      if (!session || (cfg.eventEnds && now() >= cfg.eventEnds)) {
        return withCors(errorResponse(401, "not_signed_in", "Please sign in (your session is missing or has expired)."), cors);
      }
      if (cfg.denylist.has(session.sub.toLowerCase()) || (session.email && cfg.denylist.has(session.email.toLowerCase()))) {
        return withCors(errorResponse(403, "forbidden", "This account has been blocked. Please contact the trainer."), cors);
      }
      if (url.pathname === "/auth/me") return json({ user: session }, 200, cors);

      const job = await limitedJob(req, env, url, session);
      if (job instanceof Response) return withCors(job, cors);
      // Fail closed: if the limiter can't be reached, the request is refused.
      const limiter = env.LIMITER.get(env.LIMITER.idFromName(session.sub));
      const resp = await limiter.fetch("https://limiter/run", { method: "POST", body: JSON.stringify(job) });
      return withCors(resp, cors);
    } catch (e) {
      return withCors(errorResponse(503, "upstream_error", "Gateway error: " + e.message), cors);
    }
  },
};
