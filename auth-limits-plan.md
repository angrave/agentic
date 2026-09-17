# Plan: sign-in required + per-user usage limits

Scope: items 2 (authentication) and 3 (per-user quotas) from `auth-howto.md`, built into the
`agentic-auth` Worker, which becomes the **only** way the app reaches Lumen and the web proxy.
Status: **implemented** (2026-09-17): `auth/worker.js`, `auth/limiter.js`, gateway mode in `index.html`. Tests: `tests/limits.mjs`, `tests/integration.mjs`, `tests/gateway-app.mjs`.
**Section 8 (changes after the GLM review) overrides earlier sections where they differ.**

## 0. Goals and non-goals
- Every LLM call and every web-proxy fetch requires a valid session. No session → `401`.
- The Lumen API key lives only in the Worker (secret `LUMEN_API_KEY`). Attendees never see a key.
- One user (or a script holding one user's session) cannot exhaust the event's credits.
- CILogon code stays in place but is **disabled** by configuration until registration is approved.
- Non-goal: stopping a determined attacker who has *many* valid identities (handled by the global budget + upstream cap).

## 1. Sign-in for now: email form (+ event access code)

**Important caveat:** an email-address form on its own is *identification, not authentication*. Anyone
can type `someone@illinois.edu`. The Worker cannot verify the address without sending mail, and sending
mail from Workers needs a paid plan and an onboarded domain (see research in `auth-howto.md`).
Recommended interim gate: **email + event access code**.

- `GET /auth/config` → `{ providers: [{id:"email", type:"form"}], ... }` (CILogon omitted while disabled).
- `POST /auth/email-login` `{ email, access_code }`
  - `email`: trimmed, lowercased, must match `^[a-z0-9._%+-]+@illinois\.edu$`.
  - `access_code`: compared in constant time with secret `ACCESS_CODE` (a short phrase the trainer
    shows on the screen; rotate per event). Missing secret → email login disabled.
  - Login attempts rate-limited per client IP (`CF-Connecting-IP`): 5 per 10 min, then `429`
    (stored in the limiter Durable Object keyed `ip:<addr>`).
  - Success → session token `{typ:"session", sub:"email:<address>", method:"email", exp: now+4h}`.
    Shorter than the 8h CILogon session, because the identity is unverified.
- `EVENT_ENDS` (ISO date var): no sessions are issued after it, and existing ones are rejected.
- `DENYLIST` (comma-separated `sub`s, var) → `403` immediately (block a misbehaving account without redeploying code).
- Demo page and app show an email + access-code form when the provider type is `form`.
- Later, CILogon: add the `cilogon` block to `PROVIDERS`, set `CILOGON_CLIENT_SECRET`, optionally
  remove `ACCESS_CODE` to turn email login off. No code change. Limits key on `sub`, so they apply to both methods.
- The simulated IdP (`MOCK_IDP_PRIVATE_JWK`) is removed from production before `LUMEN_API_KEY` is set
  (already enforced: LLM proxy refuses while the simulator is on). Tests keep using it locally.

## 2. Protected routes
| Route | Auth | Limits |
|---|---|---|
| `POST /v1/chat/completions` | session | concurrency + rate + byte/token budget (section 3) |
| `GET /v1/models` | session | cheap; counted as a tiny request |
| `GET /proxy?url=` (web search + downloads) | session | concurrency shared with LLM; own byte budget; 20 MB max response; private-address targets refused |
| `/auth/*` | public | login attempts rate-limited |

The old open `agentic-proxy` Worker is retired (deleted) once the app uses the gateway, otherwise it
remains a way around the limits for its `/proxy` route.

## 3. Per-user limits

### 3.1 Where state lives
A **Durable Object `UserLimiter`, one instance per `sub`** (`idFromName(sub)`), SQLite-backed (on the
Workers free plan). Single-threaded per user, so check-and-reserve is atomic and consistent across all
Cloudflare locations. A second instance `GlobalBudget` (name `"global"`) holds event-wide totals.
Not KV: eventually consistent, and 1,000 writes/day on the free plan.

### 3.2 Request lifecycle
1. Verify session → `sub`. Check `DENYLIST`, `EVENT_ENDS`.
2. Read the body (reject > 1 MB → `413`). Parse JSON. Enforce request hygiene:
   - `model` in `ALLOWED_MODELS` (e.g. `glm-5.3-flash,deepseek-v4-flash`) → else `400`.
   - `stream` must be false/absent (limits are measured on complete responses).
   - `max_tokens` set to `min(requested || 4096, MAX_OUTPUT_TOKENS)`.
3. `limiter.acquire({ inBytes, kind })` (one DO call):
   - **Concurrency:** if a lease is active → `429 {reason:"busy"}`. Otherwise create a lease
     `{id, expires: now+180s}`. The expiry means a crashed request can't lock a user out for more than 3 minutes.
   - **Rate:** sliding window over the last 30 s of *counted* requests; if ≥ limit → `429 {reason:"rate", retry_after}`.
   - **Hourly budget:** sum over the last 60 min; if the budget is already exhausted → `429 {reason:"budget", retry_after}`.
   - **Global budget:** `GlobalBudget` check (event total) → `503 {reason:"event_budget"}`.
4. Forward to Lumen with the secret key; read the full response; `outBytes`, `usage.prompt_tokens`,
   `usage.completion_tokens`.
5. `limiter.release({ leaseId, inBytes, outBytes, tokens, model })`: records the request in the window
   (if it counts) and frees the lease. Always called in `finally`.
6. Response headers for the UI: `X-Usage-Hour-Bytes`, `X-Usage-Hour-Limit`, `X-RateLimit-Remaining`, `Retry-After` on 429.

Limits are **checked before** a request and **charged after** it (output size is unknown in advance), so a
user can overshoot by at most one request. That is acceptable because `max_tokens` bounds the overshoot.

### 3.3 Proposed numbers (all configurable vars)
| Var | Proposal | User's suggestion | Why |
|---|---|---|---|
| `MAX_CONCURRENT` | 1 | 1 | as requested |
| `TINY_BYTES` | 2 KB in **and** 2 KB out | same | …but see finding below |
| `TINY_RATE` | 30 per 60 s | (none) | tiny requests must still be capped, or a script can flood them |
| `RATE_LIMIT` | 10 per 30 s | 10 per 30 s | an LLM step takes 1–10 s, so a human-driven agent stays under ~6/30 s |
| `HOUR_BYTES` | 10 MB (in+out) | 10 MB per hour | fine as a coarse guard |
| `HOUR_TOKENS` | 1.5 M | (none) | tokens are what cost money; see cost table |
| `DAY_TOKENS` | 4 M | (none) | stops a steady all-day drain |
| `EVENT_TOKENS` (global) | 60 M | (none) | event-wide kill switch |
| `MAX_OUTPUT_TOKENS` | 4096 | (none) | bounds per-request cost and the post-charge overshoot |

**Measured finding:** in this app, the *first* LLM request of any conversation is already **3.45 KB**
(system prompt + six tool definitions) and grows each step (7.8 KB after 7 steps in the mock test; tool
results with file previews add up to 10 KB each). So the "< 2 KB in" exemption **never applies to the agent
chat**; it only matters for small endpoints (`/v1/models`, tiny web fetches). Either drop it or raise it to
~8 KB. Recommendation: keep it at 2 KB for simplicity; it is harmless.

**Cost sense-check** (Lumen list prices per 1M tokens, from `opencode.jsonc`): 10 MB ≈ 2.5 M tokens.
- `glm-5.3-flash` ($0.14 in / $0.45 out): worst case ≈ $0.40 per user-hour.
- `glm-5.2` ($1.23 / $3.97): worst case ≈ $3–4 per user-hour → 40 attendees ≈ $150/hour worst case.
Hence the model allowlist plus token budgets alongside bytes.

A typical attendee task (5–10 steps, 5–40 KB per step) is ~50–300 KB. So 10 MB/hour is roughly 30–200 tasks,
which is generous for people and still bounds scripts.

### 3.4 Client (app) changes
- Settings: API key field hidden when the gateway reports `llm_proxy: true`. Endpoint and proxies default to the gateway.
- Sign-in screen before the chat when there's no valid session (email + access code form; later a CILogon button).
- `401` → clear session, show sign-in. `429 busy` → shouldn't happen (the app is sequential); show "another tab is
  using your session". `429 rate/budget` → show a friendly message with the wait time; auto-retry once after
  `Retry-After` if ≤ 30 s. `503 event_budget` → "event budget reached, tell the trainer".
- Small usage meter ("Used 1.2 MB of 10 MB this hour").

## 4. Admin and observability
- `GET /admin/usage` (requires `ADMIN_EMAILS` session) → per-user totals for the last hour/day, from `GlobalBudget`'s index of subs.
- `console.log` one JSON line per request `{sub, model, inBytes, outBytes, tokens, ms, status}` (Workers Logs).
- Emergency: `wrangler secret put LUMEN_API_KEY` with a dummy value, or set `EVENT_ENDS` to the past.

## 5. Testing
- Extend `tests/auth.mjs` with a mock Lumen upstream (`UPSTREAM` var pointing at a local mock in `wrangler dev`):
  - email login: wrong code / non-illinois email / brute-force → 429 after 5; valid → session works.
  - concurrency: two parallel requests from one user → one `429 busy`; two users in parallel → both OK.
  - rate: 11 counted requests in 30 s → the 11th gets `429 rate` with `Retry-After`.
  - tiny exemption: 40 tiny requests pass the counted rate but hit `TINY_RATE`.
  - hourly bytes: request pushing over 10 MB → the next one is `429 budget`.
  - lease expiry: simulated crash (no release) → unlocked after the lease time (short TTL in tests).
  - model allowlist, `stream:true`, oversized body → 400/413.
  - denylist, `EVENT_ENDS` in the past → 403/401.
  - `/proxy` requires a session and is counted.
- Existing app tests (`e2e`, `stop`, `a11y`) run with a session injected.

## 6. Rollout
1. Implement in `auth/worker.js` + `auth/limiter.js` (Durable Object), with a wrangler migration for the DO class.
2. Local tests against `wrangler dev` with mock upstream; deploy; run tests against production using the simulator
   on a **separate test Worker name** (so production never enables the simulator with a real key).
3. Update `index.html` to use the gateway; publish; dry-run with 2–3 people.
4. Delete the open `agentic-proxy` Worker. Ask Lumen admins for a budget-capped event key as the final backstop.

## 7. Decisions needed
1. Email-only form (anyone can claim any address) or **email + access code** (recommended)?
2. Keep the 2 KB tiny exemption (harmless but rarely used) or remove it?
3. Add token-based hourly/daily budgets and the event-wide budget (recommended), or bytes only?
4. Which models to allow (suggest `glm-5.3-flash` and `deepseek-v4-flash` only)?

## 8. Revisions after GLM review (glm-5.3-flash, 18 findings)

Accepted and folded into the design:

| # | Finding | Change |
|---|---|---|
| P0-1 | Email form lets one person mint unlimited identities (`a+1@`, `a+2@`…), so per-user limits are bypassable | Normalize and restrict the email to NetID form `^[a-z][a-z0-9]{2,7}@illinois\.edu$` (no `+`, dots). **`MAX_USERS`** (e.g. 60) distinct `sub`s per event in `GlobalBudget`; new identities refused after that. The global event budget becomes the real backstop until CILogon is on. |
| P0-2 | Admin endpoint impersonable via email login | Drop `/admin/usage` from v1 (use Workers Logs). If added later, require `method: "cilogon"`. |
| P0-3 | Worker forwards *any* `/v1/*` path with the real key | Hard allowlist: `GET /v1/models`, `POST /v1/chat/completions`; everything else `404`. |
| P0-4 | 40 attendees share a campus NAT IP → login limit locks people out | Count **failed** logins only, 30 per 10 min per IP, plus 5 per 10 min per (IP, email). |
| P1-5 | Someone who knows a colleague's email + the room code can hold their lease | Accepted risk until CILogon (identity then proven). Mitigations: `DENYLIST`, short lease; documented. |
| P1-6 | Durable Object failure mode undefined | **Fail closed** (`503`). Cheap in-isolate pre-filter on `/auth/email-login` before touching the DO. |
| P1-7 | `/proxy` SSRF via redirect | `redirect: "manual"`, re-validate each hop, max 3 hops. (Lower risk than stated: Cloudflare's network cannot reach campus-internal addresses, but the fix is cheap.) |
| P1-8 | `/proxy` budget incoherent | `/proxy` bytes count against the **same** `HOUR_BYTES` pool; 5 MB max per fetch. |
| P1-9 | Lease (180 s) could expire during a long upstream call | Upstream `AbortController` timeout 150 s < lease TTL 180 s. |
| P1-10 | Body size / CPU on the free plan (10 ms CPU per request) | Read the body with a streaming cap (512 KB, abort beyond), and don't trust `Content-Length`. **Measure CPU** in testing; if the free plan's 10 ms is exceeded, use Workers Paid ($5/month, 30 s CPU). |
| P1-11 | Tiny-request bookkeeping undefined; `release` without `usage` | **Remove the tiny exemption** (measured: agent requests are never < 2 KB). Every request counts for rate. Bytes are always recorded; tokens only when `usage` is present; `release` never throws. |
| P2-12 | Over-engineered for one day | Drop `DAY_TOKENS`, admin endpoint and usage meter (keep `X-Usage-*` headers only). |
| P2-13 | Verify free-tier Durable Object quotas | Verify before the event (rows written/day is the tight one: ~2 writes per request). |
| P2-15 | 4 h session expires mid-workshop | Email sessions last until `EVENT_ENDS` or 10 h, whichever is sooner. |
| P2-16 | Access code brute-force / leak | Random 8-character code per event, failed-login limits above; treat it as a room gate, not a secret. |
| P2-17 | CORS missing on error responses | All JSON responses (incl. `401/403/429/503`) carry CORS headers so the app can show the reason. |

Revised limits: `MAX_CONCURRENT=1`, `RATE_LIMIT=10/30s` (all requests), `HOUR_BYTES=10 MB` (LLM + proxy),
`HOUR_TOKENS=1.5M`, `EVENT_TOKENS=60M`, `MAX_USERS=60`, `MAX_OUTPUT_TOKENS=4096`, body cap 512 KB, proxy fetch cap 5 MB.

## 9. Final decisions (user, 2026-09-17) — these override everything above

1. **Sign-in: email only, no access code.** CILogon will replace it soon. Anyone can type an address, so
   until CILogon is on, the protections are: NetID-shaped addresses only, `MAX_USERS` distinct users,
   a per-IP cap on *new* identities, per-user limits and the event token budget.
2. **Tiny-request exemption dropped.** Every request counts.
3. **Tokens added.** Use `usage.total_tokens` from Lumen when present; otherwise estimate `ceil(bytes / 4)`.
4. **No model allowlist.** (`max_tokens` is still capped at `MAX_OUTPUT_TOKENS`.)

### Implementation notes
- The whole limited request (check → upstream fetch → record) runs **inside the user's Durable Object**.
  The in-memory "busy" flag gives no-concurrency without leases: the flag is set before any outgoing call
  (storage operations keep input gates closed, so check-and-set is atomic), and if the object restarts the
  flag is gone, so nobody stays locked out. One storage write per request.
- `GlobalBudget` Durable Object: event token total, distinct-user registry (`MAX_USERS`), new-identities-per-IP window.
- Defaults: `RATE_LIMIT=10`, `RATE_WINDOW_S=30`, `HOUR_BYTES=10000000`, `HOUR_TOKENS=1500000`,
  `EVENT_TOKENS=60000000`, `MAX_USERS=60`, `NEW_USERS_PER_IP=60` per 10 min, `MAX_OUTPUT_TOKENS=4096`,
  `MAX_BODY_BYTES=512000`, `PROXY_MAX_BYTES=5000000`, `UPSTREAM_TIMEOUT_MS=150000`, email sessions 10 h (or until `EVENT_ENDS`).

### API contract (Worker ⇄ app)
- `GET /auth/config` → `{ providers: [{ id, label, type: "form" | "redirect" }], llm_proxy }`
- `POST /auth/email-login` `{ email }` → `200 { session, user }` or an error (below)
- Redirect providers: `/auth/login?provider=<id>&return_to=<page URL>` → back to `page#session=…` or `#auth_error=…`
- Protected, with `Authorization: Bearer <session>`: `GET /v1/models`, `POST /v1/chat/completions`, `GET /proxy?url=<encoded>`
- Errors are JSON `{ error, message, retry_after? }`. Codes: `not_signed_in` 401, `forbidden` 403,
  `busy` / `rate` / `hour_bytes` / `hour_tokens` / `login_rate` 429 (with `Retry-After`), `event_budget` / `max_users` 503,
  `too_large` 413, `bad_request` 400, `not_found` 404, `upstream_timeout` 504, `upstream_error` 502.
- Success headers: `X-Usage-Hour-Bytes`, `X-Usage-Hour-Tokens`, `X-Limit-Hour-Bytes`, `X-Limit-Hour-Tokens`
  (exposed to the page via `Access-Control-Expose-Headers`, together with `Retry-After`).

## 10. Change (user, 2026-09-17): no events — always available

People should be able to use the service at any time, so the event concept is removed:
`EVENT_ID`, `EVENT_ENDS`, `MAX_USERS` and the event token total are gone.
They are replaced by **`DAILY_TOKENS`**, a budget shared by all users over a **rolling 24 hours** (hourly buckets
in the `GlobalBudget` Durable Object; `503 daily_budget` with `retry_after` when exhausted; `0` disables it).
Per-user limits, the per-IP new-sign-in window and `DENYLIST` are unchanged.
