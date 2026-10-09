# Marshall CODE · Gateway Web

A full-featured, browser-based companion for the **Marshall CODE 25** (and the rest
of the CODE series). It reproduces the sections and workflows of Marshall's *Gateway*
app and connects to both the amp (live, over USB MIDI) and Marshall's **Cloud preset
library** at `codepresets.marshall.com`.

> Not affiliated with Marshall Amplification. Use at your own risk.

---

## Quick start

Requires **Python 3.8+** (standard library only — no `pip install`).
Use **Chrome or Edge on desktop** for Web MIDI / SysEx.

```bash
cd gateway
python3 proxy/server.py            # serves on http://localhost:8787
```

Then open **http://localhost:8787** in Chrome/Edge and press **Connect**.
(You can also open `gateway/index.html` directly from disk — the page will talk to
the helper at `http://localhost:8787` automatically — but the served URL is
recommended because Web MIDI and same-origin Cloud calls are happiest there.)

Click **Connect** once to grant MIDI access, then pick your CODE amp in the
**Output / Input** selectors (bottom of the sidebar). SysEx access is requested by
default (`Settings → Request SysEx access`).

---

## Portable desktop app (no commands for the user)

You can package the whole thing — server + web app — into **one double-click
executable**. The recipient needs no Python, no terminal and no install:

```bash
cd gateway
python3 -m pip install pyinstaller     # build machine only, once
python3 app/build.py                   # → gateway/dist/MarshallCODE-Gateway
```

Double-clicking `MarshallCODE-Gateway` opens a small native window, picks a free
port, starts the helper and opens the app in the default browser. Close the window
to quit. Copy that single file anywhere (USB stick, another PC with the same OS) and
it just runs.

- The web files (`index.html`, `styles.css`, `data.js`, `app.js`) are embedded in the
  binary, so nothing else is needed alongside it.
- The binary is built **for the OS you build on**: run `build.py` on Windows to get a
  `.exe`, on macOS to get a `.app`/Mach-O, on Linux for an ELF — the same source
  builds all three.
- For a terminal-only environment (a home server, or a box with no display) run with
  `--no-gui` / set `GATEWAY_NO_GUI=1`: it serves and opens the browser without a window.
- Keep the window open while you play; closing it stops the local server.

### Even lighter: a double-click launcher

If Python is already installed on the machine, you can skip the build and just point
a shortcut at the launcher:

```bash
python3 app/desktop.py        # same window + browser behaviour, runs from source
```

On Linux make a `.desktop` file, on Windows a `.bat`, on macOS a `.command` — each
one line: `python3 /path/to/gateway/app/desktop.py`.

---

## Features

### Amplifier view
- **Panel tone** knobs — Gain, Bass, Middle, Treble, Volume — stored in the preset
  and streamed live as Control Change.
- **Master** knob (amp-only global; not stored in presets) — sent as **CC 7**
  (standard Master/Channel Volume; editable in Settings).
- **Full signal chain** as collapsible blocks, each with an on/off switch, a model
  select and its parameters:
  - **Pre FX** — Distortion, Auto Wah, Pitch Shifter, Compressor
  - **Amp** — all 15 preamp models grouped Clean / Crunch / Overdrive / Natural
  - **Modulation** — Chorus, Flanger, Phaser, Tremolo
  - **Delay** — Studio, Vintage, Multi, Reverse (14-bit delay time in ms)
  - **Reverb** — Room, Hall, Spring, Stadium
  - **Power amp** — 4 valve models with Presence / Resonance
  - **Cabinet** — 8 speaker cabinets
- Every change is sent **live**; the amp mirrors the editor.
- **Read amp state** requests settings back over SysEx; **Send live to amp** pushes the
  editor as the amp's live/current settings (not saved to a preset slot); **Store → amp
  slot** writes the editor to its numbered preset slot on the amp.

### Preset library
- **100 local slots** (persisted in the browser), with name, panel and full chain.
- Click a slot to load it into the editor; rename, copy/paste, clear, save.
  Rename from the editor strip's **Rename** button, the **Rename** button in the
  slot detail panel, or by **double-clicking** a slot in the grid.
  Renaming also updates that slot **on the amp** when MIDI is connected and SysEx is
  enabled: the app asks the amp for the slot, swaps in the new name and writes it back,
  so the amp keeps its tone and the name survives preset changes. If the amp doesn't
  answer within a few seconds the name is saved in the app only.
- Filter (all / favourites / named / unnamed) and text search.
- **Export / import** the whole library or a complete backup as JSON.
- **Seed factory names** pulls the official preset names from the Cloud. This also
  runs automatically once, the first time the app is online, to fill empty slots;
  choose it manually any time to re-seed unnamed slots.

### Marshall Cloud
- Browse **Official**, **Community** and **My Library** presets, and your own
  **★ Favourites**. Favourites are stored locally with the full card (cover art,
  downloads, rating); older name-only favourites have their cover fetched on first view.
- Search by song/artist and sort by Newest, Oldest, A–Z, Z–A, Downloads or
  Popularity; paginated "Load more".
- Open any preset to see its full device breakdown (amp, power amp, cabinet, pedal,
  modulation, delay, reverb) with every parameter.
  - **Load into editor** — converts the cloud preset into engine values and drops it
    into the editor so you can tweak and **Store → amp**.
  - **Save to next free slot** — writes it straight into your local library.
  - **☆ Favourite** — star it locally.
  - **Toggle Marshall library** — add/remove it in your Marshall account library.

### Other
- **Tuner** view (reads note data the amp emits in tuner mode).
- **MIDI Monitor** — every byte in and out, colour-coded, with a **Hex / Decoded**
  toggle (CC messages resolve to their mapped control name), a live text filter,
  **Pause/Resume** that keeps counting while frozen, byte counters, and Clear.
- **Settings** — device/channel selection, editable full CC map, data export/import,
  reset.
- Responsive layout with a mobile bottom nav.
- Deep links: `#amp`, `#presets`, `#cloud`, `#tuner`, `#monitor`, `#settings`.

---

## How the Cloud connection works

`codepresets.marshall.com` only sends CORS headers for the origin
`https://marshall.com`, so a page served from `localhost` cannot call it directly.
The bundled `proxy/server.py`:

1. serves the web app (static files), and
2. reverse-proxies `/Presets/*`, `/Content/*` and `/codeprofile` to the Cloud
   site, adding the `Origin: https://marshall.com` header the API expects.

Because the app is served from the same origin as the proxy, these calls just work.

### Sign-in

`/api/login` drives Marshall's OIDC sign-in flow through the helper and keeps the
session cookie server-side, so the browser never holds Marshall's auth cookie.
Two details make the flow work: the login form must be submitted with its
`button=login` field (otherwise the identity server answers `access_denied`), and
the helper keeps short-lived OIDC cookies as session cookies so a local clock that
runs ahead of Marshall's does not drop the 15-minute nonce cookie and break the
callback. Once signed in you can load **My Library** and toggle whether a preset is
saved to your Marshall library. Your password is sent only to Marshall, never stored.

---

## The CODE MIDI format

Controls follow the official **CODE MIDI PC & CC Specification v2.1**. The CC map
lives in `data.js` (`DEFAULT_CC`) and is editable in **Settings**. Gain (CC 70) and
Treble (CC 73) are not printed on the chart; they are inferred from the sequential
panel order and can be reassigned if your firmware differs.

Presets are transferred over SysEx. The published chart labels `0x72` as "current
settings" and `0x73` as "preset", but shipping firmware is the other way round —
this matches the Java `MarshallCodeAmpInterface`, the `marshallcode.tools` web app
and the `CodeEditor` app, and is what finally made stores and renames land on the
amp. The frame carries a **64-byte** payload (the chart lists 62; the extra two,
plus the `0C 0D 1A 1B 1C 1D` tail, come from those working editors):

```
F0 00 21 15 7F 7F 7F  72|73  02|01|03  num   <64 data bytes>  F7
                      preset|current  set|recall|returned
```

Storing to a slot sends that frame and then a **Program Change** to the same slot
(`C0 nn`), which is how the editors commit the write. Renaming reuses the same
path: read the slot, swap the name, write it back, so the amp's tone is preserved.

---

## Files

```
gateway/
├── index.html        app shell & views
├── styles.css        Gateway-style theme
├── data.js           engine model, CC map, SysEx constants, cloud base
├── app.js            MIDI, SysEx encode/decode, presets, cloud logic, UI
├── proxy/server.py   static server + Cloud reverse proxy + sign-in bridge
├── app/desktop.py    double-click launcher (native window + browser)
├── app/build.py      PyInstaller one-file builder
├── dist/             built executable (after running build.py)
└── README.md
```

A small scripting API is exposed as `window.GW` (state, `sendCC`, `sendPC`,
`encodePreset`, `decodePreset`, `setPresetNumber`, `cloudLoad`, …) for the console
or automation.

---

## Which packaging should I choose?

The Cloud connection is the reason *something* has to run: Marshall's site only
allows the origin `https://marshall.com`, so a plain static page cannot read it.
All the practical options, best first:

| Option | Commands for the user | Needs Python? | Notes |
|---|---|---|---|
| **Portable binary** (`app/build.py`) | none — double-click | no | one file per OS; recommended |
| **Launcher** (`app/desktop.py` + shortcut) | none — double-click | yes | lightest to set up |
| **Browser extension** | one "Load unpacked" | no | no server at all; needs repackaging |
| **Hosted proxy** | none after a one-time deploy | no | app works from anywhere/`file://` |

The built-in server is the same in every case; only who runs it changes.
