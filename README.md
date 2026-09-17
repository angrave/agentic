# Agentic Chat Lab

A single static web page for training sessions: attendees chat with an LLM agent that can
**run Python (pandas, openpyxl, python-docx, matplotlib) in the browser**, read and write
uploaded Excel/Word/CSV files, **search the web**, and **download** data. Every tool call is
shown as a card, and "Show raw messages" reveals exactly what is sent to the model.

- `index.html` — the whole app (Pyodide runs in a Web Worker; no build step)
- `proxy/local_proxy.py` — zero-dependency local server + API/web proxy (demo laptop)
- `proxy/cloudflare-worker.js` — CORS gateway for a GitHub Pages deployment

## Why a proxy is needed
`lumen.ncsa.illinois.edu` does not send CORS headers, so a browser page on another origin
(e.g. `angrave.github.io`) **cannot call it directly**. Most websites also block cross-origin
fetches, which affects web search and downloads. Options:

1. **Laptop demo (fastest):** `python3 proxy/local_proxy.py` then open the printed URL
   (`http://localhost:8000/#endpoint=/v1&proxy=...`). Enter the API key and model.
2. **GitHub Pages for attendees:** deploy `proxy/cloudflare-worker.js` as a free Cloudflare
   Worker (edit `ALLOWED_ORIGINS`), then use a setup link such as
   `https://angrave.github.io/agentic/#endpoint=https://NAME.workers.dev/v1&proxy=https://NAME.workers.dev/proxy%3Furl%3D%7Benc%7D&reader=https://NAME.workers.dev/proxy%3Furl%3D%7Benc%7D&model=glm-5.3-flash&key=KEY`
   **Deployed:** `https://agentic-proxy.angrave.workers.dev` (tested with Lumen, search and downloads). Setup link (add `&key=...`):
   `https://angrave.github.io/agentic/#endpoint=https://agentic-proxy.angrave.workers.dev/v1&proxy=https://agentic-proxy.angrave.workers.dev/proxy%3Furl%3D%7Benc%7D&reader=https://agentic-proxy.angrave.workers.dev/proxy%3Furl%3D%7Benc%7D&model=glm-5.3-flash`
3. Ask NCSA to enable CORS on Lumen for your Pages origin — then no API proxy is needed.

Without an own proxy the page falls back to public proxies (`r.jina.ai`, `corsproxy.io`,
`allorigins`) for web pages and search; they are rate-limited and less reliable.

## Setup link parameters (after `#`, never sent to the web server)
`endpoint`, `key`, `model`, `maxsteps`, `search` (`duckduckgo`|`wikipedia`|`searxng`),
`searxng`, `reader`, `proxy`. Proxy templates use `{url}` (raw) or `{enc}` (URL-encoded).
Values are saved in the browser's localStorage and removed from the address bar.
**Anyone with a link containing `key=` can use that key.**

## Tools given to the model
`run_python`, `list_files`, `read_file` (smart previews of xlsx/docx/csv), `write_file`,
`web_search`, `fetch_url`. Tool-calling uses the OpenAI `tools` API; tool calls emitted as
text (`<tool_call>{...}</tool_call>` or fenced JSON) are also recognised.

## Notes
- Files live in memory; reloading the page clears them. Download results with ⬇.
- "Restart Python" clears variables; uploaded/downloaded files are restored, files created
  by Python are not.
- Tested with Playwright: scripted mock-LLM test (all tools, error paths, text tool-call
  fallback, restart) and live runs against Lumen `glm-5.3-flash`.

## Tests
`cd tests && npm i && npx playwright install chromium && npm test` (mock LLM + axe-core WCAG 2.1 AA scan,
320px reflow, keyboard focus checks).
Live: run `python3 proxy/local_proxy.py`, then `LUMEN_API_KEY=... node live.mjs glm-5.3-flash`.

## License
MIT — see [LICENSE](LICENSE).

## Illinois sign-in prototype
See [auth-howto.md](auth-howto.md) and the demo at https://angrave.github.io/agentic/auth-demo/.
