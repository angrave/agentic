#!/usr/bin/env python3
"""Zero-dependency local server for demos.

Serves index.html and, on the same origin (so no CORS problems):
  /v1/...            -> forwarded to the LLM API (default https://lumen.ncsa.illinois.edu/v1)
  /proxy?url=<enc>   -> fetches any http(s) URL (used for web search and downloads)

Usage:  python3 proxy/local_proxy.py [--port 8000] [--upstream https://lumen.ncsa.illinois.edu/v1]
Then open the printed URL.
"""
import argparse
import ipaddress
import socket
import os
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UPSTREAM = "https://lumen.ncsa.illinois.edu/v1"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"


def is_public(url):
    """Refuse proxying to localhost / private networks (stops use as an SSRF relay)."""
    host = urllib.parse.urlparse(url).hostname or ""
    try:
        addrs = {ai[4][0] for ai in socket.getaddrinfo(host, None)}
    except OSError:
        return False
    return all(ipaddress.ip_address(a.split("%")[0]).is_global for a in addrs)


class NoRedirectToPrivate(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not is_public(newurl):
            raise urllib.error.HTTPError(newurl, 403, "redirect to private address blocked", headers, fp)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


OPENER = urllib.request.build_opener(NoRedirectToPrivate)
MAX_BYTES = 100 * 1024 * 1024


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def _forward(self, url, method="GET", body=None, headers=None):
        req = urllib.request.Request(url, data=body, method=method, headers=headers or {})
        try:
            resp = OPENER.open(req, timeout=600)
            status, data, rh = resp.status, resp.read(MAX_BYTES), resp.headers
        except urllib.error.HTTPError as e:
            status, data, rh = e.code, e.read(), e.headers
        except Exception as e:  # network failure
            status, data, rh = 502, f"Proxy error: {e}".encode(), {}
        self.send_response(status)
        self.send_header("Content-Type", rh.get("Content-Type", "application/octet-stream") if rh else "text/plain")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()

    def _api(self, method):
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0)) if method == "POST" else None
        headers = {k: v for k, v in self.headers.items() if k.lower() in ("authorization", "content-type")}
        self._forward(UPSTREAM + self.path[len("/v1"):], method, body, headers)

    def do_GET(self):
        if self.path.startswith("/v1/"):
            return self._api("GET")
        if self.path.startswith("/proxy?"):
            url = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).get("url", [""])[0]
            if not url.startswith(("http://", "https://")):
                return self.send_error(400, "url must be http(s)")
            if not is_public(url):
                return self.send_error(403, "private/local addresses are not allowed")
            return self._forward(url, headers={"User-Agent": UA, "Accept": "*/*"})
        return super().do_GET()

    def do_POST(self):
        if self.path.startswith("/v1/"):
            return self._api("POST")
        self.send_error(404)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--host", default="127.0.0.1", help="use 0.0.0.0 to share on the LAN (the proxy is then usable by others)")
    ap.add_argument("--upstream", default=UPSTREAM)
    args = ap.parse_args()
    UPSTREAM = args.upstream.rstrip("/")
    print(f"Serving {ROOT}; API -> {UPSTREAM}")
    print(f"Open: http://localhost:{args.port}/#endpoint=/v1&proxy=/proxy%3Furl%3D%7Benc%7D&reader=/proxy%3Furl%3D%7Benc%7D")
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()
