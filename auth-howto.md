# Illinois-only sign-in for a static GitHub Pages app

**Question:** can a static GitHub Pages site plus a Cloudflare Worker restrict use to University of
Illinois people (Illinois NetID/Shibboleth, Google, Microsoft, via CILogon)?
**Answer:** yes. The Worker does the login, checks the identity, and hands the page a short-lived
session token. A working prototype is deployed:

- Demo page: <https://angrave.github.io/agentic/auth-demo/>
- Worker: <https://agentic-auth.angrave.workers.dev> (source: [`auth/worker.js`](auth/worker.js))

The prototype currently uses a **simulated identity provider** (clearly labelled, fake identities),
because real CILogon/Google clients have to be registered by a person first. The login code path is the
real one; switching to CILogon is a configuration change (see [Going live](#going-live-with-cilogon)).

## How it works

```mermaid
sequenceDiagram
  participant B as Browser (github.io page)
  participant W as Cloudflare Worker
  participant I as Identity provider (CILogon → Illinois Shibboleth)
  participant L as Lumen LLM API
  B->>W: GET /auth/login?provider=cilogon&return_to=page
  W->>B: 302 to IdP (PKCE, state, nonce; idphint=Illinois) + short-lived login cookie
  B->>I: NetID login (Duo)
  I->>B: 302 to W /auth/callback?code
  B->>W: /auth/callback?code (+ login cookie)
  W->>I: exchange code (client secret stays in Worker)
  I->>W: ID token (signed JWT)
  W->>W: verify signature, iss, aud, exp, nonce; check rules (idp == Illinois)
  W->>B: 302 to page#session=<HMAC-signed token, 8h>
  B->>W: /v1/chat/completions  Authorization: Bearer <session>
  W->>L: same request + real Lumen API key (Worker secret)
```

Design decisions (from the research):

| Decision | Why |
|---|---|
| The Worker is the OIDC client, not the browser | CILogon *public* (browser-only) clients get only `openid` → just `sub`, no `idp`/email, so they cannot prove Illinois membership. A confidential client needs a secret, which only the Worker can keep. |
| Session token in `Authorization: Bearer`, not a cookie | `angrave.github.io` and `*.workers.dev` are different sites; Safari blocks and Firefox partitions third-party cookies. |
| Token returned in the URL **fragment** and removed immediately | Fragments are never sent to servers or logged by GitHub Pages. Stored in `sessionStorage` (gone when the tab closes). |
| Check the IdP, not the email domain | Through CILogon, a Google or GitHub login can carry an `@illinois.edu` email that Illinois did not vouch for. Only `idp == urn:mace:incommon:uiuc.edu` proves an Illinois NetID login. The demo includes a "spoofed email" identity that is correctly denied. |
| Signed token types (`session`, `login_tx`, `mock_code`) | Prevents one kind of signed blob from being replayed as another. |

## Identity options compared

| Option | Covers | Registration | Verdict |
|---|---|---|---|
| **CILogon** (confidential client) | Illinois Shibboleth/NetID (+ Google, Microsoft, GitHub, but those are rejected by our rule) | Free for academic use; form at <https://cilogon.org/oauth2/register>; human approval, ~1 business day | **Recommended.** Strongest proof of Illinois affiliation (`idp`, `eppn`, `affiliation`). |
| **Google** (Illinois Google Workspace) | `netid@illinois.edu` Google accounts | Google Cloud OAuth client in a personal project, "External", openid/email/profile only (no verification needed) | Fast to set up. Check `hd == "illinois.edu"` + `email_verified`. **Unverified:** whether Illinois' Workspace admins block unconfigured third-party apps (`Error 400: admin_policy_enforced`); only a real NetID test will tell. |
| **Microsoft Entra** | Illinois Microsoft 365 accounts | App registration; Illinois tenant `44467e6f-462c-4ea2-823f-7800de5434e3` | Likely blocked: Illinois requires admin consent for apps from unverified publishers ([policy](https://answers.uillinois.edu/illinois/page.php?id=138586)). Ask office365@illinois.edu. Check `tid`. |
| **Illinois Shibboleth/Entra directly** | NetID | Via Technology Services IAM (iTrust; techservices-iamu@illinois.edu) | Possible, no third party, but slower for a side project than CILogon. |
| **Cloudflare Access** (Zero Trust) | One-time email PIN restricted to `@illinois.edu`, or Google/Entra/OIDC/SAML | None for email PIN | Free up to **50 users (seats)**; Access can protect `workers.dev` directly. But Access's cookie is third-party for a github.io page, so the app would need to be **served from the Worker itself** (same origin), not GitHub Pages. Good zero-registration fallback for small groups. |

## Going live with CILogon

1. **Register** at <https://cilogon.org/oauth2/register> (use an @illinois.edu contact email):
   - Client name: `Agentic Chat Lab` · Home URL: `https://angrave.github.io/agentic/`
   - Callback URL: `https://agentic-auth.angrave.workers.dev/auth/callback` (exact; changes later need an email to help@cilogon.org)
   - Client type: **Confidential** · Scopes: `openid`, `email`, `profile`, `org.cilogon.userinfo` · Refresh tokens: no
2. When approved you receive a client ID and secret. Store the secret **yourself** (don't paste it into chats or commits):
   `cd auth && npx wrangler secret put CILOGON_CLIENT_SECRET`
3. Put the client ID into `PROVIDERS` in [`auth/wrangler.toml`](auth/wrangler.toml) (a ready-made `cilogon` block is in the comments), then `npx wrangler deploy`.
4. Turn off the simulator and add the LLM key: `npx wrangler secret delete MOCK_IDP_PRIVATE_JWK`, then
   `npx wrangler secret put LUMEN_API_KEY`.
5. Test with a real NetID (allowed) and a personal Gmail via CILogon (denied).

Rules used for CILogon: `idp` equals `urn:mace:incommon:uiuc.edu`. Optional extra: `affiliation`
`contains` `member@illinois.edu` (excludes e.g. some guest accounts; attribute release can vary, so test first).

## Gateway with sign-in and usage limits (implemented)

The Worker is now a full gateway for the app (design and GLM review: [`auth-limits-plan.md`](auth-limits-plan.md)).

- **Sign-in:** interim email form (`EMAIL_LOGIN="true"`). Only NetID-shaped `netid@illinois.edu` addresses are
  accepted. **This does not prove identity.** Anyone can type an address, so the limits below are the protection
  until CILogon is enabled.
- **Only these routes, all requiring a session:** `GET /v1/models`, `POST /v1/chat/completions`, `GET /proxy?url=`.
  The Lumen key is added by the Worker; `max_tokens` is capped; streaming and bodies > 512 KB are refused.
- **Per-user limits** (a Durable Object per user): one request at a time, 10 requests per 30 s,
  10 MB and 1.5 M tokens per rolling hour (tokens from Lumen's `usage`, or estimated as bytes ÷ 4).
- **Shared safeguards** (a single Durable Object): 60 M tokens across all users over a rolling 24 hours
  (`DAILY_TOKENS`, `0` to disable), and at most 60 new sign-ins per IP per 10 minutes. `DENYLIST` blocks accounts.
  There are no events or end dates: people can use it any time.
- **Web proxy:** private and local addresses are blocked (redirects included), downloads are capped at 5 MB, and
  they count toward the user's hourly bytes.
- **App:** open `https://angrave.github.io/agentic/#gateway=https://agentic-auth.angrave.workers.dev&model=glm-5.3-flash`.
  The app then asks attendees to sign in, sends no API key, and waits and retries automatically on short rate limits.

**To turn LLM access on** (currently off in production):
```
cd auth
npx wrangler secret delete MOCK_IDP_PRIVATE_JWK   # the simulated IdP must be off
npx wrangler secret put LUMEN_API_KEY             # ideally a key with a spending cap
# edit wrangler.toml limits if needed (e.g. DAILY_TOKENS); then:
npx wrangler deploy
```
Once that works, delete the old open proxy (`npx wrangler delete agentic-proxy`) so the limits can't be bypassed.

## Keeping the Lumen API key in the Worker

The prototype already supports this: set `LUMEN_API_KEY` as a Worker secret and the Worker adds it to
upstream requests. Browsers only ever hold their own session token.

- **Better:** the key can't be copied out of a setup link, browser storage or the "raw messages" view, and
  rotating it is one `wrangler secret put` with no need to re-share links.
- **But:** the Worker becomes the thing to protect. Anyone holding a valid session token can spend the
  key's credits until the token expires, so the protections below matter more.

## Stopping one user (or someone who reverse-engineers the endpoint) using all the credits

Layered, strongest first:

1. **Budget-capped key upstream.** Ask the Lumen admins for a dedicated key for this service with a
   spending limit and expiry (Lumen reports per-model costs, which suggests a LiteLLM-style gateway that
   supports per-key budgets; *unverified*, so ask). The cap still holds if everything else fails.
2. **Authentication.** Without an Illinois login there is no session token; a script that finds the Worker
   URL gets `401`. The `Origin` check only stops other websites, not scripts, so it is not a security control
   on its own.
3. **Per-user quotas in the Worker** (implemented; see above. Original proposal:)
   - A **Durable Object per user** (keyed by the session `sub`, i.e. the NetID) that records the
     `usage.total_tokens` the Worker sees in each response, and refuses with `429` once an hourly budget is
     reached. Durable Objects give strongly consistent counters and are on the Workers free plan.
     KV is not suitable: eventually consistent, with 1,000 writes/day on the free plan.
   - The Workers **Rate Limiting binding** for requests per minute per user (cheap burst protection).
   - A **global budget** counter (rolling 24 hours) as a kill switch for the whole service.
4. **Request hygiene in the Worker:** allowlist of models, cap `max_tokens`, cap request body size and number
   of messages, reject streaming if not needed.
5. **Short sessions and revocation:** e.g. 8-hour tokens, and a denylist of `sub`s to block a misbehaving account.
6. **Visibility:** log `sub`, model and tokens per request (Workers Logs) so heavy users are visible.

## Testing

`tests/auth.mjs` (Playwright) drives the demo page through the Worker and checks: Illinois identity allowed;
personal Google and spoofed-email identities denied; the session token is stripped from the URL; `401`
without a token; a tampered token, a replayed login cookie, a foreign `return_to` and a foreign `Origin`
are all rejected; the LLM proxy is refused while the simulator is on.

```
cd auth && npx wrangler dev --port 8787        # needs auth/.dev.vars with SESSION_SECRET and MOCK_IDP_PRIVATE_JWK
cd tests && node auth.mjs    # live: PAGE=https://angrave.github.io PAGE_PATH=/agentic/auth-demo/ WORKER=https://agentic-auth.angrave.workers.dev node auth.mjs
```

## Sources

- CILogon OIDC docs <https://www.cilogon.org/oidc>, FAQ <https://www.cilogon.org/faq>, discovery <https://cilogon.org/.well-known/openid-configuration>
- Google ID token verification <https://developers.google.com/identity/gsi/web/guides/verify-google-id-token>
- Illinois Microsoft 365 app integration policy <https://answers.uillinois.edu/illinois/page.php?id=138586>
- Illinois authentication options for IT pros <https://answers.illinois.edu/illinois/132408>
- Cloudflare Access for Workers <https://developers.cloudflare.com/workers/configuration/cloudflare-access/>, seats <https://developers.cloudflare.com/cloudflare-one/team-and-resources/users/seat-management/>, CORS <https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/cors/>
