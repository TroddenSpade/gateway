/* ============================================================
   app.js — Gateway Web logic
   ============================================================ */
"use strict";

/* ---------------- tiny helpers ---------------- */
const $  = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const clamp = (v,a,b) => Math.max(a, Math.min(b, v));
const hex = a => Array.from(a).map(b => b.toString(16).padStart(2,"0")).join(" ");
/* Preset slots are 0-based (00–99), matching the amp / MIDI program numbers. */
const pnum = n => String(n).padStart(2,"0");

const store = {
  get(k,d){ try{ const v=localStorage.getItem(k); return v==null?d:JSON.parse(v); }catch(e){ return this._m?.[k] ?? d; } },
  set(k,v){ try{ localStorage.setItem(k,JSON.stringify(v)); }catch(e){ (this._m ||= {})[k]=v; } },
  del(k){ try{ localStorage.removeItem(k); }catch(e){ if(this._m) delete this._m[k]; } }
};

function toast(msg, kind="") {
  const t = document.createElement("div");
  t.className = "toast " + kind;
  const icon = kind==="ok" ? "✓" : kind==="err" ? "!" : "•";
  t.innerHTML = `<span class="ti" aria-hidden="true"></span><span class="tm"></span><button class="tx" aria-label="Dismiss">✕</button>`;
  t.querySelector(".ti").textContent = icon;
  t.querySelector(".tm").textContent = msg;
  const kill = ()=>{ if (!t.isConnected) return; t.style.opacity="0"; t.style.transition="opacity .3s"; setTimeout(()=>t.remove(),320); };
  t.querySelector(".tx").onclick = kill;
  $("#toasts").appendChild(t);
  setTimeout(kill, 4200);
}

/* ---------------- state ---------------- */
const state = {
  cc: Object.assign({}, DEFAULT_CC, store.get(LS.cc, {})),
  settings: Object.assign({ channel:0, sysex:true, thru:false, outId:"", inId:"" }, store.get(LS.settings, {})),
  presets: null,           // 100 slots
  editSlot: 0,             // index into presets being edited
  edit: null,              // working preset (engine units)
  favs: store.get(LS.favs, {}), // cloud preset id -> name
  cloud: { type:"Official", page:1, search:"", sort:"Newest", items:[], loading:false, hasMore:true, online:false, reqId:0 },
  login: { ok:false, email: store.get(LS.email,""), user:null },
  pendingName: null,       // { slot, name } while renaming a slot on the amp
  pendingNameTimer: null
};

/* ---------------- preset model ---------------- */
function blankPreset(slot){
  return {
    name: DEFAULT_PRESET_NAME(slot),
    panel: { gain:50, bass:50, middle:50, treble:50, volume:50 },
    chain: {
      prefx:{ on:false, type:0, p1:50, p2:50, p3:50, p4:50 },
      amp:  { on:true,  type:0, gate:30 },
      mod:  { on:false, type:0, p1:0, p2:50, p3:50, p4:50 },
      delay:{ on:false, type:0, timeMs:500, p2:40, p3:50, p4:50 },
      rev:  { on:false, type:0, p1:50, p2:30, p3:50, p4:50 },
      power:{ on:true,  type:0, presence:50, resonance:50 },
      cab:  { on:true,  type:4 }
    },
    fav:false
  };
}
function loadPresets(){
  let p = store.get(LS.presets, null);
  if (!Array.isArray(p) || p.length !== NUM_PRESETS){
    p = Array.from({length:NUM_PRESETS}, (_,i)=>blankPreset(i));
    store.set(LS.presets, p);
  }
  // Backfill missing fields and never trust stored data to be well-formed.
  p = p.map((preset,i)=>{
    const b = blankPreset(i);
    if (!preset || typeof preset !== "object") return b;
    preset.name = (typeof preset.name === "string" && preset.name.trim()) ? preset.name : b.name;
    // Legacy libraries may hold either 0-based ("PRESET 00"…"PRESET 99") or
    // 1-based ("PRESET 01"…"PRESET 100") placeholders. Normalise them to the
    // 0-based names so slot N reads "PRESET NN".
    if (/^PRESET \d+$/.test(preset.name)) preset.name = b.name;
    preset.panel = Object.assign({}, b.panel, preset.panel||{});
    preset.chain = preset.chain||{};
    Object.keys(b.chain).forEach(k=> preset.chain[k]=Object.assign({}, b.chain[k], preset.chain[k]||{}));
    return preset;
  });
  state.presets = p;
  store.set(LS.presets, p);
}
function savePresets(){ store.set(LS.presets, state.presets); }

/* ---------------- MIDI ---------------- */
let access = null, out = null, inp = null;
let ampReadTimer = null;
const MIDI_REALTIME = 0xF8;

/* MIDI monitor buffer + view prefs */
const monBuf = [];
const monCount = { in:0, out:0, sys:0, err:0 };
let monPaused = false, monHex = true, monDir = "all", monAuto = true;

function logLine(dir, text){
  const l = $("#log"); if (!l) return;
  const rec = { dir, text, ts: new Date() };
  monBuf.push(rec); if (monBuf.length > 600) monBuf.shift();
  monCount[dir] = (monCount[dir]||0) + 1;
  if (monPaused) { updateMonStats(); return; }
  if (monDir==="all" || monDir===dir) appendMonLine(l, rec);
  if (monAuto) l.scrollTop = l.scrollHeight;
  updateMonStats();
}
function hexToBytes(text){
  const m = /^[0-9a-fA-F]{2}(?: [0-9a-fA-F]{2})+$/.test(text.trim());
  if (!m) return null;
  return text.trim().split(" ").map(b => parseInt(b,16));
}
function describeBytes(bytes){
  const d = bytes.slice();
  if (d[0]===0xF0) return "SysEx · " + d.length + " bytes";
  const high = d[0] & 0xF0, ch = (d[0] & 0x0F) + 1;
  if (high===0xB0){
    const rev = {}; Object.entries(state.cc).forEach(([k,v])=> rev[v]=k);
    const name = rev[d[1]] || ("CC "+d[1]);
    return "Control change · " + name + " = " + d[2] + " (ch " + ch + ")";
  }
  if (high===0xC0) return "Program change · preset " + pnum(d[1]) + " (ch " + ch + ")";
  if (high===0x90) return "Note on · " + d[1] + " vel " + d[2];
  if (high===0x80) return "Note off · " + d[1];
  return hex(bytes);
}
function monBody(rec){
  if (monHex) return rec.text;
  const b = hexToBytes(rec.text);
  return b ? describeBytes(b) : rec.text;
}
function appendMonLine(l, rec){
  const cls = rec.dir==="in"?"in":rec.dir==="out"?"out":rec.dir==="err"?"err":"sys";
  const arrow = rec.dir==="in"?"←":rec.dir==="out"?"→":rec.dir==="err"?"!":"•";
  const row = document.createElement("div");
  row.className = cls;
  row.dataset.text = (rec.text + " " + describeMaybe(rec.text)).toLowerCase();
  row.textContent = rec.ts.toLocaleTimeString() + "  " + arrow + "  " + monBody(rec);
  l.appendChild(row);
}
function describeMaybe(text){
  const b = hexToBytes(text);
  return b ? describeBytes(b) : "";
}
function renderMonitor(){
  const l = $("#log"); if (!l) return;
  const q = ($("#monFilter")?.value||"").toLowerCase();
  l.innerHTML = "";
  monBuf.forEach(rec=>{
    if (monDir!=="all" && rec.dir!==monDir) return;
    if (q){
      const hay = (rec.text + " " + describeMaybe(rec.text) + " " + rec.dir).toLowerCase();
      if (!hay.includes(q)) return;
    }
    appendMonLine(l, rec);
  });
  if (monAuto) l.scrollTop = l.scrollHeight;
  updateMonStats();
}
function updateMonStats(){
  const el = $("#monStats"); if(!el) return;
  el.textContent = `↑ ${monCount.out||0} sent · ↓ ${monCount.in||0} received · ${monBuf.length} logged`;
  const p = $("#monPause"); if(p) p.textContent = monPaused ? "Resume" : "Pause";
}

function send(bytes, {silent=false}={}){
  const arr = Array.from(bytes);
  if (!out){ if(!silent) logLine("err", "No output selected: "+hex(arr)); return; }
  try { out.send(arr); } catch(e){ logLine("err","send failed: "+e.message); return; }
  if(!silent) logLine("out", hex(arr));
}
function ccNum(key){ const v = state.cc[key]; return (v==null||v==="")?null:+v; }
function sendCC(key, val, {silent=false}={}){
  const cc = ccNum(key); if (cc==null) return;
  send([0xB0 | (state.settings.channel & 0x0F), cc, clamp(Math.round(val),0,127)], {silent});
}
function sendPC(n){ send([0xC0 | (state.settings.channel & 0x0F), clamp(n,0,127)]); }
function sysex(bytes){ send([0xF0, ...SYSEX.header, ...bytes, 0xF7]); }

/* delay 14-bit */
function sendDelayTime(ms){
  ms = clamp(Math.round(ms),0,4000);
  const msb = (ms >> 7) & 0x7F, lsb = ms & 0x7F;
  sendCC("delay_msb", msb, {silent:true});
  sendCC("delay_lsb", lsb, {silent:true});
  logLine("out", `delay time = ${ms} ms (MSB ${msb} LSB ${lsb})`);
}

/* ---------------- SysEx preset encode/decode ----------------
   64-byte payload (data bytes [0..63]). The chart documents 62 bytes and calls
   [58..61] fixed 0x01..0x04, but shipping firmware and every working editor send
   two more bytes plus a fixed 0x0C,0x0D,0x1A,0x1B,0x1C,0x1D tail, so we mirror them. */
function encodePreset(preset){
  const d = new Uint8Array(64);
  const put = (i,v)=> d[i] = clamp(v|0, 0, 127);
  const name = (preset.name||"").slice(0,18).toUpperCase();
  for (let i=0;i<18;i++) d[i] = name.charCodeAt(i)||0x20;
  put(18, 0x00);
  put(19, preset.panel.gain); put(20, preset.panel.bass);
  put(21, preset.panel.middle); put(22, preset.panel.treble); put(23, preset.panel.volume);
  const c = preset.chain;
  put(24, c.prefx.on?1:0); put(25, c.prefx.type); put(26,c.prefx.p1); put(27,c.prefx.p2); put(28,c.prefx.p3); put(29,c.prefx.p4);
  put(30, c.amp.on?1:0);   put(31, c.amp.type);   put(32, c.amp.gate);
  put(33, c.mod.on?1:0);   put(34, c.mod.type);   put(35,c.mod.p1); put(36,c.mod.p2); put(37,c.mod.p3); put(38,c.mod.p4);
  put(39, c.delay.on?1:0); put(40, c.delay.type);
  const ms = clamp(c.delay.timeMs,0,4000);
  put(41, (ms>>7)&0x7F); put(42, ms&0x7F);
  put(43,c.delay.p2); put(44,c.delay.p3); put(45,c.delay.p4);
  put(46, c.rev.on?1:0);   put(47, c.rev.type);   put(48,c.rev.p1); put(49,c.rev.p2); put(50,c.rev.p3); put(51,c.rev.p4);
  put(52, c.power.on?1:0); put(53, c.power.type); put(54, c.cab.on?1:0); put(55, c.cab.type);
  put(56, c.power.resonance); put(57, c.power.presence);
  // Reserved tail. Prefer the bytes the amp returned (kept in sysexTail) so a
  // name-only rewrite can't disturb them; otherwise the editors' fixed values.
  const tail = (preset.sysexTail && preset.sysexTail.length >= 6) ? preset.sysexTail : [12,13,26,27,28,29];
  put(58, tail[0]); put(59, tail[1]); put(60, tail[2]); put(61, tail[3]); put(62, tail[4]); put(63, tail[5]);
  return d;
}
function decodePreset(d, slot){
  const get = i => d[i]|0;
  let name = ""; for(let i=0;i<18;i++){ const ch=get(i); if(ch) name += String.fromCharCode(ch); }
  const p = blankPreset(slot);
  p.name = name.trim() || DEFAULT_PRESET_NAME(slot);
  p.panel = { gain:get(19), bass:get(20), middle:get(21), treble:get(22), volume:get(23) };
  p.chain = {
    prefx:{ on:!!get(24), type:get(25), p1:get(26), p2:get(27), p3:get(28), p4:get(29) },
    amp:  { on:!!get(30), type:get(31), gate:get(32) },
    mod:  { on:!!get(33), type:get(34), p1:get(35), p2:get(36), p3:get(37), p4:get(38) },
    delay:{ on:!!get(39), type:get(40), timeMs:(get(41)<<7)|get(42), p2:get(43), p3:get(44), p4:get(45) },
    rev:  { on:!!get(46), type:get(47), p1:get(48), p2:get(49), p3:get(50), p4:get(51) },
    power:{ on:!!get(52), type:get(53), presence:get(57), resonance:get(56) },
    cab:  { on:!!get(54), type:get(55) }
  };
  if (d.length >= 64) p.sysexTail = Array.from(d.slice(58,64));
  return p;
}

/* SysEx commands */
function sysexSetCurrent(preset){ sysex([SYSEX.accessCurrent, SYSEX.set, 0x00, ...encodePreset(preset)]); }
/* Store a preset to its numbered slot. CODE expects the 64-byte data followed by
   a program change to the same slot — that's how the editor apps commit the write. */
function sysexSetPreset(slot, preset){
  sysex([SYSEX.accessPreset, SYSEX.set, slot & 0x7F, ...encodePreset(preset)]);
  sendPC(slot);
}
function sysexRecallCurrent(){ sysex([SYSEX.accessCurrent, SYSEX.recall, 0x00]); }
function sysexRecallPreset(slot){ sysex([SYSEX.accessPreset, SYSEX.recall, slot & 0x7F]); }

/* "Read amp state" — ask the amp for its current settings and reflect the reply.
   Gives clear feedback instead of silently doing nothing when no reply arrives. */
function clearAmpReadPending(){
  if (ampReadTimer){ clearTimeout(ampReadTimer); ampReadTimer = null; }
  const b = document.querySelector("#ampRecall");
  if (b){ b.disabled = false; b.textContent = "Read amp state"; }
}
function readAmpState(){
  if (!out){ toast("Select a MIDI output first", "err"); return; }
  if (!state.settings.sysex){ toast("Enable SysEx access in Settings, then reload", "err"); return; }
  clearAmpReadPending();
  sysexRecallCurrent();
  const b = document.querySelector("#ampRecall");
  if (b){ b.disabled = true; b.textContent = "Reading…"; }
  ampReadTimer = setTimeout(()=>{
    clearAmpReadPending();
    toast("No reply from the amp — check the MIDI output/input and that SysEx is on.", "err");
  }, 2500);
  toast("Requested current settings from amp");
}

/* Renaming on the amp.
   The MIDI chart has no "name only" command — a preset write always carries all
   62 data bytes.  To avoid clobbering the amp's tone with the app's local copy we
   ask the amp for that slot first (Recall Preset), swap the new name into the
   returned data, then write the slot back.  Tone stays untouched, name persists. */
function clearNameSync(){
  if (state.pendingNameTimer){ clearTimeout(state.pendingNameTimer); state.pendingNameTimer = null; }
  state.pendingName = null;
}
function syncNameToAmp(slot, name){
  if (!out || !state.settings.sysex) return false;
  clearNameSync();
  state.pendingName = { slot: slot|0, name: String(name||"").toUpperCase().slice(0,18) };
  sysexRecallPreset(slot);
  logLine("out", `asking amp for preset ${pnum(slot)} to rename it`);
  state.pendingNameTimer = setTimeout(()=>{
    if (state.pendingName && state.pendingName.slot === (slot|0)){
      clearNameSync();
      toast("Amp didn't answer — the rename is saved in the app only.", "err");
    }
  }, 3000);
  return true;
}
/* Apply a queued rename to the 62-byte payload the amp returned for a slot.
   Keeps the amp's tone, swaps in the new name, writes the slot back. */
function applyNameSync(slot, payload){
  if (!state.pendingName || state.pendingName.slot !== (slot|0)) return false;
  const nm = state.pendingName.name || "";
  clearNameSync();
  for (let i=0;i<18;i++) payload[i] = nm.charCodeAt(i) || 0x20;
  sysexSetPreset(slot, decodePreset(payload, slot));
  if (state.presets[slot]){ state.presets[slot].name = nm; savePresets(); }
  if (slot === state.editSlot){
    state.edit.name = nm; $("#pName").value = nm; renderPresetGrid();
  }
  return true;
}

function onSysEx(data){
  if (data[0]!==0xF0) return;
  // header 00 21 15
  if (!(data[1]===0x00 && data[2]===0x21 && data[3]===0x15)) return;
  const loc = data[7], cmd = data[8], num = data[9];
  if (cmd === SYSEX.returned){
    const payload = data.slice(10, Math.max(10, data.length-1));
    if (payload.length < 58) return;
    const isPreset = loc===SYSEX.accessPreset;
    const slot = isPreset ? (num|0) : state.editSlot;
    // Reply to our own rename recall: keep the amp's tone, apply the new name,
    // then write the slot straight back so it persists across preset changes.
    if (isPreset && applyNameSync(slot, payload)){
      logLine("in", `preset ${pnum(slot)} returned — writing the new name back`);
      clearAmpReadPending();
      toast("Renamed & saved to amp slot "+pnum(slot), "ok");
      return;
    }
    const label = isPreset ? "preset "+pnum(num|0) : "current settings";
    logLine("in", `SysEx data returned (${label})`);
    clearAmpReadPending();
    const p = decodePreset(payload, slot);
    if (isPreset){
      state.presets[slot] = p; savePresets();
      setPresetNumber(slot+1, false);
    } else {
      loadIntoEditor(p);
    }
    toast("Read "+label+" from amp", "ok");
  }
}

function onMessage(m){
  const data = m.data;
  if (data[0] >= MIDI_REALTIME) return;
  if (onTunerMIDI(data)) return;           // tuner consumes note-on when listening
  logLine("in", hex(data));
  const type = data[0] & 0xF0;
  if (data[0] === 0xF0){ onSysEx(data); return; }
  if (type === 0xC0){ setPresetNumber(data[1]+1, false); return; }
  if (type === 0xB0){ handleIncomingCC(data[1], data[2]); }
}
function handleIncomingCC(cc, val){
  // find any control mapped to this CC and reflect it
  const rev = {}; Object.entries(state.cc).forEach(([k,v])=> rev[v]=k);
  const key = rev[cc]; if(!key) return;
  if (["gain","bass","middle","treble","volume"].includes(key)){
    state.edit.panel[key] = val; refreshPanelUI();
  } else if (key.endsWith("_on")){
    const sec = key.replace("_on",""); state.edit.chain[sec].on = !!val; refreshChainUI();
  } else if (key.endsWith("_type")){
    const sec = key.replace("_type",""); state.edit.chain[sec].type = val; refreshChainUI();
  } else {
    // section param key like prefx_p2 / rev_p1 / gate / presence
    applyParamCC(key, val);
  }
  if (state.settings.thru) sendCC(key, val, {silent:true});
}
function applyParamCC(key, val){
  const c = state.edit.chain;
  const map = {
    gate:["amp","gate"], presence:["power","presence"], resonance:["power","resonance"],
    prefx_p1:["prefx","p1"],prefx_p2:["prefx","p2"],prefx_p3:["prefx","p3"],prefx_p4:["prefx","p4"],
    mod_p1:["mod","p1"],mod_p2:["mod","p2"],mod_p3:["mod","p3"],mod_p4:["mod","p4"],
    delay_p2:["delay","p2"],delay_p3:["delay","p3"],delay_p4:["delay","p4"],
    rev_p1:["rev","p1"],rev_p2:["rev","p2"],rev_p3:["rev","p3"],rev_p4:["rev","p4"]
  };
  if (key==="delay_msb"){ c.delay.timeMs = ((val&0x7F)<<7)|(c.delay.timeMs&0x7F); refreshChainUI(); return; }
  if (key==="delay_lsb"){ c.delay.timeMs = (c.delay.timeMs&~0x7F)|(val&0x7F); refreshChainUI(); return; }
  const t = map[key]; if(t){ c[t[0]][t[1]] = val; refreshChainUI(); }
}

/* ---------------- device binding ---------------- */
function fillPorts(sel, list, pref){
  const keep = sel.value;
  sel.innerHTML = "";
  list.forEach(p => sel.add(new Option(p.name, p.id)));
  if (!list.length) sel.add(new Option("No device found",""));
  const auto = list.find(p=>/code|marshall/i.test(p.name));
  const want = list.some(p=>p.id===keep) ? keep : (pref || auto?.id || list[0]?.id || "");
  sel.value = want;
}
function bind(){
  const outs = access ? [...access.outputs.values()] : [];
  const ins  = access ? [...access.inputs.values()]  : [];
  [$("#out"),$("#out2")].forEach(s=>fillPorts(s,outs,state.settings.outId));
  [$("#inp"),$("#inp2")].forEach(s=>fillPorts(s,ins,state.settings.inId));
  pick();
}
function pick(){
  if (inp) inp.onmidimessage = null;
  const outId = ($("#out")?.value) || state.settings.outId;
  const inId  = ($("#inp")?.value) || state.settings.inId;
  out = access ? (access.outputs.get(outId) || null) : null;
  inp = access ? (access.inputs.get(inId)  || null) : null;
  if (inp) inp.onmidimessage = onMessage;
  state.settings.outId = outId; state.settings.inId = inId; persistSettings();
  // sync settings selects
  if ($("#out2")) $("#out2").value = outId;
  if ($("#inp2")) $("#inp2").value = inId;
  const on = !!out;
  $("#led").classList.toggle("on", on);
  $("#status").textContent = on ? out.name : (access ? "No output selected" : "Not connected");
  if (access) logLine("sys", `Bound. out=${out?out.name:"-"} in=${inp?inp.name:"-"}`);
}
function persistSettings(){ store.set(LS.settings, state.settings); }

function initMIDI(){
  if (!navigator.requestMIDIAccess){
    $("#status").textContent = "Web MIDI not supported";
    $("#sysexPill").textContent = "SysEx: n/a"; $("#sysexPill").classList.add("bad");
    toast("Web MIDI is not supported. Use Chrome or Edge (desktop).", "err");
    return;
  }
  const sysex = !!state.settings.sysex;
  navigator.requestMIDIAccess({ sysex }).then(a=>{
    access = a; a.onstatechange = bind; bind();
    $("#sysexPill").textContent = "SysEx: " + (sysex ? "on" : "off");
    $("#sysexPill").classList.toggle("ok", sysex);
    logLine("sys","MIDI ready" + (sysex?" (sysEx)":""));
    toast("MIDI ready", "ok");
  }).catch(err=>{
    $("#status").textContent = "MIDI access denied";
    logLine("err","MIDI error: "+err.message);
    toast("MIDI access denied: "+err.message, "err");
  });
}

/* ---------------- channel selects ---------------- */
function buildChannelSelects(){
  [$("#ch"),$("#ch2")].forEach(sel=>{
    sel.innerHTML="";
    for (let i=1;i<=16;i++) sel.add(new Option("Ch "+i, i-1));
    sel.value = state.settings.channel;
    sel.onchange = ()=>{ state.settings.channel = +sel.value;
      [$("#ch"),$("#ch2")].forEach(s=>s.value=state.settings.channel); persistSettings(); };
  });
}

/* ---------------- knobs ---------------- */
function makeKnob(node, {min=0,max=100, get, set, big=false, onInput, step}={}){
  const i = node.querySelector("i");
  // Wide-range controls (e.g. delay time 0–4000 ms) get a finer pixels-per-value ratio.
  const pxPerRange = (max-min) > 400 ? 360 : 180;
  const draw = v => {
    const p = (clamp(v,min,max)-min)/(max-min);
    i.style.transform = `rotate(${-135+p*270}deg)`;
    node.style.setProperty("--p", p.toFixed(4));   // drives the level ring in CSS
  };
  draw(get());
  let dragging=false, y0=0, v0=0;
  node.tabIndex=0; node.setAttribute("role","slider");
  node.setAttribute("aria-valuemin",min); node.setAttribute("aria-valuemax",max);
  const unit = step || Math.max(1, Math.round((max-min)/50));
  const commit = v => { v=clamp(Math.round(v),min,max); set(v); draw(v); node.setAttribute("aria-valuenow",v); onInput&&onInput(v); };
  node.addEventListener("pointerdown", e=>{ dragging=true; y0=e.clientY; v0=get(); node.setPointerCapture(e.pointerId); e.preventDefault(); });
  node.addEventListener("pointermove", e=>{ if(!dragging) return; commit(v0 + (y0-e.clientY)*(max-min)/pxPerRange); });
  node.addEventListener("pointerup", e=>{ dragging=false; try{node.releasePointerCapture(e.pointerId);}catch(_){} });
  node.addEventListener("wheel", e=>{ e.preventDefault(); commit(get() + (e.deltaY<0?unit:-unit)); }, {passive:false});
  node.addEventListener("keydown", e=>{ const d={ArrowUp:1,ArrowRight:1,ArrowDown:-1,ArrowLeft:-1}[e.key]; if(d){ e.preventDefault(); commit(get()+d*(e.shiftKey?1:unit)); } });
  // Double-click resets to the middle of the range (50 for 0–100 controls).
  node.addEventListener("dblclick", e=>{ e.preventDefault(); commit(min + (max-min)/2); });
  if (!node.title) node.title = "Drag vertically · scroll to fine-tune · double-click to reset";
  return { draw, redraw:()=>draw(get()) };
}

/* ---------------- AMP view ---------------- */
let knobRefs = {}, paramNodes = {};

function buildPanel(){
  const wrap = $("#panelKnobs"); wrap.innerHTML="";
  PANEL.forEach(p=>{
    const ctl = document.createElement("div"); ctl.className="ctl";
    ctl.innerHTML = `<div class="knob big"><i></i></div><div class="lbl">${p.label}</div><div class="val">0</div>`;
    wrap.appendChild(ctl);
    const node = ctl.querySelector(".knob"), valEl = ctl.querySelector(".val");
    const k = makeKnob(node, { min:0, max:100, get:()=>state.edit.panel[p.key], set:v=>{ state.edit.panel[p.key]=v; }, onInput:v=>{ valEl.textContent=v; sendCC(p.cc, v); } });
    valEl.textContent = state.edit.panel[p.key];
    knobRefs["panel_"+p.key] = k;
  });
  // Master — shown for parity with the amp but disabled: the CODE's Master is a
  // physical analog pot with no MIDI/SysEx address, so it cannot be remote-
  // controlled. It sends nothing and receives nothing; loudness is set with the
  // panel Volume knob (CC 74).
  const ctl = document.createElement("div");
  ctl.className = "ctl master-ctl disabled";
  ctl.setAttribute("aria-disabled","true");
  ctl.title = "The CODE's Master is a physical analog control — it has no MIDI or SysEx address and cannot be set over USB. Use Volume to change loudness from the app.";
  ctl.innerHTML = `<div class="knob big"><i></i></div><div class="lbl">Master <span class="tag warn" style="font-size:9px">hw</span></div><div class="val">—</div>`;
  wrap.appendChild(ctl);
}

function buildChain(){
  const wrap = $("#chain"); wrap.innerHTML="";
  const byKey = {}; CHAIN.forEach(s => byKey[s.key] = s);
  // Row 1: Pre FX · Amp · Cabinet   |   Row 2: the four extra modules.
  const ROWS = [
    { caption:"Core signal path", keys:["prefx","amp","cab"] },
    { caption:"Effects & power",  keys:["mod","delay","rev","power"] }
  ];
  ROWS.forEach(({caption,keys})=>{
    const cap = document.createElement("div");
    cap.className = "chain-caption";
    cap.innerHTML = `<span class="cc-line"></span><span>${caption}</span>`;
    wrap.appendChild(cap);
    const row = document.createElement("div");
    row.className = "chain-row";
    row.style.setProperty("--cols", keys.length);
    keys.forEach(k=>{ if (byKey[k]) row.appendChild(makeBlock(byKey[k])); });
    wrap.appendChild(row);
  });
  refreshChainUI();
}

function makeBlock(sec){
  const blk = document.createElement("div");
  blk.className = "block open";                     // expanded by default
  blk.dataset.sec = sec.key;
  blk.style.setProperty("--block-accent", sec.accent);
  blk.innerHTML = `
    <div class="block-head">
      <span class="block-ico">${sec.icon}</span>
      <div class="block-title">
        <div class="block-name">${sec.name}</div>
        <div class="block-sub" data-sub>${sec.sub}</div>
      </div>
      <span class="grow"></span>
      <div class="switch" data-switch role="switch" tabindex="0" aria-label="${sec.name} on/off"></div>
      <span class="chev" aria-hidden="true">▸</span>
    </div>
    <div class="block-body">
      <div class="model-bar">
        <button class="model-step" data-step="-1" aria-label="Previous ${sec.name} model">‹</button>
        <label class="model-current">
          <span class="eyebrow">Model</span>
          <select data-model aria-label="${sec.name} model"></select>
        </label>
        <button class="model-step" data-step="1" aria-label="Next ${sec.name} model">›</button>
        <span class="model-note" data-note></span>
      </div>
      <div class="params" data-params></div>
    </div>`;

  const head = blk.querySelector(".block-head");
  head.addEventListener("click", e=>{ if(e.target.closest(".switch")) return; blk.classList.toggle("open"); });
  const sw = blk.querySelector("[data-switch]");
  const toggle = ()=>{ const s=state.edit.chain[sec.key]; s.on=!s.on; refreshChainUI(); sendCC(sec.stateCC, s.on?1:0); };
  sw.addEventListener("click", toggle);
  sw.addEventListener("keydown", e=>{ if(e.key===" "||e.key==="Enter"){ e.preventDefault(); toggle(); }});

  const sel = blk.querySelector("[data-model]");
  sec.models.forEach((m,i)=>{
    if (sec.groupBy){
      let og = sel.querySelector(`optgroup[label="${m.group}"]`);
      if(!og){ og=document.createElement("optgroup"); og.label=m.group; sel.appendChild(og); }
      og.appendChild(new Option(m.name, i));
    } else sel.add(new Option(m.name, i));
  });
  const choose = v=>{
    const n = sec.models.length;
    v = ((v%n)+n)%n;
    state.edit.chain[sec.key].type = v;
    refreshChainUI();
    sendCC(sec.typeCC, v);
  };
  sel.addEventListener("change", ()=>choose(+sel.value));
  blk.querySelectorAll("[data-step]").forEach(b=>{
    b.addEventListener("click", ()=>choose((state.edit.chain[sec.key].type|0) + (+b.dataset.step)));
  });
  return blk;
}
function currentModel(sec){ const t = state.edit.chain[sec.key].type|0; return sec.models[clamp(t,0,sec.models.length-1)]; }

/* Continuous parameter rendered as a small rotary knob (matches the panel language). */
function createMiniKnob(sec, p){
  const key = p.special==="delayTime" ? "timeMs" : p.id;
  const min = p.min||0, max = p.max||100, off = p.offset||0;
  const fmt = v => (v+off) + (p.unit ? (" "+p.unit) : (p.special==="delayTime" ? " ms" : ""));
  const node = document.createElement("div");
  node.className = "param knob-param";
  node.dataset.paramId = p.id;
  node.innerHTML = `<div class="mini-knob"><i></i></div>
    <div class="plabel">${p.n}</div>
    <div class="pval" data-val></div>`;
  const knode = node.querySelector(".mini-knob"), valEl = node.querySelector("[data-val]");
  const cur = clamp(state.edit.chain[sec.key][key] ?? 50, min, max);
  state.edit.chain[sec.key][key] = cur;
  valEl.textContent = fmt(cur);
  const k = makeKnob(knode, {
    min, max,
    get:()=>state.edit.chain[sec.key][key],
    set:v=>{ state.edit.chain[sec.key][key]=v; },
    onInput:v=>{ valEl.textContent=fmt(v); if (p.special==="delayTime") sendDelayTime(v); else sendCC(p.cc, v); }
  });
  paramNodes[sec.key+"."+p.id] = { type:"knob", el:knode, valEl, p, fmt, knob:k };
  return node;
}

/* Discrete parameter (e.g. Mode CLS/VIB) rendered as a segmented switch. */
function createSegmented(sec, p){
  const cur = state.edit.chain[sec.key][p.id]|0;
  const node = document.createElement("div");
  node.className = "param seg-param";
  node.dataset.paramId = p.id;
  node.innerHTML = `<div class="plabel">${p.n}</div>
    <div class="seg" role="radiogroup" aria-label="${p.n}">
      ${p.options.map((o,i)=>`<button type="button" data-v="${i}" class="${i===cur?"on":""}" aria-pressed="${i===cur}">${o}</button>`).join("")}
    </div>`;
  const seg = node.querySelector(".seg");
  seg.addEventListener("click", e=>{
    const b = e.target.closest("button"); if(!b) return;
    const v = +b.dataset.v;
    state.edit.chain[sec.key][p.id] = v;
    Array.from(seg.children).forEach(x=>{ const on=+x.dataset.v===v; x.classList.toggle("on", on); x.setAttribute("aria-pressed", on); });
    sendCC(p.cc, v);
  });
  paramNodes[sec.key+"."+p.id] = { type:"seg", el:seg, p };
  return node;
}

function renderParams(sec){
  const blk = document.querySelector(`.block[data-sec="${sec.key}"]`);
  if(!blk) return;
  const box = blk.querySelector("[data-params]");
  box.innerHTML="";
  // Every chain box uses two centred rows: the Mode/selector row on top (when the
  // model has one), then the knob row beneath it.
  box.classList.add("stacked");
  const model = currentModel(sec);
  if (!model.params.length){
    box.innerHTML = `<div class="param-empty">Cabinet selection only — no adjustable parameters.</div>`;
    return;
  }
  const segs  = model.params.filter(p => p.options);
  const knobs = model.params.filter(p => !p.options);
  if (segs.length){
    const row = document.createElement("div"); row.className = "params-row mode-row";
    segs.forEach(p => row.appendChild(createSegmented(sec,p)));
    box.appendChild(row);
  }
  if (knobs.length){
    const row = document.createElement("div"); row.className = "params-row row-knobs";
    knobs.forEach(p => row.appendChild(createMiniKnob(sec,p)));
    box.appendChild(row);
  }
}
function refreshChainUI(){
  const c = state.edit.chain;
  CHAIN.forEach(sec=>{
    const blk = document.querySelector(`.block[data-sec="${sec.key}"]`);
    if(!blk) return;
    const s = c[sec.key];
    const model = currentModel(sec);
    blk.classList.toggle("bypassed", !s.on);
    blk.querySelector("[data-sub]").textContent = model ? model.name : sec.sub;
    const note = blk.querySelector("[data-note]");
    if (note) note.textContent = (model && model.note) ? model.note : sec.sub;
    const sw = blk.querySelector("[data-switch]");
    sw.classList.toggle("on", !!s.on);
    sw.setAttribute("aria-checked", s.on?"true":"false");
    const sel = blk.querySelector("[data-model]"); if (sel) sel.value = s.type;
    const eb = blk.querySelector(".eyebrow");
    if (eb){ const n = sec.models.length; const idx = clamp(s.type|0,0,n-1); eb.textContent = `Model ${idx+1} / ${n}`; }
    renderParams(sec);
  });
  updateStripDirty();
}
function refreshPanelUI(){
  PANEL.forEach(p=>{ const k=knobRefs["panel_"+p.key]; if(k) k.redraw();
    const v=document.querySelector(`#panelKnobs .ctl:nth-child(${PANEL.indexOf(p)+1}) .val`); if(v) v.textContent=state.edit.panel[p.key]; });
  updateStripDirty();
}

/* ---------------- editor ---------------- */
function loadIntoEditor(preset){
  state.edit = JSON.parse(JSON.stringify(preset));
  $("#pNum").textContent = pnum(state.editSlot);
  $("#pSlotLabel").textContent = pnum(state.editSlot);
  $("#pName").value = state.edit.name;
  refreshPanelUI();
  refreshChainUI();
  renderPresetGrid();
}
function commitEditorToSlot(){ state.presets[state.editSlot] = JSON.parse(JSON.stringify(state.edit)); savePresets(); }
/* True when the editor differs from the stored slot — drives the "unsaved" chip. */
function editorDirty(){
  if (!state.edit || !state.presets || !state.presets[state.editSlot]) return false;
  try { return JSON.stringify(state.edit) !== JSON.stringify(state.presets[state.editSlot]); }
  catch(_){ return false; }
}
function updateStripDirty(){ const d = $("#pDirty"); if (d) d.hidden = !editorDirty(); }

/* Load a preset into the editor without touching the local-slot number or grid. */
function loadIntoEditorQuiet(preset){
  state.edit = JSON.parse(JSON.stringify(preset));
  $("#pName").value = state.edit.name;
  refreshPanelUI();
  refreshChainUI();
}

function setPresetNumber(n, sendIt){
  n = ((n-1)%NUM_PRESETS+NUM_PRESETS)%NUM_PRESETS + 1;
  state.editSlot = n-1;
  $("#pNum").textContent = pnum(n-1);
  $("#pSlotLabel").textContent = pnum(n-1);
  if (sendIt) sendPC(n-1);
  loadIntoEditor(state.presets[state.editSlot]);
  if (sendIt) toast("Preset "+pnum(n-1)+": "+state.presets[n-1].name);
}

/* ---------------- local preset grid ---------------- */
function renderPresetGrid(){
  const q = ($("#presetSearch")?.value||"").toLowerCase();
  const f = $("#presetFilter")?.value||"all";
  const sort = $("#presetSort")?.value||"slot";
  const grid = $("#presetGrid"); if(!grid) return;
  grid.innerHTML="";
  const chipsFor = p => {
    const chips = [];
    if (p.chain.amp.on) chips.push("Amp");
    if (p.chain.prefx.on) chips.push("Pre");
    if (p.chain.mod.on) chips.push("Mod");
    if (p.chain.delay.on) chips.push("Dly");
    if (p.chain.rev.on) chips.push("Rev");
    if (p.chain.power.on) chips.push("Pow");
    if (p.chain.cab.on) chips.push("Cab");
    return chips;
  };
  // Counters always reflect the whole library, regardless of filter/sort.
  let namedCount = 0, favCount = 0, fxCount = 0;
  state.presets.forEach(p=>{
    if (p.name && !/^PRESET \d+$/.test(p.name)) namedCount++;
    if (p.fav) favCount++;
    if (chipsFor(p).length > 1) fxCount++;
  });
  let order = state.presets.map((p,i)=>({p,i}));
  if (sort==="az") order.sort((a,b)=>a.p.name.localeCompare(b.p.name) || a.i-b.i);
  else if (sort==="za") order.sort((a,b)=>b.p.name.localeCompare(a.p.name) || a.i-b.i);
  else if (sort==="fav") order.sort((a,b)=>(b.p.fav?1:0)-(a.p.fav?1:0) || a.i-b.i);
  let shown = 0;
  order.forEach(({p,i})=>{
    const named = p.name && !/^PRESET \d+$/.test(p.name);
    if (q && !p.name.toLowerCase().includes(q)) return;
    if (f==="fav" && !p.fav) return;
    if (f==="named" && !named) return;
    if (f==="empty" && named) return;
    shown++;
    const chips = chipsFor(p);
    const cell = document.createElement("div");
    cell.className = "pcell" + (i===state.editSlot?" cur":"") + (named?"":" unnamed");
    cell.dataset.slot = i;
    cell.title = "Click to load · double-click to rename";
    cell.innerHTML = `<div class="pcell-top">
        <span class="pn">${pnum(i)}</span>
        <span class="fav ${p.fav?"on":""}" data-fav title="Favourite">${p.fav?"★":"☆"}</span>
      </div>
      <div class="pnm">${escapeHtml(p.name)}</div>
      <div class="pmods">${chips.map(c=>`<span class="chip">${c}</span>`).join("")||'<span class="chip ghost">empty</span>'}</div>`;
    cell.addEventListener("click", e=>{
      if (e.target.closest("[data-fav]")){ p.fav=!p.fav; savePresets(); renderPresetGrid(); return; }
      setPresetNumber(i+1, false);
    });
    cell.addEventListener("dblclick", e=>{
      if (e.target.closest("[data-fav]")) return;
      openRename();
    });
    grid.appendChild(cell);
  });
  if (!grid.children.length) grid.innerHTML = `<p class="muted small" style="grid-column:1/-1">No presets match.</p>`;
  const meta = $("#presetMeta");
  if (meta) meta.innerHTML = `<span class="stat"><b>${shown}</b> shown</span><span class="stat"><b>${namedCount}</b> named</span><span class="stat"><b>${favCount}</b> favourite${favCount===1?"":"s"}</span><span class="stat"><b>${fxCount}</b> with effects</span>`;
  const badge = $("#presetBadge"); if (badge) badge.textContent = namedCount;
  renderPresetDetail();
}
function escapeHtml(s){ return (s||"").replace(/[&<>"]/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }
function renderPresetDetail(){
  const box = $("#presetDetail"); if(!box) return;
  const p = state.presets[state.editSlot], c = p.chain;
  const grp = (title, modelName, on, params)=>`
    <div class="detail-block ${on?"":"off"}">
      <div class="db-head">
        <span class="db-title">${title}</span>
        <span class="db-state ${on?"on":""}">${on?"● on":"○ off"}</span>
      </div>
      <div class="db-model">${escapeHtml(modelName)}</div>
      ${params.length?`<div class="detail-params">${params.map(([k,v])=>`<div class="dp"><b>${v}</b>${k}</div>`).join("")}</div>`:""}
    </div>`;
  const amp = CHAIN[1].models[clamp(c.amp.type,0,14)];
  const pre = CHAIN[0].models[clamp(c.prefx.type,0,3)];
  const mod = CHAIN[2].models[clamp(c.mod.type,0,3)];
  const dly = CHAIN[3].models[clamp(c.delay.type,0,3)];
  const rev = CHAIN[4].models[clamp(c.rev.type,0,3)];
  const pow = CHAIN[5].models[clamp(c.power.type,0,3)];
  const cab = CHAIN[6].models[clamp(c.cab.type,0,7)];
  const onCount = ["prefx","amp","mod","delay","rev","power","cab"].filter(k=>c[k].on).length;
  box.innerHTML = `
    <div class="detail-head">
      <h3>${pnum(state.editSlot)} · ${escapeHtml(p.name)}</h3>
      <span class="muted small">Slot ${pnum(state.editSlot)} · ${onCount} modules on</span>
    </div>
    <div class="detail-devices">
      ${grp("Panel", "Gain · Bass · Middle · Treble · Volume", true, [["Gain",p.panel.gain],["Bass",p.panel.bass],["Mid",p.panel.middle],["Treb",p.panel.treble],["Vol",p.panel.volume]])}
      ${grp("Pre FX", pre.name, c.prefx.on, [["P1",c.prefx.p1],["P2",c.prefx.p2],["P3",c.prefx.p3],["P4",c.prefx.p4]])}
      ${grp("Amp", amp.name, c.amp.on, [["Gate",c.amp.gate]])}
      ${grp("Modulation", mod.name, c.mod.on, [["P1",c.mod.p1],["P2",c.mod.p2],["P3",c.mod.p3],["P4",c.mod.p4]])}
      ${grp("Delay", dly.name, c.delay.on, [["Time",c.delay.timeMs+"ms"],["P2",c.delay.p2],["P3",c.delay.p3],["P4",c.delay.p4]])}
      ${grp("Reverb", rev.name, c.rev.on, [["P1",c.rev.p1],["P2",c.rev.p2],["P3",c.rev.p3],["P4",c.rev.p4]])}
      ${grp("Power", pow.name, c.power.on, [["Pres",c.power.presence],["Reso",c.power.resonance]])}
      ${grp("Cabinet", cab.name, c.cab.on, [])}
    </div>
    <div class="row-actions wrap" style="margin-top:16px">
      <button class="btn primary sm" id="dtSend">Send to amp</button>
      <button class="btn ghost sm" id="dtRename">Rename</button>
      <button class="btn ghost sm" id="dtCopy">Copy</button>
      <button class="btn ghost sm" id="dtPaste">Paste</button>
      <button class="btn ghost sm" id="dtClear">Clear</button>
    </div>`;
  box.querySelector("#dtSend").onclick = ()=>{ sysexSetPreset(state.editSlot, state.presets[state.editSlot]); toast("Sent preset "+pnum(state.editSlot)+" to amp","ok"); };
  box.querySelector("#dtRename").onclick = openRename;
  box.querySelector("#dtCopy").onclick = ()=>{ window._clip = JSON.parse(JSON.stringify(state.presets[state.editSlot])); toast("Copied"); };
  box.querySelector("#dtPaste").onclick = ()=>{ if(!window._clip) return toast("Clipboard empty","err"); state.presets[state.editSlot]=Object.assign(JSON.parse(JSON.stringify(window._clip)),{name:state.presets[state.editSlot].name}); savePresets(); loadIntoEditor(state.presets[state.editSlot]); toast("Pasted"); };
  box.querySelector("#dtClear").onclick = ()=>{ if(confirm("Reset this slot to default?")){ state.presets[state.editSlot]=blankPreset(state.editSlot); savePresets(); loadIntoEditor(state.presets[state.editSlot]); } };
}

/* ---------------- CLOUD ---------------- */
async function cloudFetch(path, opts){
  const res = await fetch(CLOUD_BASE + path, Object.assign({ credentials:"include" }, opts||{}));
  if (!res.ok) throw new Error(path+" → HTTP "+res.status);
  return res;
}
function setCloudStatus(){
  const el = $("#cloudStatus"); if(!el) return;
  const u = state.login.user;
  const who = u && (u.name || u.email);
  el.textContent = state.cloud.online
    ? (state.login.ok ? "online · " + (who || "signed in") : "online")
    : "offline";
  if (el) el.title = who || "";
  el.classList.toggle("ok", state.cloud.online);
  el.classList.toggle("bad", !state.cloud.online);
  const b = $("#btnCloudLogin"); if(b) b.textContent = state.login.ok ? "Sign out" : "Sign in";
}
async function cloudProfile(){
  try{
    const j = await (await cloudFetch("/api/profile")).json();
    if (j.ok){
      state.login.user = Object.assign({}, state.login.user||{},
        { name: j.name||"", email: j.email || (state.login.user&&state.login.user.email) || "" });
      if (j.email) state.login.email = j.email;
    }
  }catch(_){ /* profile details are optional */ }
}
async function cloudCheck(){
  try{
    const r = await cloudFetch("/api/session");
    const j = await r.json();
    state.cloud.online = true; state.login.ok = !!j.signedIn; state.login.user = j.user||null;
  }catch(e){ state.cloud.online = false; }
  if (state.login.ok && !(state.login.user && state.login.user.name)) await cloudProfile();
  setCloudStatus();
}
async function cloudLoad(reset){
  const C = state.cloud;
  const introEl = $("#cloudIntro"); if(introEl) introEl.textContent = CLOUD_INTROS[C.type]||"";
  // Any new load supersedes one still in flight, so the latest click always wins.
  const reqId = ++C.reqId;
  C.loading = true;
  if (reset){ C.page=1; C.items=[]; C.hasMore=true; }
  if (C.type==="Fav"){ C.loading=false; renderCloudFavs(); return; }
  if (C.type==="My" && !state.login.ok){
    C.loading=false; C.hasMore=false; C.items=[];
    $("#cloudMore").hidden = true; $("#cloudEnd").textContent = "";
    $("#cloudGrid").innerHTML = `<div class="card" style="grid-column:1/-1">
      <b>Sign in to see My Library.</b>
      <p class="muted small">My Library lists the presets saved to your Marshall account. Use the <b>Sign in</b> button above — the local helper authenticates through Marshall's identity server for you, and your password is never stored. Presets you star on this device appear under <b>★ Favourites</b>.</p></div>`;
    updateCloudCount();
    return;
  }
  if (!C.hasMore){ C.loading=false; return; }
  if (reset) $("#cloudGrid").innerHTML = Array.from({length:8},()=>`<div class="ccard skeleton" style="height:290px"></div>`).join("");
  $("#cloudMore").disabled = true;
  try{
    const url = `/Presets/GetPresets?page=${C.page}&type=${encodeURIComponent(C.type)}&searchTerm=${encodeURIComponent(C.search)}&sortOrder=${encodeURIComponent(C.sort)}`;
    const html = await (await cloudFetch(url)).text();
    if (reqId !== C.reqId) return;         // superseded by a newer load
    const items = parsePresetList(html);
    C.online = true;
    if (!items.length){ C.hasMore=false; if(reset) $("#cloudGrid").innerHTML=`<p class="muted">No presets found.</p>`; }
    else {
      C.items = reset ? items : C.items.concat(items);
      renderCloudGrid();
      C.page++;
      if (items.length < CLOUD_PAGE_SIZE) C.hasMore = false;
    }
  }catch(e){
    if (reqId !== C.reqId) return;
    state.cloud.online=false;
    if (reset) $("#cloudGrid").innerHTML = `<div class="card" style="grid-column:1/-1">
      <b>Cloud unavailable.</b><p class="muted small">The browser cannot reach codepresets.marshall.com directly (CORS) and the local proxy is not running.</p>
      <p class="muted small">Start it with: <code>python3 proxy/server.py</code> then open the app at <code>http://localhost:8787</code>.</p></div>`;
    logLine("err","cloud: "+e.message);
  }finally{
    if (reqId === C.reqId){
      C.loading=false; setCloudStatus();
      $("#cloudMore").disabled=false;
      $("#cloudMore").hidden = !C.hasMore || C.type==="Fav";
      $("#cloudEnd").textContent = C.hasMore ? "" : "End of results";
      updateCloudCount();
    }
  }
}
function parsePresetList(html){
  const doc = new DOMParser().parseFromString(html, "text/html");
  return Array.from(doc.querySelectorAll(".preset-container")).map(el=>({
    id: el.getAttribute("data-preset-id"),
    name: (el.querySelector(".preset-track p")?.textContent||"").trim(),
    img: fixImg(el.querySelector(".preset-image")?.getAttribute("src")||""),
    downloads: (el.querySelector(".download-count")?.textContent||"").trim(),
    ratings: (el.querySelector(".rating-count")?.textContent||"").trim()
  })).filter(x=>x.id);
}
function updateCloudCount(){
  const el = $("#cloudCount"); if (!el) return;
  const n = state.cloud.items.length;
  if (state.cloud.type==="Fav") el.textContent = n ? `${n} favourite${n===1?"":"s"}` : "";
  else el.textContent = n ? `${n} preset${n===1?"":"s"} shown` : "";
}
function renderCloudGrid(){
  const grid = $("#cloudGrid");
  grid.innerHTML = state.cloud.items.map(it=>{
    const fav = !!state.favs[it.id];
    const cover = it.img
      ? `<img class="ccard-img" loading="lazy" src="${it.img}" alt="${escapeHtml(it.name)}" onerror="this.style.opacity=.25">`
      : `<div class="ccard-img empty" title="Cover loading…">♪</div>`;
    return `<div class="ccard" data-id="${it.id}">
      <div class="ccard-img-wrap">${cover}<span class="ccard-open">Open preset ▸</span></div>
      <div class="ccard-body">
        <div style="display:flex;gap:8px;align-items:flex-start">
          <div class="ccard-title" style="flex:1">${escapeHtml(it.name)}</div>
          <span class="fav ${fav?"on":""}" data-clfav="${it.id}" title="${fav?"Remove favourite":"Add favourite"}">${fav?"★":"☆"}</span>
        </div>
        <div class="ccard-meta">
          <span>⭳ ${it.downloads||0}</span><span class="${it.ratings?'on':''}">♨ ${it.ratings||0}</span>
        </div>
      </div></div>`;
  }).join("");
  updateCloudCount();
  grid.onclick = e=>{
    const favBtn = e.target.closest("[data-clfav]");
    if (favBtn){
      const id = favBtn.dataset.clfav;
      const it = state.cloud.items.find(x=>String(x.id)===String(id)) || state.favs[id] || {};
      toggleFav(id, it);
      (state.cloud.type==="Fav" ? renderCloudFavs : renderCloudGrid)();
      return;
    }
    const card = e.target.closest(".ccard"); if(card) openCloudPreset(card.dataset.id);
  };
}
function toggleFav(id, item){
  if (state.favs[id]){ delete state.favs[id]; toast("Removed favourite"); }
  else {
    const it = (item && typeof item==="object") ? item : { name: item };
    state.favs[id] = {
      name: String(it.name || ("Preset "+id)).slice(0,60),
      img: it.img || "",
      downloads: it.downloads || "",
      ratings: it.ratings || ""
    };
    toast("Added to favourites ★");
  }
  store.set(LS.favs, state.favs);
}
function renderCloudFavs(){
  const ids = Object.keys(state.favs);
  const grid = $("#cloudGrid");
  $("#cloudMore").hidden = true; $("#cloudEnd").textContent = "";
  if (!ids.length){ state.cloud.items = []; grid.innerHTML = `<p class="muted">No favourites yet. Star presets in Official, Community or My Library.</p>`; updateCloudCount(); return; }
  state.cloud.items = ids.map(id=>{
    const f = state.favs[id] || {};
    return { id, name: f.name || ("Preset "+id), img: f.img || "", downloads: f.downloads || "", ratings: f.ratings || "" };
  });
  renderCloudGrid();                       // identical look to the other tabs
  fillFavImages(ids.filter(id=>!(state.favs[id] && state.favs[id].img)));
}
/* Older favourites were stored as {name} only — backfill their cover art. */
async function fillFavImages(ids){
  if (!ids.length) return;
  let changed = false;
  for (const id of ids){
    if (!state.favs[id] || state.favs[id].img) continue;
    try{
      const html = await (await cloudFetch(`/Presets/GetPresetModalHeader?presetId=${id}`)).text();
      const doc = new DOMParser().parseFromString(html,"text/html");
      const img = fixImg(doc.querySelector(".preset-modal-image img")?.getAttribute("src")||"");
      const name = (doc.querySelector("#PresetName")?.textContent||"").trim();
      const f = state.favs[id]; if (!f) continue;
      if (img){ f.img = img; changed = true; }
      if (name) f.name = name;
      const card = document.querySelector('#cloudGrid .ccard[data-id="'+id+'"]');
      if (card){
        const wrap = card.querySelector(".ccard-img-wrap");
        if (wrap && f.img) wrap.innerHTML = `<img class="ccard-img" loading="lazy" src="${f.img}" alt="${escapeHtml(f.name)}" onerror="this.style.opacity=.25">`;
        const t = card.querySelector(".ccard-title"); if (t && name) t.textContent = name;
      }
    }catch(_){ /* leave the placeholder if offline */ }
  }
  if (changed) store.set(LS.favs, state.favs);
}
async function openCloudPreset(id){
  const body = $("#modalPresetBody");
  openModal("#modalPreset");
  body.innerHTML = `<div class="loading">Loading preset…</div>`;
  try{
    const [headHtml, detHtml] = await Promise.all([
      (await cloudFetch(`/Presets/GetPresetModalHeader?presetId=${id}`)).text(),
      (await cloudFetch(`/Presets/GetDetails?presetId=${id}`)).text()
    ]);
    const hdoc = new DOMParser().parseFromString(headHtml,"text/html");
    const name = (hdoc.querySelector("#PresetName")?.textContent||"").trim() || "Preset "+id;
    const desc = (hdoc.querySelector(".preset-meta-label + p.mb-0")?.textContent||"").trim();
    const author = Array.from(hdoc.querySelectorAll(".preset-meta-label")).map(x=>x.textContent.trim()).find(t=>/published by/i.test(t)) || "";
    const uid = hdoc.querySelector("[data-user-id]")?.dataset.userId;
    const img = fixImg(hdoc.querySelector(".preset-modal-image img")?.getAttribute("src")||"");
    const devices = parsePresetDetail(detHtml);
    const local = cloudToLocal(devices, name);
    const onDevices = devices.filter(d=>d.on);
    body.innerHTML = `
      <div class="cloud-detail-head">
        <img src="${img}" onerror="this.style.visibility='hidden'">
        <div class="info">
          <h2 style="font-family:var(--display);font-size:26px">${escapeHtml(name)}</h2>
          <p class="muted small">${escapeHtml(desc).slice(0,220) || "No description provided."}</p>
          <p class="muted small">${escapeHtml(author)}${uid?(" · user "+uid.slice(0,8)):""}</p>
          <div class="detail-chips">
            ${onDevices.length ? onDevices.map(d=>`<span class="chip">${escapeHtml(d.label)} · ${escapeHtml(d.name)}</span>`).join("") : '<span class="chip ghost">no devices enabled</span>'}
          </div>
          <div class="row-actions wrap" style="margin-top:12px">
            <button class="btn primary" id="cdLoad">Load into editor</button>
            <button class="btn ghost" id="cdSlot">Save to next free slot</button>
            <button class="btn ghost" id="cdFav">${state.favs[id]?"★ Favourited":"☆ Favourite"}</button>
            <button class="btn ghost" id="cdLib">Toggle Marshall library</button>
          </div>
        </div>
      </div>
      <div class="detail-section-title">Device settings</div>
      <div class="params-grid" id="cdParams"></div>`;
    $("#cdParams").innerHTML = devices.map(d=>`
      <div class="dev-group ${d.on?"":"off"}">
        <div class="dg-head"><span class="dg-name">${escapeHtml(d.label)}</span><span class="db-state ${d.on?"on":""}">${d.on?"● on":"○ off"}</span></div>
        <div class="dg-model">${escapeHtml(d.name)||"—"}</div>
        ${d.params.map(p=>`<div class="dp"><b>${p.display}${p.max===10?"":" / "+p.max}</b>${escapeHtml(p.name)}</div>`).join("") || '<span class="muted small">No parameters</span>'}
      </div>`).join("");
    $("#cdLoad").onclick = ()=>{ local.name = name; loadIntoEditorQuiet(local); closeModal("#modalPreset"); switchView("amp"); toast("Loaded into editor — tweak then Store to amp","ok"); };
    $("#cdSlot").onclick = ()=>{ const i = state.presets.findIndex(p=>/^PRESET \d+$/.test(p.name)); const slot=i<0?state.editSlot:i; state.presets[slot]=Object.assign(local,{name}); savePresets(); renderPresetGrid(); toast("Saved to slot "+pnum(slot),"ok"); };
    $("#cdFav").onclick = ()=>{ toggleFav(id, { name, img, downloads:"", ratings:"" }); $("#cdFav").textContent = state.favs[id]?"★ Favourited":"☆ Favourite"; (state.cloud.type==="Fav"?renderCloudFavs:renderCloudGrid)(); };
    $("#cdLib").onclick = async ()=>{
      try{ const r = await cloudFetch("/Presets/MyLibraryDownload", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({presetId:id}) });
        const j = await r.json(); toast(j.downloaded?"Added to Marshall library":"Removed from library","ok");
      }catch(e){ toast("Library action failed — sign in first","err"); }
    };
  }catch(e){
    body.innerHTML = `<div class="loading">Could not load preset.<br><span class="muted small">${escapeHtml(e.message)}</span></div>`;
  }
}
function parsePresetDetail(html){
  const doc = new DOMParser().parseFromString(html,"text/html");
  return Array.from(doc.querySelectorAll(".preset-device")).map(dev=>{
    const label = dev.querySelector(".device")?.textContent.trim() || "";
    const name  = dev.querySelector(".preset-device-name")?.textContent.trim() || "";
    const on = dev.classList.contains("is-on");
    const params = Array.from(dev.querySelectorAll(".preset-device-parameter")).map(pp=>{
      const nm = pp.querySelector(".preset-device-parameter-name")?.textContent.trim()||"";
      const d = pp.querySelector(".dial");
      const min=+(d?.dataset.min||0), max=+(d?.dataset.max||10);
      const raw = d?.dataset.value!=null ? +d.dataset.value : 0;
      return { name:nm, min, max, raw, display:String(raw) };
    });
    return { label, name, on, params };
  });
}
function cloudToLocal(devices, name){
  const p = blankPreset(0); p.name = name;
  const deviceKey = { "PreAmp":"amp","PowerAmp":"power","Cabinet":"cab","Pedal":"prefx","Modulation":"mod","Delay":"delay","Reverb":"rev" };
  devices.forEach(d=>{
    const sec = deviceKey[d.label]; if(!sec) return;
    p.chain[sec].on = d.on;
    const list = MODELS_BY_SEC[sec]||[];
    const mi = list.findIndex(m=>m.name.toLowerCase()===d.name.toLowerCase());
    if (mi>=0) p.chain[sec].type = mi;
    if (sec==="cab") return;

    // PreAmp carries the panel tone controls + gate
    if (sec==="amp"){
      d.params.forEach(x=>{
        if (/threshold|gate/i.test(x.name)) { p.chain.amp.gate = toCC(x); return; }
        if (/gain/i.test(x.name))   p.panel.gain   = toCC(x);
        if (/bass/i.test(x.name))   p.panel.bass   = toCC(x);
        if (/middle/i.test(x.name)) p.panel.middle = toCC(x);
        if (/treble/i.test(x.name)) p.panel.treble = toCC(x);
        if (/volume/i.test(x.name)) p.panel.volume = toCC(x);
      });
      return;
    }
    if (sec==="power"){
      d.params.forEach(x=>{ if(/presence/i.test(x.name)) p.chain.power.presence=toCC(x); if(/resonance/i.test(x.name)) p.chain.power.resonance=toCC(x); });
      return;
    }
    // map remaining effect params onto pN by matching the model's parameter names,
    // falling back to positional order for names the cloud omits.
    const model = list[mi] || list[0];
    let pos = 2; // p1 is reserved for the (omitted) enum/mode parameter
    d.params.forEach(x=>{
      if (/^time$/i.test(x.name)){ p.chain.delay.timeMs = clamp(Math.round(x.raw),0,4000); return; }
      const match = model && model.params.find(mp=>mp.n.toLowerCase()===x.name.toLowerCase());
      if (match) p.chain[sec][match.id] = toCC(x);
      else { p.chain[sec]["p"+Math.min(pos,4)] = toCC(x); }
      pos++;
    });
  });
  return p;
}
function toCC(x){
  if (/semitone/i.test(x.name)) return clamp(Math.round(x.raw)+12,0,24);
  if (/fine|skew/i.test(x.name)) return clamp(Math.round(x.raw)+50,0,100);
  return clamp(Math.round(x.raw*(100/(x.max||10))),0,100);
}

/* ---------------- LOGIN ---------------- */
async function doLogin(){
  const email = $("#loginEmail").value.trim(), password = $("#loginPass").value;
  $("#loginMsg").textContent = "Signing in…";
  try{
    const r = await cloudFetch("/api/login", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({email,password}) });
    const j = await r.json();
    state.login.ok = !!j.ok; state.login.user = { email };
    if ($("#loginRemember").checked){ store.set(LS.email, email); state.login.email=email; }
    $("#loginMsg").innerHTML = j.ok ? '<span style="color:var(--ok)">Signed in.</span>' : `<span style="color:var(--red)">${escapeHtml(j.error||"Sign-in failed")}</span>`;
    if (j.ok){ setCloudStatus(); cloudProfile().then(setCloudStatus); setTimeout(()=>closeModal("#modalLogin"),700); if(state.cloud.type==="My") cloudLoad(true); }
  }catch(e){
    $("#loginMsg").innerHTML = `<span style="color:var(--red)">Cloud proxy not reachable. Run <code>python3 proxy/server.py</code> and open via http://localhost:8787.</span>`;
  }
}
async function doLogout(){
  try{ await cloudFetch("/api/logout",{method:"POST"}); }catch(_){}
  state.login.ok=false; setCloudStatus(); toast("Signed out");
}

/* ---------------- TUNER ---------------- */
let tunerOn = false;
const tunerNotes = [];
const NOTE_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
function renderTunerHistory(){
  const el = $("#tunerHistory"); if (!el) return;
  el.innerHTML = tunerNotes.map((n,i)=>`<span class="tnote${i===0?" now":""}">${escapeHtml(n)}</span>`).join("");
}
function toggleTuner(){
  tunerOn = !tunerOn;
  $("#tunerToggle").textContent = tunerOn ? "Stop tuner" : "Start tuner";
  const st = $("#tunerStatus");
  if (st){ st.textContent = tunerOn ? "listening" : "idle"; st.classList.toggle("ok", tunerOn); st.classList.toggle("bad", false); }
  // Ask the amp to enter tuner mode via the documented button combo equivalent is not exposed over CC;
  // tuner notes are transmitted while the amp's tuner is engaged. We still request note data listening.
  if (tunerOn){ toast("Tuner listening — engage TUNER on the amp (PRE FX + AMP)."); switchView("tuner"); }
  else {
    $("#tunerNote").textContent="–"; $("#tunerOctave").textContent=""; $("#tunerMark").style.left="50%"; $("#tunerHint").textContent="—";
    tunerNotes.length = 0; renderTunerHistory();
  }
}
function onTunerMIDI(data){
  if (!tunerOn) return false;
  const status = data[0];
  if ((status & 0xF0) === 0x90 && data[2] > 0){
    const n = data[1];
    const pc = n % 12, oct = Math.floor(n/12) - 1;
    const note = NOTE_NAMES[pc];
    $("#tunerNote").textContent = note;
    $("#tunerOctave").textContent = "octave " + oct;
    $("#tunerMark").style.left = "50%";
    $("#tunerHint").textContent = "Detected " + note + oct;
    tunerNotes.unshift(note + oct);
    tunerNotes.length = Math.min(tunerNotes.length, 6);
    renderTunerHistory();
    return true;
  }
  return false;
}

/* ---------------- VIEWS ---------------- */
function switchView(name){
  $$(".view").forEach(v=>v.classList.toggle("active", v.id==="view-"+name));
  $$(".nav-item").forEach(b=>b.classList.toggle("active", b.dataset.view===name));
  $$(".bottomnav button").forEach(b=>b.classList.toggle("active", b.dataset.view===name));
  $("#sidebar").classList.remove("open");
  if (name==="cloud"){ cloudCheck().then(()=>{ if(!state.cloud.items.length) cloudLoad(true); }); }
  if (name==="presets") renderPresetGrid();
  if (name==="monitor") renderMonitor();
  history.replaceState(null, "", "#"+name);
  window.scrollTo({top:0});
}
function viewFromHash(){ const h=(location.hash||"").replace(/^#/,""); return h||"amp"; }

/* ---------------- modals ---------------- */
function openModal(sel){ $(sel).classList.add("open"); $(sel).setAttribute("aria-hidden","false"); }
function closeModal(sel){ $(sel).classList.remove("open"); $(sel).setAttribute("aria-hidden","true"); }
/* Open the rename dialog for the preset currently in the editor. */
function openRename(){
  const inp = $("#renameInput"); if (!inp) return;
  inp.value = state.edit ? state.edit.name : "";
  openModal("#modalRename");
  setTimeout(()=>{ inp.focus(); inp.select(); }, 40);
}
document.addEventListener("click", e=>{
  if (e.target.matches("[data-close]") || e.target.classList.contains("modal")){
    const m = e.target.closest(".modal"); if(m){ m.classList.remove("open"); m.setAttribute("aria-hidden","true"); }
  }
});
/* Global keyboard: Esc closes dialogs; number keys switch views; arrows step
   presets while the Amplifier is showing. Skipped while typing or using a knob. */
document.addEventListener("keydown", e=>{
  if (e.key === "Escape"){
    const open = document.querySelector(".modal.open");
    if (open){ open.classList.remove("open"); open.setAttribute("aria-hidden","true"); }
    return;
  }
  const ae = document.activeElement;
  const typing = ae && (/^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName) || ae.isContentEditable || ae.getAttribute?.("role")==="slider");
  if (typing) return;
  if (document.querySelector(".modal.open")) return;
  const views = { "1":"amp","2":"presets","3":"cloud","4":"tuner","5":"monitor","6":"settings" };
  if (views[e.key]){ e.preventDefault(); switchView(views[e.key]); return; }
  if ($("#view-amp")?.classList.contains("active")){
    if (e.key==="ArrowLeft"){ e.preventDefault(); setPresetNumber(state.editSlot, true); }
    else if (e.key==="ArrowRight"){ e.preventDefault(); setPresetNumber(state.editSlot+2, true); }
  }
});

/* ---------------- settings UI ---------------- */
const CC_LABELS = { gain:"Gain",bass:"Bass",middle:"Middle",treble:"Treble",volume:"Volume",
  prefx_on:"Pre FX on",prefx_type:"Pre FX type",prefx_p1:"Pre FX P1",prefx_p2:"Pre FX P2",prefx_p3:"Pre FX P3",prefx_p4:"Pre FX P4",
  amp_on:"Amp on",amp_type:"Amp type",gate:"Gate threshold",mod_on:"Mod on",mod_type:"Mod type",mod_p1:"Mod P1",mod_p2:"Mod P2",mod_p3:"Mod P3",mod_p4:"Mod P4",
  delay_on:"Delay on",delay_type:"Delay type",delay_msb:"Delay MSB",delay_lsb:"Delay LSB",delay_p2:"Delay P2",delay_p3:"Delay P3",delay_p4:"Delay P4",
  rev_on:"Reverb on",rev_type:"Reverb type",rev_p1:"Rev P1",rev_p2:"Rev P2",rev_p3:"Rev P3",rev_p4:"Rev P4",
  power_on:"Power on",power_type:"Power type",cab_on:"Cab on",cab_type:"Cab type",presence:"Presence",resonance:"Resonance" };
const CC_GROUPS = [
  ["Panel tone", ["gain","bass","middle","treble","volume"]],
  ["Pre FX", ["prefx_on","prefx_type","prefx_p1","prefx_p2","prefx_p3","prefx_p4"]],
  ["Amplifier", ["amp_on","amp_type","gate"]],
  ["Modulation", ["mod_on","mod_type","mod_p1","mod_p2","mod_p3","mod_p4"]],
  ["Delay", ["delay_on","delay_type","delay_msb","delay_lsb","delay_p2","delay_p3","delay_p4"]],
  ["Reverb", ["rev_on","rev_type","rev_p1","rev_p2","rev_p3","rev_p4"]],
  ["Power & cabinet", ["power_on","power_type","presence","resonance","cab_on","cab_type"]],
];
function renderCCRows(){
  const box = $("#ccMap"); if (!box) return;
  const q = ($("#ccSearch")?.value||"").toLowerCase();
  box.innerHTML = "";
  CC_GROUPS.forEach(([title, keys])=>{
    const vis = keys.filter(k => !q || (CC_LABELS[k]||k).toLowerCase().includes(q) || k.toLowerCase().includes(q));
    if (!vis.length) return;
    const grp = document.createElement("div"); grp.className = "ccmap-group";
    const h = document.createElement("div"); h.className = "ccmap-group-title"; h.textContent = title; grp.appendChild(h);
    const grid = document.createElement("div"); grid.className = "ccmap";
    vis.forEach(k=>{
      const changed = state.cc[k] !== DEFAULT_CC[k];
      const row = document.createElement("div");
      row.className = "row" + (changed ? " changed" : "");
      row.innerHTML = `<span>${CC_LABELS[k]||k}</span><input inputmode="numeric" value="${state.cc[k]??""}" data-k="${k}" aria-label="${CC_LABELS[k]||k} CC number">`;
      grid.appendChild(row);
    });
    grp.appendChild(grid);
    box.appendChild(grp);
  });
  if (!box.children.length) box.innerHTML = `<p class="muted small">No controls match.</p>`;
}
function onCCChange(e){
  const k = e.target?.dataset?.k; if (!k) return;
  const v = e.target.value.trim();
  if (v===""||isNaN(v)) state.cc[k]=""; else state.cc[k]=clamp(+v,0,127);
  store.set(LS.cc, state.cc);
  const row = e.target.closest(".row"); if (row) row.classList.toggle("changed", state.cc[k] !== DEFAULT_CC[k]);
}
function buildCCMap(){
  const box = $("#ccMap"); if (!box) return;
  renderCCRows();
  // Attach listeners once — buildCCMap() is called again on reset/import.
  if (!box._wired){ box._wired = true; box.addEventListener("change", onCCChange); }
  const s = $("#ccSearch");
  if (s && !s._wired){ s._wired = true; s.addEventListener("input", renderCCRows); }
}

/* ---------------- export / import ---------------- */
function download(name, obj){
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(obj,null,2)],{type:"application/json"}));
  a.download = name; a.click();
}
function readFile(input){ return new Promise((res,rej)=>{ const f=input.files[0]; if(!f) return rej(); const r=new FileReader(); r.onload=()=>res(r.result); r.onerror=rej; r.readAsText(f); }); }

/* ---------------- wiring ---------------- */
function wire(){
  // nav
  $$("[data-view]").forEach(b=>b.addEventListener("click", ()=>switchView(b.dataset.view)));
  $("#navToggle").onclick = ()=>{ const s=$("#sidebar"); s.classList.toggle("open"); $("#navToggle").setAttribute("aria-expanded", s.classList.contains("open")); };

  // connection
  $("#btnConnect").onclick = ()=>{ if(!access) initMIDI(); else bind(); toast("Rescanning MIDI…"); };
  $("#refresh").onclick = ()=>access && bind();
  $("#btnRescan2").onclick = ()=>access && bind();
  $("#out").onchange = pick; $("#inp").onchange = pick;
  $("#out2").onchange = ()=>{ $("#out").value=$("#out2").value; pick(); };
  $("#inp2").onchange = ()=>{ $("#inp").value=$("#inp2").value; pick(); };
  $("#optSysex").onchange = ()=>{ state.settings.sysex = $("#optSysex").checked; persistSettings(); location.reload(); };
  $("#optThru").onchange = ()=>{ state.settings.thru = $("#optThru").checked; persistSettings(); };
  $("#optSysex").checked = !!state.settings.sysex; $("#optThru").checked = !!state.settings.thru;
  buildChannelSelects();

  // preset strip (editSlot is 0-based; setPresetNumber takes 1-based n and wraps)
  $("#pPrev").onclick = ()=>setPresetNumber(state.editSlot, true);     // current-1
  $("#pNext").onclick = ()=>setPresetNumber(state.editSlot+2, true);   // current+1
  $("#pName").onchange = ()=>{
    let v = ($("#pName").value||"").trim().toUpperCase().slice(0,18) || DEFAULT_PRESET_NAME(state.editSlot);
    $("#pName").value = v;
    if (v === state.edit.name) return;
    const slot = state.editSlot;
    state.edit.name = v; commitEditorToSlot(); renderPresetGrid();
    if (syncNameToAmp(slot, v)) toast("Renamed to "+v+" — updating the amp…","ok");
  };
  $("#pRename").onclick = openRename;
  $("#pSaveLocal").onclick = ()=>{ commitEditorToSlot(); renderPresetGrid(); toast("Saved to slot "+pnum(state.editSlot),"ok"); };
  $("#pStoreAmp").onclick = ()=>{ commitEditorToSlot(); sysexSetPreset(state.editSlot, state.presets[state.editSlot]); toast("Stored to amp slot "+pnum(state.editSlot),"ok"); };
  $("#ampRecall").onclick = readAmpState;
  $("#ampSaveAmp").onclick = ()=>{ sysexSetCurrent(state.edit); toast("Sent current settings to amp"); };

  $("#renameGo").onclick = ()=>{
    const v = ($("#renameInput").value||"").trim().toUpperCase().slice(0,18);
    if (!v) return toast("Name cannot be empty","err");
    const slot = state.editSlot;
    state.edit.name = v; commitEditorToSlot();
    $("#pName").value = v; renderPresetGrid();
    closeModal("#modalRename");
    if (syncNameToAmp(slot, v)) toast("Renamed to "+v+" — updating the amp…","ok");
    else toast("Renamed to "+v,"ok");
  };

  // presets view
  $("#presetSearch").oninput = renderPresetGrid;
  $("#presetFilter").onchange = renderPresetGrid;
  $("#presetSort").onchange = renderPresetGrid;
  $("#chainExpand").onclick = ()=>$$("#chain .block").forEach(b=>b.classList.add("open"));
  $("#chainCollapse").onclick = ()=>$$("#chain .block").forEach(b=>b.classList.remove("open"));
  $("#btnSeedFactory").onclick = ()=>seedFactoryNames();
  $("#btnExportPresets").onclick = ()=>download("code25-presets.json", state.presets);
  $("#btnImportPresets").onclick = ()=>$("#filePresets").click();
  $("#filePresets").onchange = async ()=>{ try{ const arr=JSON.parse(await readFile($("#filePresets"))); if(Array.isArray(arr)){ for(let i=0;i<NUM_PRESETS;i++) state.presets[i]=Object.assign(blankPreset(i), arr[i]||{}); savePresets(); renderPresetGrid(); loadIntoEditor(state.presets[state.editSlot]); toast("Imported ","ok"); } }catch(e){ toast("Import failed","err"); } };

  // cloud
  $("#cloudTabs").onclick = e=>{ const b=e.target.closest(".subtab"); if(!b) return; $$(".subtab").forEach(x=>x.classList.toggle("active",x===b)); state.cloud.type=b.dataset.type; cloudLoad(true); };
  $("#cloudSearch").oninput = debounce(()=>{ state.cloud.search=$("#cloudSearch").value.trim(); cloudLoad(true); },350);
  $("#cloudClear").onclick = ()=>{ $("#cloudSearch").value=""; state.cloud.search=""; cloudLoad(true); };
  $("#cloudSort").onchange = ()=>{ state.cloud.sort=$("#cloudSort").value; cloudLoad(true); };
  $("#cloudMore").onclick = ()=>cloudLoad(false);
  $("#btnCloudLogin").onclick = ()=>{ if(state.login.ok) doLogout(); else openModal("#modalLogin"); };
  $("#loginGo").onclick = doLogin;
  $("#btnCloudSync").onclick = ()=>{ cloudCheck().then(()=>{ cloudLoad(true); toast("Refreshed cloud"); }); };

  // tuner / monitor
  $("#btnTuner").onclick = ()=>switchView("tuner");
  $("#tunerToggle").onclick = toggleTuner;
  const monFmt = $("#monFormat");
  if (monFmt) monFmt.addEventListener("click", e=>{
    const b=e.target.closest("button"); if(!b) return;
    monHex = b.dataset.fmt==="hex";
    monFmt.querySelectorAll("button").forEach(x=>x.classList.toggle("on", x===b));
    renderMonitor();
  });
  $("#monClear").onclick = ()=>{ monBuf.length=0; monCount.in=monCount.out=monCount.sys=monCount.err=0; renderMonitor(); };
  $("#monPause").onclick = ()=>{ monPaused=!monPaused; if(!monPaused) renderMonitor(); else updateMonStats(); };
  $("#monFilter").oninput = ()=>renderMonitor();
  const monDirEl = $("#monDir");
  if (monDirEl) monDirEl.addEventListener("click", e=>{
    const b=e.target.closest("button"); if(!b) return;
    monDir = b.dataset.dir||"all";
    monDirEl.querySelectorAll("button").forEach(x=>x.classList.toggle("on", x===b));
    renderMonitor();
  });
  const monAutoEl = $("#monAuto");
  if (monAutoEl) monAutoEl.onchange = ()=>{ monAuto = monAutoEl.checked; if (monAuto) renderMonitor(); };

  // settings data
  $("#btnResetCC").onclick = ()=>{ state.cc=Object.assign({},DEFAULT_CC); store.set(LS.cc,state.cc); buildCCMap(); toast("CC map reset"); };
  $("#btnExportAll").onclick = ()=>download("code25-backup.json", { presets:state.presets, cc:state.cc, settings:state.settings, favs:state.favs });
  $("#btnImportAll").onclick = ()=>$("#fileAll").click();
  $("#fileAll").onchange = async ()=>{ try{ const j=JSON.parse(await readFile($("#fileAll"))); if(j.presets) {state.presets=j.presets; savePresets();} if(j.cc){state.cc=Object.assign({},DEFAULT_CC,j.cc); store.set(LS.cc,state.cc);} if(j.settings){state.settings=Object.assign(state.settings,j.settings); persistSettings();} if(j.favs){state.favs=j.favs; store.set(LS.favs,state.favs);} buildCCMap(); renderPresetGrid(); loadIntoEditor(state.presets[state.editSlot]); toast("Backup imported","ok"); }catch(e){ toast("Import failed","err"); } };
  $("#btnClearAll").onclick = ()=>{ if(confirm("Clear presets, mappings and settings in this browser?")){ Object.values(LS).forEach(k=>store.del(k)); location.reload(); } };
}

function debounce(fn,ms){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a),ms); }; }

async function seedFactoryNames({silent=false}={}){
  if (!silent) toast("Fetching factory preset names from Marshall…");
  const names=[];
  try{
    for (let page=1; page<=12 && names.length<NUM_PRESETS; page++){
      const html = await (await cloudFetch(`/Presets/GetPresets?page=${page}&type=Official&searchTerm=&sortOrder=Oldest`)).text();
      const items = parsePresetList(html);
      if (!items.length) break;
      items.forEach(i=>{ if (i.name) names.push(i.name); });
    }
  }catch(e){ if(!silent) toast("Cloud unavailable — start the proxy","err"); return 0; }
  if (!names.length){ if(!silent) toast("No factory names returned","err"); return 0; }
  let seeded = 0;
  names.slice(0,NUM_PRESETS).forEach((nm,i)=>{
    if (nm && /^PRESET \d+$/.test(state.presets[i].name)){
      state.presets[i].name = nm.toUpperCase().slice(0,18); seeded++;
    }
  });
  store.set(LS.seed, true);
  savePresets(); renderPresetGrid();
  if (!silent) toast("Seeded "+seeded+" names","ok");
  return seeded;
}

/* Fill the library with real factory names the first time the proxy is online.
   Runs once (tracked in storage) so manual renames are never overwritten later. */
function maybeSeedFactoryNames(){
  if (store.get(LS.seed, false)) return;
  if (!state.cloud.online) return;
  seedFactoryNames({silent:true});
}

/* cloud intro is set inside cloudLoad() */

/* ---------------- boot ---------------- */
function boot(){
  loadPresets();
  state.edit = JSON.parse(JSON.stringify(state.presets[0])); // build UI before first load
  $("#loginEmail").value = state.login.email || "";
  $("#cloudIntro").textContent = "Official presets crafted by Marshall's in-house guitarists.";
  buildPanel();
  buildChain();
  buildCCMap();
  wire();
  loadIntoEditor(state.presets[0]);
  initMIDI();
  cloudCheck().then(maybeSeedFactoryNames);
  const startView = viewFromHash();
  if (startView!=="amp") switchView(startView);
  window.addEventListener("hashchange", ()=>switchView(viewFromHash()));
  logLine("sys","Gateway Web ready. Open Cloud and run the proxy to browse Marshall presets.");
}
document.addEventListener("DOMContentLoaded", boot);

/* ---------------- public scripting API ----------------
   Handy for the console, for automation, and for integrations:
     GW.state            – live application state
     GW.sendCC(key,val)  – send a mapped control change
     GW.sendPC(n)        – send a program change (0-based)
     GW.sysex([...])     – send a raw SysEx message
     GW.encodePreset(p)  – preset object -> 62-byte SysEx payload
     GW.decodePreset(b)  – 62-byte payload -> preset object
     GW.setPresetNumber(n, send) / GW.switchView(name) */
window.GW = {
  state, send, sendCC, sendPC, sysex, sendDelayTime,
  encodePreset, decodePreset, sysexSetPreset, sysexRecallPreset,
  sysexSetCurrent, sysexRecallCurrent,
  setPresetNumber, switchView, loadIntoEditor, loadIntoEditorQuiet,
  cloudLoad, cloudCheck, cloudToLocal, parsePresetDetail, parsePresetList,
  toggleFav, blankPreset, handleIncomingCC, openCloudPreset, openModal, closeModal,
  openRename, renderCloudFavs, syncNameToAmp, applyNameSync,
  logLine, renderMonitor, describeBytes, hexToBytes, monBuf, monCount
};
