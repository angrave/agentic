// Durable Objects that enforce usage limits.
//
// UserLimiter (one per signed-in user, named by session `sub`): runs the whole limited request —
//   check limits → call upstream → record usage — so that "one request at a time" is a simple
//   in-memory flag. The flag is set before any outgoing call; storage operations keep the object's
//   input gate closed, so check-and-set is atomic. If the object restarts, the flag is gone and the
//   user is not left locked out.
// GlobalBudget (one instance per EVENT_ID): event-wide token total, registry of distinct users,
//   and a per-IP window for newly created identities.

const HOUR_MS = 3600_000;

export function limits(env) {
  const n = (k, d) => (env[k] !== undefined && env[k] !== "" ? Number(env[k]) : d);
  return {
    rate: n("RATE_LIMIT", 10),
    rateWindowMs: n("RATE_WINDOW_S", 30) * 1000,
    hourBytes: n("HOUR_BYTES", 10_000_000),
    hourTokens: n("HOUR_TOKENS", 1_500_000),
    eventTokens: n("EVENT_TOKENS", 60_000_000),
    maxUsers: n("MAX_USERS", 60),
    newUsersPerIp: n("NEW_USERS_PER_IP", 60),
    newUsersWindowMs: n("NEW_USERS_WINDOW_S", 600) * 1000,
    maxOutputTokens: n("MAX_OUTPUT_TOKENS", 4096),
    maxBodyBytes: n("MAX_BODY_BYTES", 512_000),
    proxyMaxBytes: n("PROXY_MAX_BYTES", 5_000_000),
    llmMaxResponseBytes: n("LLM_MAX_RESPONSE_BYTES", 5_000_000),
    upstreamTimeoutMs: n("UPSTREAM_TIMEOUT_MS", 150_000),
    upstream: (env.UPSTREAM || "https://lumen.ncsa.illinois.edu/v1").replace(/\/+$/, ""),
  };
}

// One GlobalBudget per event: changing EVENT_ID starts a fresh user registry and token total.
export function globalBudget(env) {
  return env.GLOBAL.get(env.GLOBAL.idFromName("event:" + (env.EVENT_ID || "default")));
}

export function errorResponse(status, error, message, retryAfter) {
  const headers = { "Content-Type": "application/json" };
  const body = { error, message };
  if (retryAfter !== undefined) {
    body.retry_after = Math.max(1, Math.ceil(retryAfter));
    headers["Retry-After"] = String(body.retry_after);
  }
  return new Response(JSON.stringify(body), { status, headers });
}

const fmtMB = (b) => (b / 1e6).toFixed(1) + " MB";

// Seconds until enough old events leave the hour window for `sum(field)` to drop below `limit`.
function secondsUntilUnder(events, field, limit, now) {
  let total = events.reduce((s, e) => s + e[field], 0);
  for (const e of events) {
    if (total < limit) break;
    total -= e[field];
    if (total < limit) return (e.t + HOUR_MS - now) / 1000;
  }
  return 60;
}

// ---------- web proxy target checks ----------
export function isBlockedHost(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (h.includes(":")) return h === "::1" || h === "::" || /^f[cd]/.test(h) || h.startsWith("fe80") || h.startsWith("::ffff:");
  return false;
}

async function readCapped(resp, maxBytes) {
  const reader = resp.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(0), tooLarge: false };
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel(); return { tooLarge: true, size }; }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) { bytes.set(c, off); off += c.byteLength; }
  return { bytes, tooLarge: false };
}

export class UserLimiter {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.busy = false;
    this.events = null; // [{ t, bytes, tokens, kind }]
  }

  async fetch(request) {
    const job = await request.json(); // { kind: "llm" | "proxy", sub, method, path, body?, url? }
    const L = limits(this.env);
    const now = Date.now();
    if (this.events === null) this.events = (await this.ctx.storage.get("events")) || [];
    this.events = this.events.filter((e) => e.t > now - HOUR_MS);

    if (this.busy) return errorResponse(429, "busy", "Your previous request is still running. Only one request at a time is allowed per person.", 3);
    const recent = this.events.filter((e) => e.t > now - L.rateWindowMs);
    if (recent.length >= L.rate) {
      return errorResponse(429, "rate", `Too many requests: at most ${L.rate} every ${L.rateWindowMs / 1000} seconds.`, (recent[0].t + L.rateWindowMs - now) / 1000);
    }
    const hourBytes = this.events.reduce((s, e) => s + e.bytes, 0);
    if (hourBytes >= L.hourBytes) {
      return errorResponse(429, "hour_bytes", `Hourly data limit reached (${fmtMB(L.hourBytes)} per hour).`, secondsUntilUnder(this.events, "bytes", L.hourBytes, now));
    }
    const hourTokens = this.events.reduce((s, e) => s + e.tokens, 0);
    if (hourTokens >= L.hourTokens) {
      return errorResponse(429, "hour_tokens", `Hourly token limit reached (${L.hourTokens.toLocaleString("en-US")} tokens per hour).`, secondsUntilUnder(this.events, "tokens", L.hourTokens, now));
    }

    // Reserve before any outgoing call.
    this.busy = true;
    const ev = { t: now, bytes: 0, tokens: 0, kind: job.kind };
    this.events.push(ev);
    const global = globalBudget(this.env);
    let resp;
    try {
      if (job.kind === "llm") {
        const g = await (await global.fetch("https://global/check")).json();
        if (g.tokens >= L.eventTokens) {
          resp = errorResponse(503, "event_budget", "The event's shared token budget has been used up. Please tell the trainer.");
        } else {
          resp = await this.llm(job, L, ev);
        }
      } else {
        resp = await this.proxy(job, L, ev);
      }
    } catch (e) {
      resp = errorResponse(502, "upstream_error", "Upstream request failed: " + (e.message || e));
    } finally {
      this.busy = false;
      try {
        await this.ctx.storage.put("events", this.events);
        if (ev.tokens) await global.fetch("https://global/add", { method: "POST", body: JSON.stringify({ tokens: ev.tokens }) });
      } catch (e) {
        console.log(JSON.stringify({ msg: "usage record failed", sub: job.sub, err: String(e) }));
      }
    }
    const headers = new Headers(resp.headers);
    headers.set("X-Usage-Hour-Bytes", String(this.events.reduce((s, e) => s + e.bytes, 0)));
    headers.set("X-Usage-Hour-Tokens", String(this.events.reduce((s, e) => s + e.tokens, 0)));
    headers.set("X-Limit-Hour-Bytes", String(L.hourBytes));
    headers.set("X-Limit-Hour-Tokens", String(L.hourTokens));
    console.log(JSON.stringify({ sub: job.sub, kind: job.kind, path: job.path || job.url, status: resp.status, bytes: ev.bytes, tokens: ev.tokens, ms: Date.now() - now }));
    return new Response(resp.body, { status: resp.status, headers });
  }

  async llm(job, L, ev) {
    const inBytes = job.body ? new TextEncoder().encode(job.body).byteLength : 0;
    ev.bytes = inBytes;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), L.upstreamTimeoutMs);
    let upstream;
    try {
      upstream = await fetch(L.upstream + job.path, {
        method: job.method, signal: ctl.signal, body: job.method === "POST" ? job.body : undefined,
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + this.env.LUMEN_API_KEY },
      });
    } catch (e) {
      clearTimeout(timer);
      if (e.name === "AbortError") return errorResponse(504, "upstream_timeout", `The model did not answer within ${L.upstreamTimeoutMs / 1000} seconds.`);
      throw e;
    }
    const { bytes, tooLarge } = await readCapped(upstream, L.llmMaxResponseBytes).finally(() => clearTimeout(timer));
    if (tooLarge) { ev.bytes += L.llmMaxResponseBytes; ev.tokens = Math.ceil(ev.bytes / 4); return errorResponse(502, "upstream_error", "Upstream response too large."); }
    ev.bytes += bytes.byteLength;
    let tokens = 0;
    try { tokens = Number(JSON.parse(new TextDecoder().decode(bytes)).usage?.total_tokens) || 0; } catch {}
    // Estimate when the API doesn't report usage (≈ 4 bytes per token).
    ev.tokens = tokens || (job.path.endsWith("/chat/completions") ? Math.ceil(ev.bytes / 4) : 0);
    return new Response(bytes, { status: upstream.status, headers: { "Content-Type": upstream.headers.get("Content-Type") || "application/json" } });
  }

  async proxy(job, L, ev) {
    let url = job.url;
    for (let hop = 0; hop <= 3; hop++) {
      let target;
      try { target = new URL(url); } catch { return errorResponse(400, "bad_request", "Invalid URL."); }
      if (!/^https?:$/.test(target.protocol)) return errorResponse(400, "bad_request", "Only http(s) URLs can be fetched.");
      if (isBlockedHost(target.hostname)) return errorResponse(403, "forbidden", "Private or local addresses cannot be fetched.");
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 30_000);
      let r;
      try {
        r = await fetch(target, { redirect: "manual", signal: ctl.signal, headers: { "User-Agent": "Mozilla/5.0 (compatible; AgenticChatLab/1.0)", Accept: "*/*" } });
      } catch (e) {
        clearTimeout(timer);
        if (e.name === "AbortError") return errorResponse(504, "upstream_timeout", "The website did not answer within 30 seconds.");
        throw e;
      }
      if (r.status >= 300 && r.status < 400 && r.headers.get("Location")) {
        clearTimeout(timer);
        url = new URL(r.headers.get("Location"), target).toString();
        continue;
      }
      const { bytes, tooLarge, size } = await readCapped(r, L.proxyMaxBytes).finally(() => clearTimeout(timer));
      if (tooLarge) { ev.bytes = size; return errorResponse(413, "too_large", `The download is larger than the ${fmtMB(L.proxyMaxBytes)} limit.`); }
      ev.bytes = bytes.byteLength;
      return new Response(bytes, { status: r.status, headers: { "Content-Type": r.headers.get("Content-Type") || "application/octet-stream" } });
    }
    return errorResponse(502, "upstream_error", "Too many redirects.");
  }
}

export class GlobalBudget {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    const L = limits(this.env);
    const storage = this.ctx.storage;
    if (path === "/check") {
      return Response.json({ tokens: (await storage.get("tokens")) || 0, users: (await storage.get("userCount")) || 0 });
    }
    if (path === "/add") {
      const { tokens } = await request.json();
      await storage.put("tokens", ((await storage.get("tokens")) || 0) + (Number(tokens) || 0));
      return Response.json({ ok: true });
    }
    if (path === "/register") {
      const { sub, ip } = await request.json();
      if (await storage.get("user:" + sub)) return Response.json({ ok: true });
      const count = (await storage.get("userCount")) || 0;
      if (count >= L.maxUsers) {
        return errorResponse(503, "max_users", `This event is limited to ${L.maxUsers} people and is full. Please contact the trainer.`);
      }
      const now = Date.now();
      const key = "ipnew:" + (ip || "unknown");
      const recent = ((await storage.get(key)) || []).filter((t) => t > now - L.newUsersWindowMs);
      if (recent.length >= L.newUsersPerIp) {
        return errorResponse(429, "login_rate", "Too many new sign-ins from this network. Please wait a few minutes.", (recent[0] + L.newUsersWindowMs - now) / 1000);
      }
      recent.push(now);
      await storage.put({ [key]: recent, ["user:" + sub]: now, userCount: count + 1 });
      return Response.json({ ok: true, new: true });
    }
    return new Response("Not found", { status: 404 });
  }
}
