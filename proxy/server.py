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
import html as htmlmod
import posixpath
import mimetypes
import threading
import urllib.parse
import urllib.request
import urllib.error
from http.cookiejar import MozillaCookieJar, Absent
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_PORT = 8787

# Redirected stdout/stderr on Windows can default to cp1252, which cannot
# encode the box-drawing / arrow characters in the banner.  Force UTF-8 so
# `python proxy/server.py > log.txt` never crashes at startup.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


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
class SkewTolerantCookieJar(MozillaCookieJar):
    """Cookie jar that tolerates clock skew between this machine and
    Marshall's servers.

    The OIDC flow sets a short-lived (15 minute) ``OpenIdConnect.nonce``
    cookie. When the local clock runs ahead of the server's — which is easy
    to hit — Python treats that cookie as already expired and silently drops
    it, so the ``signin-oidc`` callback fails its nonce check and sign-in
    never completes. We keep such (non-empty) cookies as session cookies
    instead of discarding them, and still process genuine deletions (empty
    values) normally.
    """

    def _cookie_from_cookie_tuple(self, tup, request):
        name, value, standard, rest = tup
        if value and standard.get("expires", Absent) is not Absent:
            standard = dict(standard)
            standard["expires"] = Absent      # treat as a session cookie
        return super()._cookie_from_cookie_tuple((name, value, standard, rest), request)


class Session:
    def __init__(self):
        self.lock = threading.Lock()
        self.cookies = SkewTolerantCookieJar()
        self.email = None
        self._opener = None
        self.last_redirects = []

    def _build_opener(self):
        cp = urllib.request.HTTPCookieProcessor(self.cookies)
        session = self

        class _RecordingRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, headers, newurl):
                session.last_redirects.append(newurl)
                return super().redirect_request(req, fp, code, msg, headers, newurl)

        # Let urllib follow redirects and record them; we need the final URL.
        self._opener = urllib.request.build_opener(cp, _RecordingRedirect())

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
                    if attempt == 2:
                        break
                    import time as _t
                    _t.sleep(0.25 * (attempt + 1))
            raise last_err

    def signed_in(self):
        """True only when a cookie set by the presets site (not the shared
        identity server) is present. The identity server sets its own
        AspNetCore cookies even on a failed sign-in, which previously caused
        false 'signed in' positives."""
        for c in self.cookies:
            dom = (c.domain or "").lstrip(".").lower()
            name = c.name or ""
            if "idserver" in dom:
                continue
            # Ignore request-flow cookies that carry no authentication.
            if any(x in name for x in ("Antiforgery", "Correlation", "Nonce", "nonce")):
                continue
            # The presets site issues its own ASP.NET auth cookie once the OIDC
            # callback completes (".AspNet.Cookies"); older builds used the
            # ".AspNetCore.Cookies" name. Either one means we are signed in.
            if dom.endswith("marshall.com") and "AspNet" in name and "Cookies" in name:
                return True
        return False

    def clear(self):
        with self.lock:
            self.cookies.clear()
            self.email = None
            self.last_redirects = []


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
            return htmlmod.unescape(m.group(1)) if m else ""
    return None


def _form_action(html):
    """Return a form's action URL (HTML-unescaped), or None."""
    m = re.search(r'<form\b[^>]*action\s*=\s*["\']([^"\']+)["\']', html, re.I)
    return htmlmod.unescape(m.group(1)) if m else None


def _all_hidden(html):
    """Collect every hidden input as {name: value} (HTML-unescaped)."""
    out = {}
    for tag in re.findall(r"<input\b[^>]*>", html, re.I):
        if not re.search(r'type\s*=\s*["\']hidden["\']', tag, re.I):
            continue
        nm = re.search(r'name\s*=\s*["\']([^"\']+)["\']', tag, re.I)
        if not nm:
            continue
        vm = re.search(r'value\s*=\s*["\']([^"\']*)["\']', tag, re.I)
        out[nm.group(1)] = htmlmod.unescape(vm.group(1)) if vm else ""
    return out


def do_login(email, password):
    """Best-effort OIDC form login. Returns (ok, message)."""
    if not email or not password:
        return False, "Email and password are required."

    SESSION.last_redirects = []

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
        # The login page's submit <button name="button" value="login"> is what
        # tells the controller to run the password grant. Omitting it makes the
        # identity server bounce back with OAuth error=access_denied even when
        # the credentials are correct.
        "button": "login",
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
    post_body = post.read().decode("utf-8", "replace")

    # 2. On success the identity server answers with an auto-submitting
    #    form_post to the client app (signin-oidc). Follow it so the client can
    #    set its own auth cookie — otherwise the login never completes.
    action = _form_action(post_body)
    if action and "access_denied" not in post_body and 'name="Password"' not in post_body:
        callback_url = urllib.parse.urljoin(final_url, action)
        fields = _all_hidden(post_body)
        cb = SESSION.request(
            "POST",
            callback_url,
            data=fields,
            headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "Accept": "text/html",
                "Referer": final_url,
                "Origin": UPSTREAM,
            },
        )
        post_body = cb.read().decode("utf-8", "replace")
        final_url = cb.geturl()

    if SESSION.signed_in():
        SESSION.email = email
        return True, "ok"

    # Detect the usual failure modes.
    if 'name="Password"' in post_body:
        return False, "Sign-in rejected — check the email and password."
    denied = ("access_denied" in post_body
              or any("access_denied" in u for u in SESSION.last_redirects))
    if denied:
        return False, ("Marshall refused the sign-in (access_denied). Check the "
                       "email and password; if they are correct the account may "
                       "need attention at marshall.com.")
    return False, "Sign-in did not complete (final URL: %s)." % final_url


def profile_info():
    """Fetch /codeprofile and parse the signed-in user's name + email.

    Returns {name, email} or None when the session is not authenticated."""
    resp = SESSION.request(
        "GET", UPSTREAM + "/codeprofile", headers={"Accept": "text/html"})
    final = resp.geturl()
    html = resp.read().decode("utf-8", "replace")
    if "idserver.marshall.com" in final or 'name="Password"' in html:
        return None

    def field(label):
        m = re.search(
            r'<label[^>]*>\s*' + re.escape(label) + r'\s*</label>'
            r'.*?<span[^>]*>(.*?)</span>',
            html, re.I | re.S)
        if not m:
            return ""
        return re.sub(r"<[^>]+>", "", m.group(1)).strip()

    return {"name": field("FULL NAME"), "email": field("EMAIL")}


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
        if path == "/api/profile":
            if not SESSION.signed_in():
                return self._json({"ok": False, "error": "not signed in"}, 401)
            try:
                info = profile_info()
            except Exception as e:
                return self._json({"ok": False, "error": str(e)}, 502)
            if not info:
                return self._json({"ok": False, "error": "profile unavailable"}, 502)
            return self._json({"ok": True, "name": info["name"], "email": info["email"]})
        if path == "/api/logout":
            SESSION.clear()
            return self._json({"ok": True})
        if path == "/api/ping":
            return self._json({"ok": True, "upstream": UPSTREAM})

        # Upstream passthrough: API, images, auth callbacks, profile.
        if path.startswith(("/Presets/", "/Content/", "/account/",
                            "/signin-oidc", "/signout", "/Identity/",
                            "/connect/", "/codeprofile", "/api/upstream")):
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
