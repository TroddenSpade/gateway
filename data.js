/* ============================================================
   data.js — Marshall CODE engine model
   Transcribed from the official "CODE MIDI PC & CC Specification"
   (CATS-00238-v2.1) and the CODE 25/50 Owner's Manual.
   ============================================================ */

/* ---- Control-change map (chart v2.1) ----
   NOTE: Gain(70) and Treble(73) sit in the sequential panel order
   Gain,Bass,Middle,Treble,Volume but are not printed on the chart;
   they are editable in Settings if your firmware differs. */
const DEFAULT_CC = {
  gain:70, bass:71, middle:72, treble:73, volume:74,
  prefx_on:75, prefx_type:76, prefx_p1:77, prefx_p2:78, prefx_p3:79, prefx_p4:80,
  amp_on:81, amp_type:82, gate:83,
  mod_on:85, mod_type:86, mod_p1:87, mod_p2:89, mod_p3:90, mod_p4:102,
  delay_on:103, delay_type:104, delay_msb:31, delay_lsb:63, delay_p2:105, delay_p3:106, delay_p4:107,
  rev_on:108, rev_type:109, rev_p1:110, rev_p2:111, rev_p3:112, rev_p4:113,
  power_on:114, power_type:115,
  cab_on:116, cab_type:117,
  presence:67, resonance:66,
  // Master volume: not printed on the CODE chart (the amp's master is global),
  // but CC 7 is the standard MIDI Master/Channel Volume and is what most CODE
  // firmware listens on. Editable in Settings if your firmware differs.
  master:7
};

/* ---- SysEx framing ----
   The published CODE chart labels 0x72 as "Access Current Settings" and 0x73 as
   "Access Preset", but shipping firmware (and every working editor — the Java
   MarshallCodeAmpInterface, marshallcode.tools and the CodeEditor app) is the
   other way round: 0x72 addresses a numbered preset slot, 0x73 the live/current
   settings. We follow the hardware, not the chart's labels. */
const SYSEX = {
  header:[0x00,0x21,0x15,0x7F,0x7F,0x7F], // MMA + Marshall global ID
  accessCurrent:0x73,
  accessPreset:0x72,
  set:0x02,
  recall:0x01,
  returned:0x03
};

/* ---- Amp (preamp) models, type value 0..14 ---- */
const AMP_MODELS = [
  {v:0,  name:"JTM45",             group:"Clean"},
  {v:1,  name:"CL DSL",            group:"Clean"},
  {v:2,  name:"CL American",       group:"Clean"},
  {v:3,  name:"CL JVM",            group:"Clean"},
  {v:4,  name:"Acoustic",          group:"Clean"},
  {v:5,  name:"Bluesbreaker",      group:"Crunch"},
  {v:6,  name:"Plexi",             group:"Crunch"},
  {v:7,  name:"CR American",       group:"Crunch"},
  {v:8,  name:"JCM800",            group:"Crunch"},
  {v:9,  name:"'50s British",      group:"Crunch"},
  {v:10, name:"OD JVM",            group:"Overdrive"},
  {v:11, name:"OD DSL",            group:"Overdrive"},
  {v:12, name:"OD American",       group:"Overdrive"},
  {v:13, name:"OD Silver Jubilee", group:"Overdrive"},
  {v:14, name:"Natural",           group:"Natural"}
];

/* ---- Power-amp models, type 0..3 ---- */
const POWER_MODELS = [
  {v:0, name:"Classic Marshall",  note:"Class A/B 100W · EL34"},
  {v:1, name:"Vintage Marshall",  note:"Class A/B 30W · 5881"},
  {v:2, name:"British Class A",   note:"Class A 30W · EL84"},
  {v:3, name:"American Class A/B",note:"Class A/B 100W · 6L6"}
];

/* ---- Speaker cabinets, type 0..7 ---- */
const CAB_MODELS = [
  {v:0, name:"1936",  note:"2×12 · G12-T75"},
  {v:1, name:"1936A", note:"2×12 · V30"},
  {v:2, name:"1912",  note:"1×12 · G12-B150"},
  {v:3, name:"1974CX",note:"1×12 · G12M-20"},
  {v:4, name:"1960",  note:"4×12 · G12-T75"},
  {v:5, name:"1960V", note:"4×12 · Vintage 30"},
  {v:6, name:"1960X", note:"4×12 · G12M-25"},
  {v:7, name:"1960AHW",note:"4×12 · G12H-30"}
];

/* ---- Signal-chain sections ----
   Each param: { n:label, cc:controlChange|null, min,max, options?, offset?, unit?, enum? }
   offset: display = raw + offset  (raw sent = display - offset) */
const CHAIN = [
  {
    key:"prefx", name:"Pre FX", icon:"⚡", accent:"#c07a3a", kind:"pedal",
    sub:"Stompbox — compressor, distortion, auto-wah, pitch shifter",
    stateCC:"prefx_on", typeCC:"prefx_type",
    models:[
      { name:"Distortion", params:[
        {id:"p1", n:"Mode", cc:"prefx_p1", options:["GUV","ODR","DIS"]},
        {id:"p2", n:"Drive", cc:"prefx_p2"}, {id:"p3", n:"Tone", cc:"prefx_p3"}, {id:"p4", n:"Level", cc:"prefx_p4"}
      ]},
      { name:"Auto Wah", params:[
        {id:"p1", n:"Mode", cc:"prefx_p1", options:["ENV","LFO"]},
        {id:"p2", n:"Frequency", cc:"prefx_p2"}, {id:"p3", n:"Sensitivity", cc:"prefx_p3"}, {id:"p4", n:"Resonance", cc:"prefx_p4"}
      ]},
      { name:"Pitch Shifter", params:[
        {id:"p1", n:"Semitone", cc:"prefx_p1", min:0, max:24, offset:-12, unit:"st"},
        {id:"p2", n:"Fine Tune", cc:"prefx_p2", offset:-50, unit:"c"}, {id:"p3", n:"Regeneration", cc:"prefx_p3"}, {id:"p4", n:"Mix", cc:"prefx_p4"}
      ]},
      { name:"Compressor", params:[
        {id:"p1", n:"Tone", cc:"prefx_p1"}, {id:"p2", n:"Ratio", cc:"prefx_p2"}, {id:"p3", n:"Compression", cc:"prefx_p3"}, {id:"p4", n:"Level", cc:"prefx_p4"}
      ]}
    ]
  },
  {
    key:"amp", name:"Amp", icon:"🔊", accent:"#caa24b", kind:"amp",
    sub:"MST preamp model · noise gate",
    stateCC:"amp_on", typeCC:"amp_type",
    models: AMP_MODELS.map(m => ({ name:m.name, group:m.group, params:[
      {id:"gate", n:"Gate", cc:"gate", unit:""}
    ]})),
    groupBy:"group"
  },
  {
    key:"mod", name:"Modulation", icon:"〰️", accent:"#4d8f8f", kind:"mod",
    sub:"Chorus · flanger · phaser · tremolo",
    stateCC:"mod_on", typeCC:"mod_type",
    models:[
      { name:"Chorus",   params:[
        {id:"p1", n:"Mode", cc:"mod_p1", options:["CLS","VIB"]},
        {id:"p2", n:"Speed", cc:"mod_p2"}, {id:"p3", n:"Depth", cc:"mod_p3"}, {id:"p4", n:"Tone", cc:"mod_p4"}
      ]},
      { name:"Flanger",  params:[
        {id:"p1", n:"Mode", cc:"mod_p1", options:["JET","MET"]},
        {id:"p2", n:"Speed", cc:"mod_p2"}, {id:"p3", n:"Depth", cc:"mod_p3"}, {id:"p4", n:"Regeneration", cc:"mod_p4"}
      ]},
      { name:"Phaser",   params:[
        {id:"p1", n:"Mode", cc:"mod_p1", options:["CLS","VBE"]},
        {id:"p2", n:"Speed", cc:"mod_p2"}, {id:"p3", n:"Depth", cc:"mod_p3"}, {id:"p4", n:"Regeneration", cc:"mod_p4"}
      ]},
      { name:"Tremolo",  params:[
        {id:"p1", n:"Mode", cc:"mod_p1", options:["VLV","SQR"]},
        {id:"p2", n:"Speed", cc:"mod_p2"}, {id:"p3", n:"Depth", cc:"mod_p3"},
        {id:"p4", n:"Skew", cc:"mod_p4", offset:-50}
      ]}
    ]
  },
  {
    key:"delay", name:"Delay", icon:"↺", accent:"#5b8dd6", kind:"delay",
    sub:"Studio · vintage · multi · reverse",
    stateCC:"delay_on", typeCC:"delay_type",
    models:[
      { name:"Studio",  params:[
        {id:"time", n:"Time", special:"delayTime", min:0, max:4000, unit:"ms"},
        {id:"p2", n:"Feedback", cc:"delay_p2"}, {id:"p3", n:"Frequency", cc:"delay_p3"}, {id:"p4", n:"Level", cc:"delay_p4"}
      ]},
      { name:"Vintage", params:[
        {id:"time", n:"Time", special:"delayTime", min:0, max:4000, unit:"ms"},
        {id:"p2", n:"Feedback", cc:"delay_p2"}, {id:"p3", n:"Age", cc:"delay_p3"}, {id:"p4", n:"Level", cc:"delay_p4"}
      ]},
      { name:"Multi",   params:[
        {id:"time", n:"Time", special:"delayTime", min:0, max:4000, unit:"ms"},
        {id:"p2", n:"Feedback", cc:"delay_p2"},
        {id:"p3", n:"Tap Pattern", cc:"delay_p3", options:["1","2","3","4"]},
        {id:"p4", n:"Level", cc:"delay_p4"}
      ]},
      { name:"Reverse", params:[
        {id:"time", n:"Time", special:"delayTime", min:0, max:4000, unit:"ms"},
        {id:"p2", n:"Feedback", cc:"delay_p2"}, {id:"p3", n:"Frequency", cc:"delay_p3"}, {id:"p4", n:"Mix", cc:"delay_p4"}
      ]}
    ]
  },
  {
    key:"rev", name:"Reverb", icon:"🏟", accent:"#7d6fb0", kind:"reverb",
    sub:"Room · hall · spring · stadium",
    stateCC:"rev_on", typeCC:"rev_type",
    models:["Room","Hall","Spring","Stadium"].map(n => ({ name:n, params:[
      {id:"p1", n:"Decay", cc:"rev_p1"}, {id:"p2", n:"Pre-delay", cc:"rev_p2"}, {id:"p3", n:"Tone", cc:"rev_p3"}, {id:"p4", n:"Level", cc:"rev_p4"}
    ]}))
  },
  {
    key:"power", name:"Power amp", icon:"⏚", accent:"#9a5a3a", kind:"power",
    sub:"MST valve power stage",
    stateCC:"power_on", typeCC:"power_type",
    models: POWER_MODELS.map(m => ({ name:m.name, note:m.note, params:[
      {id:"presence", n:"Presence", cc:"presence", unit:""}, {id:"resonance", n:"Resonance", cc:"resonance", unit:""}
    ]}))
  },
  {
    key:"cab", name:"Cabinet", icon:"▣", accent:"#6a6a6a", kind:"cab",
    sub:"MST speaker cabinet (select only)",
    stateCC:"cab_on", typeCC:"cab_type",
    models: CAB_MODELS.map(m => ({ name:m.name, note:m.note, params:[] }))
  }
];

/* Panel tone controls (stored in the preset, sent via CC) */
const PANEL = [
  {key:"gain",  label:"Gain",   cc:"gain"},
  {key:"bass",  label:"Bass",   cc:"bass"},
  {key:"middle",label:"Middle", cc:"middle"},
  {key:"treble",label:"Treble", cc:"treble"},
  {key:"volume",label:"Volume", cc:"volume"}
];

/* Factory preset slot names — populated from Marshall Cloud when available. */
const DEFAULT_PRESET_NAME = i => "PRESET " + String(i).padStart(2,"0");
const NUM_PRESETS = 100;

/* Storage keys */
const LS = {
  presets:"code25.presets.v2",
  settings:"code25.settings.v2",
  cc:"code25.cc.v2",
  favs:"code25.favs.v2",
  email:"code25.email",
  seed:"code25.seeded.v1"
};

/* Cloud proxy base (see proxy/server.py).
   - Served by the proxy on :8787  -> same origin ("").
   - Opened as a local file       -> talk to the proxy at :8787 (it allows CORS). */
const CLOUD_BASE = (location.port === "8787") ? "" : "http://localhost:8787";
function cloudUrl(path){ return CLOUD_BASE + path; }
/* Marshall returns this many presets per GetPresets page. */
const CLOUD_PAGE_SIZE = 12;
function fixImg(src){
  if (!src) return "";
  if (/^https?:\/\//i.test(src) || src.startsWith("data:")) return src;
  return CLOUD_BASE + (src.startsWith("/") ? src : "/" + src);
}

/* Look-up of models per signal-chain section, used when converting cloud presets. */
const MODELS_BY_SEC = {};
CHAIN.forEach(s => MODELS_BY_SEC[s.key] = s.models);

const CLOUD_INTROS = {
  Official: "Official presets crafted by Marshall's in-house guitarists.",
  Community: "Community presets created by musicians worldwide.",
  My: "Presets you saved from Official, Community or made yourself.",
  Fav: "Presets you starred on this device."
};
