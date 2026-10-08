# -*- mode: python ; coding: utf-8 -*-
from PyInstaller.utils.hooks import collect_submodules

hiddenimports = []
hiddenimports += collect_submodules('proxy')


a = Analysis(
    ['/home/parsasam/Downloads/marshall code 25/gateway/app/desktop.py'],
    pathex=['/home/parsasam/Downloads/marshall code 25/gateway'],
    binaries=[],
    datas=[('/home/parsasam/Downloads/marshall code 25/gateway/index.html', '.'), ('/home/parsasam/Downloads/marshall code 25/gateway/styles.css', '.'), ('/home/parsasam/Downloads/marshall code 25/gateway/data.js', '.'), ('/home/parsasam/Downloads/marshall code 25/gateway/app.js', '.')],
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='MarshallCODE-Gateway',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
