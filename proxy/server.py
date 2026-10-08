#!/usr/bin/env python3
# ============================================================
#  Marshall CODE · Gateway Web — local helper server
#  ------------------------------------------------------------
#  * Static file server for the web app (./index.html etc.)
#  * Same-origin reverse proxy for codepresets.marshall.com
#    (whose CORS policy only allows Origin: https://marshall.com)
#  * Sign-in bridge for the Marshall identity server (OIDC)
#
#  Zero third-party dependencies — Python 3.8+ standard library.
#
#  Run:
#      python3 proxy/server.py            # http://localhost:8787
#      python3 proxy/server.py 9000       # custom port
#  Then open http://localhost:8787
# ============================================================

import json
import os
import re
import sys
import posixpath
import mimetypes
import threading
import urllib.parse
import urllib.request
import urllib.error
from http.cookiejar import MozillaCookieJar
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_PORT = 8787


def resolve_root():
    """Locate the folder holding index.html.

    1. $GATEWAY_ROOT if it points at a real file set.
    2. PyInstaller one-file bundle (_MEIPASS) when frozen.
    3. Otherwise the folder above proxy/ (normal source layout).
    """
    env = os.environ.get("GATEWAY_ROOT")
    if env and os.path.isfile(os.path.join(env, "index.html")):
        return env
    base = getattr(sys, "_MEIPASS", None)
    if base and os.path.isfile(os.path.join(base, "index.html")):
        return base
    return os.path.dirname(HERE)


ROOT = resolve_root()                              # gateway/ (or bundle)

UPSTREAM = "https://codepresets.marshall.com"
IDSRV = "https://idserver.marshall.com"
BROWSER_UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")

# ---------------------------------------------------------------
#  Shared upstream session (single-user local tool)
# ---------------------------------------------------------------
class Session:
    def __init__(self):
        self.lock = threading.Lock()
        self.cookies = MozillaCookieJar()
        self.email = None
        self._opener = None

    def _build_opener(self):
        cp = urllib.request.HTTPCookieProcessor(self.cookies)
        # Do not auto-follow redirects ourselves; let urllib do it, but we need
        # the final URL, which urllib exposes via response.geturl().
        self._opener = urllib.request.build_opener(cp)

    def request(self, method, url, data=None, headers=None, timeout=15):
        with self.lock:
            if self._opener is None:
                self._build_opener()
            hdrs = {
                "User-Agent": BROWSER_UA,
                "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
                "Origin": "https://marshall.com",
                "Referer": "https://marshall.com/",
            }
            if headers:
                hdrs.update(headers)
            body = None
            if data is not None and not isinstance(data, (bytes, bytearray)):
                body = urllib.parse.urlencode(data).encode("utf-8")
            else:
                body = data
            last_err = None
            for attempt in range(3):
                req = urllib.request.Request(url, data=body, headers=hdrs, method=method)
                try:
                    return self._opener.open(req, timeout=timeout)
                except urllib.error.HTTPError as e:
                    return e
                except Exception as e:            # transient TLS/connection resets
                    last_err = e
                    if method != "GET":
                        break
                    import time as _t
                    _t.sleep(0.25 * (attempt + 1))
            raise last_err

    def signed_in(self):
        for c in self.cookies:
            if "marshall.com" in (c.domain or "") and "AspNetCore" in c.name:
                return True
        return False

    def clear(self):
        with self.lock:
            self.cookies.clear()
            self.email = None


SESSION = Session()

# ---------------------------------------------------------------
#  Helpers
# ---------------------------------------------------------------
def _hidden_value(html, name):
    """Extract a hidden input value by name (handles attribute order)."""
    tag_re = re.compile(r"<input\b[^>]*>", re.I)
    for tag in tag_re.findall(html):
        if re.search(r'name\s*=\s*["\']' + re.escape(name) + r'["\']', tag, re.I):
            m = re.search(r'value\s*=\s*["\']([^"\']*)["\']', tag, re.I)
            return m.group(1) if m else ""
    return None


def do_login(email, password):
    """Best-effort OIDC form login. Returns (ok, message)."""
    if not email or not password:
        return False, "Email and password are required."

    # 1. Kick off the flow: this lands on the idserver login page.
    resp = SESSION.request(
        "GET",
        UPSTREAM + "/account/signin",
        headers={"Accept": "text/html"},
    )
    login_url = resp.geturl()
    html = resp.read().decode("utf-8", "replace")

    if "identity/login" not in login_url.lower() and 'name="Password"' not in html:
        # Already authenticated?
        if SESSION.signed_in():
            SESSION.email = email
            return True, "already signed in"

    token = _hidden_value(html, "__RequestVerificationToken")
    return_url = _hidden_value(html, "ReturnUrl")
    referrer = _hidden_value(html, "ReferrerUrl") or UPSTREAM + "/account/signin"
    if token is None:
        return False, "Could not read the Marshall sign-in form (page layout changed)."

    form = {
        "Email": email,
        "Password": password,
        "RememberMe": "false",
        "TimezoneOffsetMinutes": "0",
        "ReturnUrl": return_url or "",
        "ReferrerUrl": referrer,
        "__RequestVerificationToken": token,
        # reCAPTCHA is rendered on the page; an empty token is sent when it is
        # not solved. Some deployments accept it, others block — handled below.
        "g-recaptcha-response": "",
        "AcceptedTermsAndConditions": "false",
    }

    post = SESSION.request(
        "POST",
        login_url,
        data=form,
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "text/html",
            "Referer": login_url,
            "Origin": IDSRV,
        },
    )
    final_url = post.geturl()
    body = post.read().decode("utf-8", "replace")

    if SESSION.signed_in():
        SESSION.email = email
        return True, "ok"

    # Detect the usual failure modes.
    if "recaptcha" in body.lower() and 'name="Password"' in body:
        return False, ("Marshall's sign-in page is protected by reCAPTCHA, which the "
                       "local helper cannot solve. Sign in to codepresets.marshall.com "
                       "in your normal browser, then use Cloud browsing (Official / "
                       "Community) which needs no account.")
    if 'name="Password"' in body:
        return False, "Sign-in rejected — check the email and password."
    return False, "Sign-in did not complete (final URL: %s)." % final_url


# ---------------------------------------------------------------
#  HTTP handler
# ---------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    server_version = "GatewayWebProxy/1.0"

    def log_message(self, fmt, *args):  # quieter logs
        sys.stderr.write("[proxy] %s\n" % (fmt % args))

    # ---- CORS ----
    def _cors(self):
        origin = self.headers.get("Origin") or "*"
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Credentials", "true")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type,Accept,Authorization")

    def _send(self, code, body=b"", ctype="application/octet-stream", extra=None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj), "application/json")

    # ---- entrypoints ----
    def do_OPTIONS(self):
        self._send(204)

    def do_GET(self):
        self._route("GET")

    def do_POST(self):
        self._route("POST")

    def do_HEAD(self):
        self._route("GET")

    def _read_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def _route(self, method):
        parsed = urllib.parse.urlsplit(self.path)
        path = parsed.path

        if path == "/api/session":
            return self._json({
                "signedIn": SESSION.signed_in(),
                "user": {"email": SESSION.email} if SESSION.email else None,
            })
        if path == "/api/login" and method == "POST":
            return self._api_login()
        if path == "/api/logout":
            SESSION.clear()
            return self._json({"ok": True})
        if path == "/api/ping":
            return self._json({"ok": True, "upstream": UPSTREAM})

        # Upstream passthrough: API, images, auth callbacks.
        if path.startswith(("/Presets/", "/Content/", "/account/",
                            "/signin-oidc", "/signout", "/Identity/",
                            "/connect/", "/api/upstream")):
            return self._proxy(method, parsed)

        return self._static(path)

    # ---- static files ----
    def _static(self, path):
        if path in ("/", ""):
            path = "/index.html"
        rel = posixpath.normpath(path).lstrip("/")
        if rel.startswith(".."):
            return self._send(403, "Forbidden", "text/plain")
        full = os.path.join(ROOT, rel)
        if not os.path.isfile(full):
            return self._send(404, "Not found: " + rel, "text/plain")
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        with open(full, "rb") as f:
            data = f.read()
        return self._send(200, data, ctype, {"Cache-Control": "no-cache"})

    # ---- API: login ----
    def _api_login(self):
        try:
            payload = json.loads(self._read_body().decode("utf-8") or "{}")
        except Exception:
            return self._json({"ok": False, "error": "Bad request body"}, 400)
        email = (payload.get("email") or "").strip()
        password = payload.get("password") or ""
        ok, msg = do_login(email, password)
        return self._json({"ok": ok, "error": None if ok else msg,
                           "user": {"email": email} if ok else None})

    # ---- upstream proxy ----
    def _proxy(self, method, parsed):
        url = UPSTREAM + parsed.path
        if parsed.query:
            url += "?" + parsed.query

        body = self._read_body() if method in ("POST", "PUT", "PATCH") else None
        headers = {"Accept": self.headers.get("Accept", "*/*")}
        if self.headers.get("Content-Type"):
            headers["Content-Type"] = self.headers["Content-Type"]
        # The upstream API expects marshall.com as origin/referer.
        headers["Origin"] = "https://marshall.com"
        headers["Referer"] = "https://marshall.com/"

        try:
            resp = SESSION.request(method, url, data=body, headers=headers)
        except Exception as e:
            return self._send(502, "Upstream error: %s" % e, "text/plain")

        data = resp.read()
        # If the upstream bounced us to the identity server, report 401 so the
        # client can surface "sign in".
        final = getattr(resp, "geturl", lambda: url)()
        status = getattr(resp, "status", getattr(resp, "code", 200))
        if "idserver.marshall.com" in final or "/identity/login" in final.lower():
            status = 401

        ctype = resp.headers.get("Content-Type", "application/octet-stream")
        self._send(status, data, ctype, {"Cache-Control": "no-cache"})


def create_server(port, host="127.0.0.1"):
    """Build (but do not start) the HTTP server. Used by main() and desktop.py."""
    return ThreadingHTTPServer((host, port), Handler)


def main():
    port = DEFAULT_PORT
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            pass
    httpd = create_server(port)
    print("=" * 62)
    print("  Marshall CODE · Gateway Web")
    print("  Serving %s" % ROOT)
    print("  Open    http://localhost:%d" % port)
    print("  Proxy   %s → %s" % (UPSTREAM, "same origin"))
    print("  Ctrl-C to stop.")
    print("=" * 62)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
