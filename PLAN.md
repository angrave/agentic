# Agentic Chat Trainer — Plan

Goal: a single static web page (GitHub Pages / any static host) that teaches people how an
LLM agent works by letting them chat with one that runs *entirely in their browser*:
Python (Pyodide + pandas) in a virtual file system, uploaded Excel/Word/CSV files, web
search + download, backed by an OpenAI-compatible LLM on lumen.ncsa.illinois.edu.

## Architecture
- `index.html` — one file, no build step. Plain JS (ES modules not required), inline CSS.
- Pyodide (pinned, from cdn.jsdelivr.net) loaded in a **Web Worker** so long Python runs
  don't freeze the UI and can be killed (terminate + restart worker = "Stop").
  - Worker preloads `pandas`, `micropip`; installs `openpyxl`, `python-docx` via micropip;
    `matplotlib` loaded on demand (`loadPackagesFromImports`).
  - Working dir `/home/pyodide/work` (MEMFS). Main thread keeps a mirror copy of uploads so
    a worker restart can restore files.
- LLM client: `fetch(POST {endpoint}/chat/completions)` with `tools` (OpenAI function
  calling), non-streaming (simpler, robust). Agent loop: send → if `tool_calls` execute each →
  append `role:tool` messages → repeat until plain answer or max steps (default 15).
- Fallback parser for models that emit tool calls as text (`<tool_call>{...}</tool_call>`,
  or fenced JSON `{"name":..,"arguments":..}`) so weaker models still work.

## Settings
- Endpoint (default `https://lumen.ncsa.illinois.edu/v1`), API key, model (dropdown filled
  from `GET /models`, free text allowed), max steps, search provider, CORS proxy prefix.
- Can be supplied in URL **hash** (`#key=...&model=...&endpoint=...`) — hash is never sent to
  the web server. Saved to localStorage; hash is stripped from the address bar after reading.
- "Share link" button produces the hash URL for trainers.

## Tools exposed to the model
1. `run_python(code)` — run in Pyodide; returns stdout/stderr/last-expression repr/traceback
   (truncated ~8 KB). New image files (png/jpg/svg) are shown in chat.
2. `list_files()` — name, size, modified time of the work dir (recursive).
3. `read_file(path, max_chars)` — smart preview: csv/txt/md/json raw text; xlsx → sheet names +
   head of each sheet (pandas); docx → paragraphs + tables (python-docx); pdf → note to use
   Python; binary → size/type.
4. `write_file(path, content)` — create text files.
5. `web_search(query)` — providers: DuckDuckGo HTML via reader proxy (default, no key),
   Wikipedia API (CORS-native), or a user-supplied SearXNG URL. Returns title/url/snippet list.
6. `fetch_url(url, save_as?)` — direct fetch; on CORS failure retry via proxy prefix
   (default `https://r.jina.ai/` for readable text; raw proxy configurable). HTML → text
   returned (truncated); binaries/CSV/XLSX saved into the work dir.

## UI (training-oriented)
- Left: chat. Right: Files panel (drag-drop upload, download, delete, preview) + settings.
- Every tool call rendered as an expandable card: tool name, arguments (code highlighted as
  monospace), result, duration. Toggle "show raw messages" to reveal the full JSON conversation
  sent to the LLM — the key teaching moment.
- Status line: Python loading progress, model thinking, step n/max. Stop button.
- Example prompt chips ("Summarize the uploaded spreadsheet", "Plot column X", "Search the web
  for … and save a CSV", "Convert the Word table to Excel").
- Clear chat / reset files. Download a sample dataset button (generated in Python) so a demo
  works with no uploads.

## Security / robustness
- Key only in browser storage; warn that anyone with the hash link can use the key.
- Tool output truncated; model output rendered as escaped text + minimal markdown (no raw HTML).
- Handle HTTP errors, non-JSON, missing `tool_calls`, malformed JSON arguments (report back to
  model as tool error so it can retry).

## Testing
- Local static server + Playwright (headless Chromium) with a **mock OpenAI server** that
  scripts tool calls → verifies Python runs, xlsx/docx read, files listed, loop terminates.
- Manual/automated smoke test against real Lumen model if network allows.

## Todo
- [x] Write index.html (UI, settings, agent loop, parser)
- [x] worker (inline Blob) with Pyodide + tools
- [x] web_search / fetch_url with proxy fallback
- [x] mock server + Playwright tests; sample xlsx/docx fixtures
- [x] Real Lumen smoke test
- [x] README with deploy + hash-link instructions

## Findings during build
- Lumen sends no CORS headers → browser can't call it directly. Added proxy/local_proxy.py
  (demo laptop) and proxy/cloudflare-worker.js (GitHub Pages).
- openpyxl is not a Pyodide built-in → installed via micropip.
- GLM review fixes applied: DataFrame repr crash, key read from query string, Stop not
  killing Python, open LAN proxy/SSRF, null content + `name` on tool msgs, retries on
  429/5xx, history compaction, worker crash hangs, upload size cap.
