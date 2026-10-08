#!/usr/bin/env python3
# ============================================================
#  Marshall CODE · Gateway Web — one-file build script
#  ------------------------------------------------------------
#  Produces a single double-click executable with PyInstaller.
#
#  Usage:
#      python3 build.py                 # build for this OS
#      python3 build.py --name Foo      # custom binary name
#      python3 build.py --console       # keep a console (debug)
#
#  Requires:  pip install pyinstaller
#
#  The web app files (index.html, styles.css, data.js, app.js)
#  are embedded into the binary, so the result is fully portable:
#  copy the single file anywhere and double-click it.
# ============================================================

import os
import sys
import shutil
import subprocess
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))      # gateway/
GATEWAY = os.path.dirname(HERE)                        # repo gateway/
DIST = os.path.join(GATEWAY, "dist")
BUILD = os.path.join(GATEWAY, "build", "pyinstaller")

APPS = ["index.html", "styles.css", "data.js", "app.js"]


def main():
    args = sys.argv[1:]
    name = "MarshallCODE-Gateway"
    if "--name" in args:
        name = args[args.index("--name") + 1]
    console = "--console" in args

    try:
        import PyInstaller.__main__ as pyi
    except ImportError:
        print("PyInstaller is not installed.  Run:  python3 -m pip install pyinstaller")
        return 1

    # Verify the app assets exist before packaging.
    missing = [f for f in APPS if not os.path.isfile(os.path.join(GATEWAY, f))]
    if missing:
        print("Missing app files: %s" % ", ".join(missing))
        return 1

    sep = ";" if os.name == "nt" else ":"
    add_data = [os.path.join(GATEWAY, f) + sep + "." for f in APPS]

    cmd = [
        os.path.join(HERE, "desktop.py"),
        "--name", name,
        "--onefile",
        "--clean", "--noconfirm",
        "--distpath", DIST,
        "--workpath", BUILD,
        "--specpath", BUILD,
        # The launcher imports proxy.server; point the analysis at the source tree.
        "--paths", GATEWAY,
        "--collect-submodules", "proxy",
    ]
    for d in add_data:
        cmd += ["--add-data", d]
    if not console:
        cmd += ["--windowed"]
    if os.name != "nt" and sys.platform != "darwin":
        # icon is optional; skip when absent
        ico = os.path.join(GATEWAY, "icon.png")
        if os.path.isfile(ico):
            cmd += ["--icon", ico]

    print("Building %s ..." % name)
    pyi.run(cmd)

    exe = os.path.join(DIST, name + (".exe" if os.name == "nt" else ""))
    if os.path.isfile(exe):
        size = os.path.getsize(exe) / (1024 * 1024)
        print("\nDone → %s  (%.1f MB)" % (exe, size))
        print("Double-click it to launch; no terminal or Python needed.")
        return 0
    print("\nBuild finished but no executable was found at %s" % exe)
    return 2


if __name__ == "__main__":
    sys.exit(main())
