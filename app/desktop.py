#!/usr/bin/env python3
# ============================================================
#  Marshall CODE · Gateway Web — desktop launcher
#  ------------------------------------------------------------
#  Double-click experience: opens a small native window, starts
#  the bundled helper server on a free port, and launches the
#  app in your default browser. Close the window to quit.
#
#  Run from source:      python3 app/desktop.py
#  Frozen (PyInstaller): no terminal window is shown at all.
# ============================================================

import os
import sys
import socket
import threading
import webbrowser

# Make `proxy.server` importable both from source and from a frozen bundle.
_HERE = os.path.dirname(os.path.abspath(__file__))
_SRC = os.path.dirname(_HERE)          # gateway/
if _SRC not in sys.path:
    sys.path.insert(0, _SRC)

from proxy import server as srv        # noqa: E402

APP_TITLE = "Marshall CODE · Gateway Web"
START_PORT = 8787


def _free_port(start=START_PORT, tries=40):
    """Return the first free TCP port at or above `start`."""
    for p in range(start, start + tries):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind(("127.0.0.1", p))
                return p
            except OSError:
                continue
    raise RuntimeError("No free port found")


def _open_browser_later(url, delay=0.8):
    threading.Timer(delay, lambda: webbrowser.open(url)).start()


def run_headless():
    """--no-gui: serve and open the browser, no window (for servers/CI)."""
    port = _free_port()
    url = "http://localhost:%d" % port
    httpd = srv.create_server(port)
    _open_browser_later(url)
    print("%s  →  %s" % (APP_TITLE, url))
    print("Close this window (Ctrl-C) to stop.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


def run_gui():
    import tkinter as tk
    from tkinter import font as tkfont

    port = _free_port()
    url = "http://localhost:%d" % port
    httpd = srv.create_server(port)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    root = tk.Tk()
    root.title(APP_TITLE)
    root.configure(bg="#171613")
    root.resizable(False, False)

    bg, panel, cream, brass, dim = "#171613", "#201e1a", "#ece5d6", "#c9a24b", "#9a907c"

    bar = tk.Frame(root, bg=brass, height=4)
    bar.pack(fill="x")

    wrap = tk.Frame(root, bg=bg, padx=26, pady=22)
    wrap.pack(fill="both", expand=True)

    tk.Label(wrap, text="MARSHALL", bg=bg, fg=cream,
             font=("Georgia", 20, "bold")).pack(anchor="w")
    tk.Label(wrap, text="CODE · GATEWAY WEB", bg=bg, fg=brass,
             font=("Helvetica", 9, "bold")).pack(anchor="w", pady=(0, 14))

    tk.Label(wrap, text="The app is running and should have opened\n"
                        "in your browser. If not, use the link below.",
             bg=bg, fg=dim, justify="left",
             font=("Helvetica", 10)).pack(anchor="w")

    link = tk.Label(wrap, text=url, bg=bg, fg=brass,
                    font=("Helvetica", 11, "underline"), cursor="hand2")
    link.pack(anchor="w", pady=(10, 4))
    link.bind("<Button-1>", lambda e: webbrowser.open(url))

    tk.Label(wrap, text="Connect your CODE amp over USB, then press Connect.\n"
                        "Keep this window open while you play.",
             bg=bg, fg=dim, justify="left",
             font=("Helvetica", 9)).pack(anchor="w", pady=(10, 16))

    def quit_app():
        try:
            httpd.shutdown()
        except Exception:
            pass
        root.destroy()

    btn = tk.Button(wrap, text="Open in browser", command=lambda: webbrowser.open(url),
                    bg=brass, fg="#111", activebackground="#e6c778",
                    relief="flat", padx=14, pady=7, cursor="hand2",
                    font=("Helvetica", 10, "bold"))
    btn.pack(anchor="w", side="left")

    quitb = tk.Button(wrap, text="Quit", command=quit_app,
                      bg=panel, fg=cream, activebackground="#2e2b26",
                      relief="flat", padx=14, pady=7, cursor="hand2",
                      font=("Helvetica", 10))
    quitb.pack(anchor="w", side="left", padx=(8, 0))

    root.protocol("WM_DELETE_WINDOW", quit_app)
    root.update_idletasks()
    w, h = root.winfo_width(), root.winfo_height()
    x = (root.winfo_screenwidth() - w) // 2
    y = (root.winfo_screenheight() - h) // 3
    root.geometry("+%d+%d" % (x, y))

    _open_browser_later(url)
    root.mainloop()
    return 0


def main():
    if "--no-gui" in sys.argv or os.environ.get("GATEWAY_NO_GUI"):
        return run_headless()
    try:
        return run_gui()
    except Exception:
        # No display / tkinter unavailable → fall back to headless.
        return run_headless()


if __name__ == "__main__":
    sys.exit(main())
