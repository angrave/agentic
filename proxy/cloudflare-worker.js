// Cloudflare Worker: CORS gateway so a static page (e.g. GitHub Pages) can reach the LLM API
// and fetch web pages. Deploy: dash.cloudflare.com -> Workers -> Create -> paste this -> Deploy.
// Then in the app set:
//   API endpoint:  https://<your-worker>.workers.dev/v1
//   CORS proxy:    https://<your-worker>.workers.dev/proxy?url={enc}
//   Reader proxy:  https://<your-worker>.workers.dev/proxy?url={enc}
// The API key is NOT stored here; the browser sends it and the worker forwards it.

const UPSTREAM = "https://lumen.ncsa.illinois.edu/v1";
// Only pages from these origins may use the worker (stops it becoming an open proxy).
const ALLOWED_ORIGINS = ["https://angrave.github.io", "http://localhost:8000", "http://127.0.0.1:8000"];

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

export default {
  async fetch(request) {
    const origin = request.headers.get("Origin") || "";
    if (!ALLOWED_ORIGINS.includes(origin)) return new Response("Origin not allowed", { status: 403 });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });

    const url = new URL(request.url);
    let upstream;
    if (url.pathname.startsWith("/v1/")) {
      upstream = new Request(UPSTREAM + url.pathname.slice(3) + url.search, {
        method: request.method,
        headers: { "Content-Type": request.headers.get("Content-Type") || "application/json", "Authorization": request.headers.get("Authorization") || "" },
        body: request.method === "POST" ? request.body : undefined,
      });
    } else if (url.pathname === "/proxy") {
      const target = url.searchParams.get("url") || "";
      if (!/^https?:\/\//.test(target)) return new Response("url must be http(s)", { status: 400, headers: cors(origin) });
      upstream = new Request(target, { headers: { "User-Agent": "Mozilla/5.0 (compatible; AgenticChatLab/1.0)", "Accept": "*/*" } });
    } else {
      return new Response("Not found", { status: 404, headers: cors(origin) });
    }
    const resp = await fetch(upstream);
    const headers = new Headers(cors(origin));
    headers.set("Content-Type", resp.headers.get("Content-Type") || "application/octet-stream");
    return new Response(resp.body, { status: resp.status, headers });
  },
};
