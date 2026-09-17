// SIMULATED identity provider for demos and tests. It speaks just enough OpenID Connect
// (discovery, JWKS, authorize, token with PKCE) to exercise the real login code path.
// It issues FAKE identities chosen from a form — never enable it together with LUMEN_API_KEY.
// Enabled when the MOCK_IDP_PRIVATE_JWK secret is set. Codes are stateless HMAC-signed blobs.

const enc = new TextEncoder();
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlJson = (o) => b64url(enc.encode(JSON.stringify(o)));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const MOCK_IDENTITIES = {
  illinois: {
    label: "Alex Illini — Illinois NetID via Shibboleth (should be ALLOWED)",
    claims: { idp: "urn:mace:incommon:uiuc.edu", idp_name: "University of Illinois Urbana-Champaign", eppn: "aillini@illinois.edu", email: "aillini@illinois.edu", name: "Alex Illini", given_name: "Alex", family_name: "Illini", affiliation: "member@illinois.edu;faculty@illinois.edu" },
  },
  google: {
    label: "Pat Public — personal Google account (should be DENIED)",
    claims: { idp: "http://google.com/accounts/o8/id", idp_name: "Google", email: "pat.public@gmail.com", name: "Pat Public" },
  },
  spoof: {
    label: "Sam Spoof — Google login claiming an @illinois.edu email (should be DENIED)",
    claims: { idp: "http://google.com/accounts/o8/id", idp_name: "Google", email: "sspoof@illinois.edu", name: "Sam Spoof" },
  },
};

export async function handleMockIdp(req, env, url, { signToken, verifyToken }) {
  const issuer = url.origin + "/mock-idp";
  const path = url.pathname.slice("/mock-idp".length);
  const jwk = JSON.parse(env.MOCK_IDP_PRIVATE_JWK);
  const publicJwk = { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", use: "sig", kid: jwk.kid || "mock-1" };
  const jsonResp = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

  if (path === "/.well-known/openid-configuration") {
    return jsonResp({
      issuer, authorization_endpoint: issuer + "/authorize", token_endpoint: issuer + "/token", jwks_uri: issuer + "/jwks",
      response_types_supported: ["code"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"],
      code_challenge_methods_supported: ["S256"],
    });
  }
  if (path === "/jwks") return jsonResp({ keys: [publicJwk] });

  if (path === "/authorize") {
    const q = url.searchParams;
    if (req.method === "POST") {
      const form = await req.formData();
      const who = MOCK_IDENTITIES[form.get("identity")];
      if (!who) return new Response("Unknown identity", { status: 400 });
      const code = await signToken({
        typ: "mock_code", claims: who.claims, sub: "mock-" + form.get("identity"), nonce: form.get("nonce"),
        client_id: form.get("client_id"), redirect_uri: form.get("redirect_uri"), code_challenge: form.get("code_challenge"),
        exp: Math.floor(Date.now() / 1000) + 120,
      }, env.SESSION_SECRET);
      const back = new URL(form.get("redirect_uri"));
      back.searchParams.set("code", code);
      back.searchParams.set("state", form.get("state"));
      return new Response(null, { status: 302, headers: { Location: back.toString() } });
    }
    const hidden = ["client_id", "redirect_uri", "state", "nonce", "code_challenge"].map((k) => `<input type="hidden" name="${k}" value="${esc(q.get(k) || "")}">`).join("");
    const options = Object.entries(MOCK_IDENTITIES).map(([id, v], i) =>
      `<div class="opt"><input type="radio" name="identity" id="id-${id}" value="${id}"${i ? "" : " checked"}><label for="id-${id}">${esc(v.label)}</label></div>`).join("");
    return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Simulated sign-in</title><style>body{font:15px/1.5 system-ui,sans-serif;max-width:620px;margin:0 auto;padding:24px 16px;color:#1d2330;background:#fff}
.warn{background:#fff4e5;border:1px solid #b35c00;border-radius:8px;padding:10px 12px}.opt{margin:8px 0}button{font:inherit;padding:8px 16px;border-radius:8px;border:1px solid #1f5fbf;background:#1f5fbf;color:#fff;cursor:pointer}
:focus-visible{outline:3px solid #1f5fbf;outline-offset:2px}</style></head><body><main>
<h1>Simulated identity provider</h1>
<p class="warn"><strong>Demo only.</strong> This page stands in for CILogon / Illinois Shibboleth so the login flow can be tried without a registered client. The identities below are fake.</p>
<form method="post"><fieldset><legend>Sign in as</legend>${options}</fieldset>${hidden}<p><button type="submit">Continue</button></p></form>
</main></body></html>`, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
  }

  if (path === "/token" && req.method === "POST") {
    const form = await req.formData();
    const code = await verifyToken(form.get("code"), env.SESSION_SECRET, "mock_code");
    if (!code) return jsonResp({ error: "invalid_grant", error_description: "bad or expired code" }, 400);
    if (form.get("client_id") !== code.client_id || form.get("redirect_uri") !== code.redirect_uri) return jsonResp({ error: "invalid_grant", error_description: "client_id/redirect_uri mismatch" }, 400);
    const challenge = b64url(await crypto.subtle.digest("SHA-256", enc.encode(form.get("code_verifier") || "")));
    if (challenge !== code.code_challenge) return jsonResp({ error: "invalid_grant", error_description: "PKCE verification failed" }, 400);
    const t = Math.floor(Date.now() / 1000);
    const header = { alg: "RS256", typ: "JWT", kid: publicJwk.kid };
    const payload = { iss: issuer, aud: code.client_id, sub: code.sub, nonce: code.nonce, iat: t, exp: t + 300, ...code.claims };
    const key = await crypto.subtle.importKey("jwk", { ...jwk, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
    const body = b64urlJson(header) + "." + b64urlJson(payload);
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(body));
    return jsonResp({ access_token: "mock-access-token", token_type: "Bearer", expires_in: 300, id_token: body + "." + b64url(sig) });
  }
  return new Response("Not found", { status: 404 });
}
