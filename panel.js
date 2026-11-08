// Renders the dashboard as an 8-bit grayscale PNG for the Kindle Scribe (1860x2480).
// Apple-style widget grid: clock + weather, 5-day forecast, spend by period, usage heatmap,
// week bars, today breakdown, War Plan to-dos and T3 agents.
const path = require("node:path");
const { createCanvas, GlobalFonts, Image } = require("@napi-rs/canvas");

const W = Number(process.env.PANEL_W || 1860);
const H = Number(process.env.PANEL_H || 2480);
const M = 60;    // outer margin
const GAP = 30;  // gap between widgets
const R = 48;    // widget corner radius
const P = 44;    // widget padding
const CITY = process.env.WEATHER_CITY || "Auckland";
const MAX_AGENTS = 4;   // agents shown (2 columns x 2 rows)
const AGENT_COLS = 1;
const AGENT_ROW = 108;

// ---------- fonts ----------
const INTER = path.dirname(require.resolve("inter-ui/package.json"));
const reg = (file, family) => GlobalFonts.registerFromPath(path.join(INTER, file), family);
reg("web/Inter-Regular.woff2", "Inter");
reg("web/Inter-Medium.woff2", "Inter Medium");
reg("web/Inter-SemiBold.woff2", "Inter Semi");
reg("web/Inter-Bold.woff2", "Inter Bold");
reg("web/Inter-Light.woff2", "Inter Light");
GlobalFonts.registerFromPath("C:/Windows/Fonts/msyh.ttc", "CJK"); // fallback for Chinese text
const font = (size, face = "Inter") => `${size}px "${face}", "CJK"`;

// ---------- palette (grayscale e-ink) ----------
// E-ink washes out mid-greys, so text is black unless it's genuinely skippable (LABEL3).
const INK = "#000", LABEL2 = "#000", LABEL3 = "#4a4a4a", CARD = "#efefef", FILL = "#d4d4d4", SEP = "#c8c8c8", PAPER = "#fff";
const HEAT = ["#dcdcdc", "#b4b4b4", "#878787", "#4f4f4f", "#000000"];

// ---------- formatting ----------
const dur = (ms) => {
  if (ms == null || ms < 0) return "";
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${String(m % 60).padStart(2, "0")}m`.replace(/ 00m$/, "") : `${Math.floor(h / 24)}d`;
};
const fmtTokens = (n) => n >= 1e9 ? `${(n / 1e9).toFixed(n >= 1e10 ? 1 : 2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}K` : String(Math.round(n));
const fmtCost = (n) => n >= 1000 ? `$${Math.round(n).toLocaleString("en-US")}` : n >= 100 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`;
const fmtCost0 = (n) => `$${Math.round(n).toLocaleString("en-US")}`;
const dayName = (date, style) => new Date(date + "T12:00:00").toLocaleDateString("en-GB", { weekday: style });
const prettyModel = (m) => (m || "")
  .replace(/^claude-(opus|sonnet|haiku|fable)-(\d+)-(\d+).*$/i, (_, f, a, b) => `${f[0].toUpperCase()}${f.slice(1)} ${a}.${b}`)
  .replace(/ · .*$/, "");
const STATE = { needs_you: "Input", done: "Done", failed: "Failed", stopped: "Stopped", working: "Running", waiting: "Waiting" };
const NEEDS_YOU = new Set(["needs_you", "done", "failed", "stopped"]); // black pill: you have to look at it

// ---------- text helpers ----------
function wrap(ctx, str, maxW, maxLines) {
  const words = str.split(/(\s+)/);
  const lines = [];
  let line = "";
  for (const w of words) {
    const test = line + w;
    if (ctx.measureText(test).width <= maxW || !line) line = test;
    else { lines.push(line.trim()); line = w.trimStart(); }
    while (ctx.measureText(line).width > maxW) {
      let i = line.length;
      while (i > 1 && ctx.measureText(line.slice(0, i)).width > maxW) i--;
      lines.push(line.slice(0, i)); line = line.slice(i);
    }
  }
  if (line.trim()) lines.push(line.trim());
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    let last = kept[maxLines - 1];
    while (last && ctx.measureText(last + "…").width > maxW) last = last.slice(0, -1);
    kept[maxLines - 1] = last.trimEnd() + "…";
    return kept;
  }
  return lines;
}
// Apple-style tracking: big text gets tighter letter spacing.
const tracking = (size) => (size >= 100 ? `${-size * 0.04}px` : size >= 56 ? `${-size * 0.02}px` : "0px");
function setFont(ctx, size, face) { ctx.font = font(size, face); ctx.letterSpacing = tracking(size); }
function text(ctx, s, x, y, size, face = "Inter", color = INK, align = "left") {
  setFont(ctx, size, face); ctx.fillStyle = color; ctx.textAlign = align;
  ctx.fillText(s, x, y);
  const w = ctx.measureText(s).width;
  ctx.letterSpacing = "0px";
  return w;
}
function measure(ctx, s, size, face = "Inter") { setFont(ctx, size, face); const w = ctx.measureText(s).width; ctx.letterSpacing = "0px"; return w; }
function fit(ctx, s, size, face, maxW) { setFont(ctx, size, face); const l = wrap(ctx, s, maxW, 1)[0] || ""; ctx.letterSpacing = "0px"; return l; }

// ---------- shapes ----------
function rrect(ctx, x, y, w, h, r, fill) {
  ctx.beginPath(); ctx.roundRect(x, y, w, h, Math.min(r, h / 2, w / 2)); ctx.fillStyle = fill; ctx.fill();
}
function widget(ctx, x, y, w, h) { rrect(ctx, x, y, w, h, R, CARD); }
function header(ctx, x, y, w, label, glyph, right) {
  ctx.save(); ctx.strokeStyle = LABEL2; ctx.fillStyle = LABEL2; ctx.lineWidth = 5; ctx.lineCap = "round"; ctx.lineJoin = "round";
  glyph(ctx, x + P + 16, y + P + 18, 16);
  ctx.restore();
  text(ctx, label, x + P + 46, y + P + 30, 38, "Inter Bold", LABEL2);
  if (right) text(ctx, right, x + w - P, y + P + 30, 34, "Inter Semi", LABEL3, "right");
}
// App icons: T3 Code (from its install bundle) and War Plan (from CT_Study), saved as PNGs in assets/.
// Images decode asynchronously; `ready` resolves once every icon is usable (await it before the first render).
const iconLoads = [];
const loadIcon = (file) => {
  try {
    const img = new Image();
    iconLoads.push(new Promise((resolve) => { img.onload = resolve; img.onerror = resolve; }));
    img.src = require("node:fs").readFileSync(path.join(__dirname, "assets", file));
    return img;
  } catch { return null; }
};
const T3_ICON = loadIcon("t3code.png"), WARPLAN_ICON = loadIcon("warplan.png");
function iconGlyph(img, fallback, rounded) {
  return (ctx, cx, cy, s) => {
    if (!img) return fallback(ctx, cx, cy, s);
    const d = s * 2.4;
    ctx.save();
    if (rounded) { ctx.beginPath(); ctx.roundRect(cx - d / 2, cy - d / 2, d, d, d * 0.24); ctx.clip(); }
    ctx.drawImage(img, cx - d / 2, cy - d / 2, d, d); ctx.restore();
  };
}

const glyphs = {
  t3: (...a) => iconGlyph(T3_ICON, glyphs.sparkle, true)(...a),
  warplan: (...a) => iconGlyph(WARPLAN_ICON, glyphs.check, false)(...a),
  gauge(ctx, cx, cy, s) {
    ctx.beginPath(); ctx.arc(cx, cy + s * 0.3, s, Math.PI, 2 * Math.PI); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx, cy + s * 0.3); ctx.lineTo(cx + s * 0.55, cy - s * 0.35); ctx.stroke();
  },
  location(ctx, cx, cy, s) { ctx.beginPath(); ctx.moveTo(cx + s, cy - s); ctx.lineTo(cx - s, cy - s * 0.1); ctx.lineTo(cx - s * 0.05, cy + s * 0.05); ctx.lineTo(cx + s * 0.1, cy + s); ctx.closePath(); ctx.fill(); },
  sparkle(ctx, cx, cy, s) { ctx.beginPath(); ctx.moveTo(cx, cy - s); ctx.quadraticCurveTo(cx, cy, cx + s, cy); ctx.quadraticCurveTo(cx, cy, cx, cy + s); ctx.quadraticCurveTo(cx, cy, cx - s, cy); ctx.quadraticCurveTo(cx, cy, cx, cy - s); ctx.fill(); },
  rings(ctx, cx, cy, s) { ctx.beginPath(); ctx.arc(cx, cy, s * 0.85, 0, 2 * Math.PI); ctx.stroke(); ctx.beginPath(); ctx.arc(cx, cy, s * 0.35, 0, 2 * Math.PI); ctx.stroke(); },
  chart(ctx, cx, cy, s) { [[-0.8, 0.2], [-0.15, -0.5], [0.5, -0.1]].forEach(([dx, top]) => rrect(ctx, cx + dx * s - 4, cy + top * s, 10, s * (1 - top), 5, LABEL2)); },
  grid(ctx, cx, cy, s) { for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) rrect(ctx, cx - s + i * s * 0.72, cy - s + j * s * 0.72, s * 0.5, s * 0.5, 3, LABEL2); },
  dollar(ctx, cx, cy, s) { ctx.beginPath(); ctx.arc(cx, cy, s * 0.9, 0, 2 * Math.PI); ctx.stroke(); text(ctx, "$", cx, cy + s * 0.45, s * 1.3, "Inter Bold", LABEL2, "center"); },
  check(ctx, cx, cy, s) { rrect(ctx, cx - s, cy - s, 2 * s, 2 * s, s * 0.5, LABEL2); ctx.strokeStyle = CARD; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(cx - s * 0.45, cy); ctx.lineTo(cx - s * 0.1, cy + s * 0.4); ctx.lineTo(cx + s * 0.5, cy - s * 0.35); ctx.stroke(); },
};

// ---------- weather icons ----------
const WMO = (c) =>
  c === 0 ? ["sun", "Clear"] : c <= 2 ? ["partly", c === 1 ? "Mostly Clear" : "Partly Cloudy"] : c === 3 ? ["cloud", "Cloudy"] :
  c <= 48 ? ["fog", "Fog"] : c <= 57 ? ["rain", "Drizzle"] : c <= 67 ? ["rain", "Rain"] : c <= 77 ? ["snow", "Snow"] :
  c <= 82 ? ["rain", "Showers"] : c <= 86 ? ["snow", "Snow Showers"] : ["storm", "Thunderstorms"];
function cloudPath(ctx, cx, cy, s) {
  ctx.beginPath();
  ctx.moveTo(cx - s * 0.62, cy + s * 0.38);
  ctx.arc(cx - s * 0.5, cy + s * 0.08, s * 0.3, Math.PI * 0.6, Math.PI * 1.45);
  ctx.arc(cx - s * 0.05, cy - s * 0.12, s * 0.44, Math.PI * 1.1, Math.PI * 1.9);
  ctx.arc(cx + s * 0.5, cy + s * 0.1, s * 0.3, Math.PI * 1.5, Math.PI * 0.45);
  ctx.closePath();
}
function sun(ctx, cx, cy, s) {
  ctx.beginPath(); ctx.arc(cx, cy, s * 0.36, 0, 2 * Math.PI); ctx.stroke();
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * s * 0.58, cy + Math.sin(a) * s * 0.58); ctx.lineTo(cx + Math.cos(a) * s * 0.76, cy + Math.sin(a) * s * 0.76); ctx.stroke();
  }
}
function weatherIcon(ctx, code, cx, cy, s, bg = CARD) {
  const [kind] = WMO(code);
  ctx.save();
  ctx.lineWidth = Math.max(4, s * 0.085); ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = INK;
  if (kind === "sun") sun(ctx, cx, cy, s);
  else if (kind === "partly") { sun(ctx, cx - s * 0.28, cy - s * 0.28, s * 0.8); cloudPath(ctx, cx + s * 0.12, cy + s * 0.18, s * 0.78); ctx.fillStyle = bg; ctx.fill(); ctx.stroke(); }
  else if (kind === "fog") { [-0.35, 0, 0.35].forEach((o, i) => { ctx.beginPath(); ctx.moveTo(cx - s * (0.7 - i * 0.1), cy + o * s); ctx.lineTo(cx + s * (0.7 - (2 - i) * 0.1), cy + o * s); ctx.stroke(); }); }
  else {
    const up = kind === "cloud" ? 0 : s * 0.22;
    cloudPath(ctx, cx, cy - up, s); ctx.fillStyle = bg; ctx.fill(); ctx.stroke();
    if (kind === "rain") for (let i = -1; i <= 1; i++) { ctx.beginPath(); ctx.moveTo(cx + i * s * 0.36, cy + s * 0.4); ctx.lineTo(cx + i * s * 0.36 - s * 0.1, cy + s * 0.68); ctx.stroke(); }
    if (kind === "snow") for (let i = -1; i <= 1; i++) { ctx.beginPath(); ctx.arc(cx + i * s * 0.36, cy + s * 0.56, s * 0.07, 0, 2 * Math.PI); ctx.fillStyle = INK; ctx.fill(); }
    if (kind === "storm") {
      ctx.fillStyle = INK; ctx.beginPath();
      ctx.moveTo(cx + s * 0.08, cy + s * 0.3); ctx.lineTo(cx - s * 0.2, cy + s * 0.62); ctx.lineTo(cx + s * 0.02, cy + s * 0.62);
      ctx.lineTo(cx - s * 0.1, cy + s * 0.92); ctx.lineTo(cx + s * 0.26, cy + s * 0.52); ctx.lineTo(cx + s * 0.04, cy + s * 0.52);
      ctx.closePath(); ctx.fill();
    }
  }
  ctx.restore();
}

// ---------- status marks ----------
function statusIcon(ctx, status, cx, cy, r) {
  ctx.save();
  if (status === "needs_you") {
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI); ctx.fillStyle = INK; ctx.fill();
    text(ctx, "!", cx, cy + r * 0.48, r * 1.35, "Inter Bold", PAPER, "center");
  } else if (status === "working") {
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI); ctx.fillStyle = INK; ctx.fill();
    ctx.fillStyle = PAPER; ctx.strokeStyle = PAPER; ctx.lineJoin = "round"; ctx.lineWidth = r * 0.16;
    ctx.beginPath(); ctx.moveTo(cx - r * 0.22, cy - r * 0.34); ctx.lineTo(cx + r * 0.4, cy); ctx.lineTo(cx - r * 0.22, cy + r * 0.34); ctx.closePath(); ctx.fill(); ctx.stroke();
  } else if (status === "done") {
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI); ctx.fillStyle = INK; ctx.fill();
    ctx.strokeStyle = PAPER; ctx.lineWidth = r * 0.2; ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.beginPath(); ctx.moveTo(cx - r * 0.42, cy); ctx.lineTo(cx - r * 0.1, cy + r * 0.32); ctx.lineTo(cx + r * 0.45, cy - r * 0.3); ctx.stroke();
  } else if (status === "failed") {
    ctx.beginPath(); ctx.arc(cx, cy, r - 3, 0, 2 * Math.PI); ctx.lineWidth = 5; ctx.strokeStyle = INK; ctx.stroke();
    ctx.lineCap = "round"; ctx.beginPath(); ctx.moveTo(cx - r * 0.35, cy - r * 0.35); ctx.lineTo(cx + r * 0.35, cy + r * 0.35); ctx.moveTo(cx + r * 0.35, cy - r * 0.35); ctx.lineTo(cx - r * 0.35, cy + r * 0.35); ctx.stroke();
  } else if (status === "stopped") { // ring with a square: run was stopped/interrupted
    ctx.beginPath(); ctx.arc(cx, cy, r - 3, 0, 2 * Math.PI); ctx.lineWidth = 5; ctx.strokeStyle = INK; ctx.stroke();
    ctx.fillStyle = INK; ctx.fillRect(cx - r * 0.3, cy - r * 0.3, r * 0.6, r * 0.6);
  } else { // waiting: dashed ring
    ctx.setLineDash([7, 6]); ctx.beginPath(); ctx.arc(cx, cy, r - 3, 0, 2 * Math.PI); ctx.lineWidth = 5; ctx.strokeStyle = INK; ctx.stroke();
  }
  ctx.restore();
}

// ---------- sections ----------
// Clock on the left, weather card (now + 5 days) filling the rest of the top row.
// Rain from Open-Meteo's 15-minute data (6 h back, 3 h ahead): "Raining since 09:45", "Rain at 11:45", "No rain for 3h".
const hhmm = (ms) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Pacific/Auckland" });
function rainLine(weather, now) {
  const all = weather?.rain15 || [];
  const cur = all.findIndex((s) => s.at <= now && now < s.at + 15 * 60e3);
  if (cur < 0 || all.length - cur < 4) return null; // forecast too stale to say anything
  const wet = (s) => s.mm >= 0.1;
  if (wet(all[cur])) { // walk back to where this rain started
    let start = cur;
    while (start > 0 && wet(all[start - 1])) start--;
    return { text: start === 0 ? "Raining for 6h+" : `Raining since ${hhmm(all[start].at)}`, soon: true };
  }
  const slots = all.slice(cur);
  const next = slots.find(wet);
  return next ? { text: `Rain at ${hhmm(next.at)}`, soon: true } : { text: "No rain for 3h", soon: false };
}

// media app id -> display name + logo (assets/media-*.png from simple-icons; no logo = ♪)
const APP_NAME = [[/spotify/i, "Spotify", "spotify"], [/chrome/i, "Chrome", "chrome"], [/msedge|edge/i, "Edge"],
  [/firefox|308046B0AF4A39CB/i, "Firefox", "firefox"], [/zunemusic|media ?player/i, "Media Player"],
  [/apple ?music|applemusic/i, "Apple Music", "applemusic"], [/youtube ?music/i, "YouTube Music", "youtubemusic"],
  [/youtube/i, "YouTube", "youtube"], [/vlc/i, "VLC", "vlc"], [/soundcloud/i, "SoundCloud", "soundcloud"],
  [/netflix/i, "Netflix", "netflix"], [/tidal/i, "TIDAL", "tidal"], [/bilibili/i, "bilibili", "bilibili"],
  [/cloudmusic|netease/i, "NetEase Music", "neteasemusic"]];
const MEDIA_LOGO = Object.fromEntries(APP_NAME.filter((a) => a[2]).map(([, , k]) => [k, loadIcon(`media-${k}.png`)]));
const appMatch = (id) => APP_NAME.find(([re]) => re.test(id || ""));
const appName = (id) => appMatch(id)?.[1] || (id || "").split(/[!_]/)[0].replace(/\.exe$/i, "");
const appLogo = (id) => MEDIA_LOGO[appMatch(id)?.[2]] || null;

function battery(ctx, x, y, level, charging) { // outline battery, filled to level; x,y = top-left
  const bw = 54, bh = 28;
  ctx.save(); ctx.lineWidth = 4; ctx.strokeStyle = INK;
  ctx.beginPath(); ctx.roundRect(x + 2, y + 2, bw - 4, bh - 4, 6); ctx.stroke();
  ctx.fillStyle = INK; ctx.fillRect(x + bw + 1, y + 9, 5, bh - 18);
  ctx.fillRect(x + 8, y + 8, Math.max(3, ((bw - 16) * Math.min(100, level)) / 100), bh - 16);
  if (charging) { // bolt cut out of the fill
    ctx.fillStyle = PAPER; ctx.beginPath();
    ctx.moveTo(x + 30, y + 4); ctx.lineTo(x + 20, y + 16); ctx.lineTo(x + 27, y + 16); ctx.lineTo(x + 24, y + 25); ctx.lineTo(x + 34, y + 12); ctx.lineTo(x + 27, y + 12);
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}

// Dotted rounded box: the shared "nothing here" placeholder.
function dotted(ctx, x, y, w, h, r = 22) {
  ctx.save(); ctx.setLineDash([10, 10]); ctx.lineWidth = 3; ctx.strokeStyle = "#a8a8a8";
  ctx.beginPath(); ctx.roundRect(x + 1.5, y + 1.5, w - 3, h - 3, r); ctx.stroke(); ctx.restore();
}

function noteGlyph(ctx, x, y, s) { // ♪ drawn, centred at x,y
  ctx.save(); ctx.fillStyle = INK; ctx.strokeStyle = INK; ctx.lineWidth = s * 0.16;
  ctx.beginPath(); ctx.ellipse(x - s * 0.25, y + s * 0.45, s * 0.3, s * 0.22, -0.4, 0, 2 * Math.PI); ctx.fill();
  ctx.beginPath(); ctx.moveTo(x + s * 0.02, y + s * 0.4); ctx.lineTo(x + s * 0.02, y - s * 0.6); ctx.lineTo(x + s * 0.5, y - s * 0.35); ctx.stroke();
  ctx.restore();
}

// Top strip, packed left to right: time | date, rain, battery | now playing (fills whatever is left).
// Fixed columns so nothing shifts as the time/date/rain text changes length:
// time gets the width of its widest possible value, the date/rain block a fixed width, Now Playing the rest.
// The Kindle's "PC offline" banner is cut to exactly the Now Playing box (see renderOffline).
const TOP_Y = M - 10, TOP_H = 200;
let topCols = null;
function topLayout(ctx) {
  if (topCols) return topCols;
  const timeW = Math.max(...[..."0123456789"].map((d) => measure(ctx, `${d}${d}:${d}${d}`, 210, "Inter Semi")));
  const blockW = Math.max(measure(ctx, "Wednesday 30 Sep", 54, "Inter Bold"), measure(ctx, "Raining since 00:00", 46, "Inter Bold"));
  // whole pixels: the offline banner is a PNG cut to this box, and a fractional width corrupts it
  const sep1 = Math.round(M + timeW + 40), ix = sep1 + 40, sep2 = Math.round(ix + blockW + 40), mx = sep2 + 40;
  topCols = { sep1, ix, blockW, sep2, mx, mw: W - M - mx, boxY: TOP_Y + 18, boxH: TOP_H - 30 };
  return topCols;
}

function drawTop(ctx, y, h, now, { weather, battery: bat, playing } = {}, standalone = false) {
  const t = new Date(now);
  const { sep1, ix, blockW, sep2, mx, mw, boxY, boxH } = topLayout(ctx);
  const sep = (sx) => { ctx.fillStyle = SEP; ctx.fillRect(sx, y + 18, 3, h - 30); };
  if (standalone) { // the Kindle draws time, date and battery itself; Now Playing becomes the offline banner
    sep(sep1); sep(sep2);
    rrect(ctx, mx, boxY, mw, boxH, 28, INK);
    text(ctx, "PC offline", mx + mw / 2, boxY + boxH / 2 + 4, 66, "Inter Bold", PAPER, "center");
    return;
  }
  text(ctx, t.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }), M - 8, y + h - 10, 210, "Inter Semi");

  // info block right next to the time
  sep(sep1);
  const date = t.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short" });
  const rain = rainLine(weather, now);
  text(ctx, fit(ctx, date, 54, "Inter Bold", blockW), ix, y + 62, 54, "Inter Bold", INK);
  if (rain) {
    const face = rain.soon ? "Inter Bold" : "Inter Semi";
    text(ctx, fit(ctx, rain.text, 46, face, blockW), ix, y + 126, 46, face, rain.soon ? INK : LABEL3);
  }
  if (bat) {
    battery(ctx, ix, y + h - 40, bat.level, bat.charging);
    text(ctx, `${Math.round(bat.level)}%${bat.charging ? " · charging" : ""}`, ix + 74, y + h - 14, 38, "Inter Semi", INK);
  } else text(ctx, "Battery …", ix, y + h - 14, 38, "Inter Semi", LABEL3);

  // what the PC is playing, in the remaining width (dotted placeholder when nothing is)
  sep(sep2);
  if (mw < 260) return;
  if (!playing) {
    dotted(ctx, mx, y + 18, mw, h - 30, 28);
    const label = "Nothing playing", lw = measure(ctx, label, 40, "Inter Semi"), cx = mx + mw / 2, cy = y + 18 + (h - 30) / 2;
    noteGlyph(ctx, cx - lw / 2 - 10, cy - 4, 26);
    text(ctx, label, cx + 20, cy + 14, 40, "Inter Semi", LABEL3, "center");
    return;
  }
  const logo = appLogo(playing.app);
  // everything stays inside the box (y+18 .. y+h-12) so the offline banner covers it completely
  if (logo) ctx.drawImage(logo, mx, y + 18, 40, 40); else noteGlyph(ctx, mx + 14, y + 34, 24);
  const src = `${appName(playing.app)}${playing.status && playing.status !== "Playing" ? ` · ${playing.status}` : ""}`;
  text(ctx, fit(ctx, src, 34, "Inter Semi", mw - 56), mx + 54, y + 50, 34, "Inter Semi", INK);
  text(ctx, fit(ctx, playing.title, 54, "Inter Bold", mw), mx, y + 120, 54, "Inter Bold", INK);
  if (playing.artist) text(ctx, fit(ctx, playing.artist, 40, "Inter Semi", mw), mx, y + h - 24, 40, "Inter Semi", INK);
}

// Hierarchy: current temperature first, then each day's high, then low / rain.
function weatherCard(ctx, x, y, w, h, weather) { // now on the left, five days across
  widget(ctx, x, y, w, h);
  if (!weather) { text(ctx, "Weather unavailable", x + w / 2, y + h / 2 + 14, 40, "Inter Semi", LABEL3, "center"); return; }
  const n = weather.now, today = weather.days[0];

  const nowW = 520;
  ctx.fillStyle = INK; glyphs.location(ctx, x + P + 14, y + P + 18, 14);
  text(ctx, CITY, x + P + 42, y + P + 32, 36, "Inter Semi", INK);
  const tw = text(ctx, `${Math.round(n.temp)}°`, x + P - 10, y + P + 236, 200, "Inter Light");
  weatherIcon(ctx, n.code, Math.min(x + P + tw + 70, x + P + nowW - 70), y + P + 130, 62);
  text(ctx, WMO(n.code)[1], x + P, y + h - P - 56, 46, "Inter Semi", INK);
  text(ctx, `H ${Math.round(today?.max ?? n.temp)}°   L ${Math.round(today?.min ?? n.temp)}°`, x + P, y + h - P, 38, "Inter Semi", INK);

  const dx = x + P + nowW, dw = x + w - P - dx;
  const days = weather.days.slice(0, 5), colW = dw / days.length;
  days.forEach((d, i) => {
    const cx = dx + colW * i + colW / 2;
    ctx.fillStyle = SEP; ctx.fillRect(dx + colW * i, y + P, 2, h - 2 * P);
    text(ctx, i === 0 ? "Today" : dayName(d.date, "short"), cx, y + P + 40, 40, i === 0 ? "Inter Bold" : "Inter Semi", INK, "center");
    weatherIcon(ctx, d.code, cx, y + P + 150, 62);
    const hi = `${Math.round(d.max)}°`, lo = `${Math.round(d.min)}°`;
    const hw = measure(ctx, hi, 72, "Inter Semi"), lw = measure(ctx, lo, 40, "Inter Medium"), sx = cx - (hw + 8 + lw) / 2;
    text(ctx, hi, sx, y + h - P - 70, 72, "Inter Semi", INK);
    text(ctx, lo, sx + hw + 8, y + h - P - 70, 40, "Inter Medium", LABEL3);
    text(ctx, `${d.rain ?? 0}%`, cx, y + h - P, 36, "Inter Semi", INK, "center");
  });
}

// One Usage card: spend by period on top, activity heatmap + this week's bars below.
function usageWidget(ctx, x, y, w, h, usage) { // periods stacked on the left, heatmap on the right
  widget(ctx, x, y, w, h);
  if (!usage) { header(ctx, x, y, w, "Usage", glyphs.dollar); text(ctx, "TokeX data unavailable", x + w / 2, y + h / 2, 38, "Inter Semi", LABEL3, "center"); return; }

  const byDate = new Map(usage.history.map((d) => [d.date, d.tokens]));
  const end = new Date(usage.today + "T12:00:00");
  let streak = 0;
  for (let d = new Date(end); byDate.get(d.toLocaleDateString("en-CA")) > 0; d.setDate(d.getDate() - 1)) streak++;
  header(ctx, x, y, w, "Usage", glyphs.dollar, `${streak}-day streak`);

  const rows = [
    ["Today", usage.cost, usage.tokens, fmtCost],
    ["7d", usage.periods.d7.cost, usage.periods.d7.tokens, fmtCost0],
    ["30d", usage.periods.d30.cost, usage.periods.d30.tokens, fmtCost0],
    ["All", usage.periods.all.cost, usage.periods.all.tokens, fmtCost0],
  ];
  const top = y + P + 64, bottom = y + h - P, listW = 440, rowH = (bottom - top) / rows.length;
  rows.forEach(([label, cost, tokens, f], i) => {
    const ry = top + i * rowH, cy = ry + rowH / 2;
    if (i) { ctx.fillStyle = SEP; ctx.fillRect(x + P, ry, listW, 2); }
    text(ctx, label, x + P, cy - 4, 32, "Inter Semi", INK);
    text(ctx, f(cost), x + P, cy + 32, 28, "Inter Semi", LABEL3);
    text(ctx, fmtTokens(tokens), x + P + listW, cy + 22, 62, "Inter Bold", INK, "right");
  });
  const hx = x + P + listW + 50;
  ctx.fillStyle = SEP; ctx.fillRect(hx - 26, top, 2, bottom - top);
  drawHeatmap(ctx, hx, top - 16, x + w - P - hx, bottom - top + 16, usage, byDate);
}

// Models used today: name, token bar, tokens (big) and cost (small).
function drawModels(ctx, x, y, w, h, usage) {
  text(ctx, "Models today", x, y + 26, 34, "Inter Semi", INK);
  const models = usage.byModel.slice().sort((a, b) => b.tokens - a.tokens);
  if (!models.length) { text(ctx, "No usage yet", x, y + 100, 34, "Inter Semi", LABEL3); return; }
  const top = y + 46, rows = Math.max(1, Math.min(models.length, 3, Math.floor((y + h - top) / 64)));
  const rowH = Math.min(84, (y + h - top) / rows); // cap so 1-2 models do not stretch
  const maxTok = Math.max(...models.map((m) => m.tokens), 1);
  models.slice(0, rows).forEach((m, i) => {
    const ry = top + i * rowH;
    if (i) { ctx.fillStyle = SEP; ctx.fillRect(x, ry, w, 2); }
    // one line: name · tokens (big); thin share bar underneath
    text(ctx, fit(ctx, prettyModel(m.model), 32, "Inter Semi", w - 190), x, ry + 40, 32, "Inter Semi");
    text(ctx, fmtTokens(m.tokens), x + w, ry + 46, 46, "Inter Bold", INK, "right");
    rrect(ctx, x, ry + 54, w - 190, 10, 5, FILL);
    rrect(ctx, x, ry + 54, Math.max(10, ((w - 190) * m.tokens) / maxTok), 10, 5, INK);
  });
}

function drawHeatmap(ctx, x, y, w, h, usage, byDate) {
  const vals = usage.history.map((d) => d.tokens).filter((v) => v > 0).sort((a, b) => a - b);
  const q = (p) => vals[Math.min(vals.length - 1, Math.floor(p * vals.length))] || 0;
  const cuts = [q(0.25), q(0.5), q(0.75)];
  const level = (v) => (!v ? 0 : v <= cuts[0] ? 1 : v <= cuts[1] ? 2 : v <= cuts[2] ? 3 : 4);

  const labelW = 56, monthH = 40;
  const since = usage.periods?.all?.since ? new Date(usage.periods.all.since + "T12:00:00") : null;
  const weeks = 26; // six months, empty cells before the data starts
  const cell = Math.floor(Math.min((h - monthH) / 7, (w - labelW) / weeks));
  const gap = Math.max(4, Math.round(cell * 0.16)), sz = cell - gap;
  const gridTop = y + monthH + Math.max(0, (h - monthH - 7 * cell) / 2), gx = x + labelW + Math.max(0, (w - labelW - weeks * cell) / 2); // centered
  const end = new Date(usage.today + "T12:00:00");
  const start = new Date(end); start.setDate(end.getDate() - end.getDay() - (weeks - 1) * 7);
  ["Mon", "Wed", "Fri"].forEach((d, i) => text(ctx, d, gx - labelW, gridTop + cell * (1 + i * 2) + sz * 0.7, 24, "Inter Medium", LABEL3));
  let lastMonth = -1;
  for (let wk = 0; wk < weeks; wk++) {
    for (let dow = 0; dow < 7; dow++) {
      const d = new Date(start); d.setDate(start.getDate() + wk * 7 + dow);
      if (d > end) break;
      const key = d.toLocaleDateString("en-CA");
      if (dow === 0 && d.getMonth() !== lastMonth) {
        lastMonth = d.getMonth();
        text(ctx, d.toLocaleDateString("en-GB", { month: "short" }), gx + wk * cell, gridTop - 12, 26, "Inter Semi", INK);
      }
      const lv = level(byDate.get(key));
      rrect(ctx, gx + wk * cell, gridTop + dow * cell, sz, sz, Math.max(3, sz * 0.22), lv ? HEAT[lv] : "#e2e2e2");
    }
  }
}

function drawWeek(ctx, x, y, w, h, usage) {
  const days = usage.days;
  const avg = days.reduce((s, d) => s + d.cost, 0) / Math.max(days.length, 1);
  text(ctx, "This week", x, y + 26, 30, "Inter Semi", INK);
  text(ctx, `avg ${fmtCost0(avg)}`, x + w, y + 26, 28, "Inter Medium", LABEL3, "right");
  const chartTop = y + 90, chartBottom = y + h - 40;
  const slot = w / Math.max(days.length, 1), barW = Math.min(40, slot * 0.55);
  const maxD = Math.max(...days.map((d) => d.cost), 0.01);
  const yOf = (v) => chartBottom - ((chartBottom - chartTop) * v) / maxD;
  days.forEach((d, i) => {
    const bx = x + slot * i + (slot - barW) / 2;
    const isToday = d.date === usage.today;
    const top = Math.min(yOf(d.cost), chartBottom - barW / 2);
    rrect(ctx, bx, top, barW, chartBottom - top, barW / 2, isToday ? INK : "#b0b0b0");
    text(ctx, `${Math.round(d.cost)}`, bx + barW / 2, top - 10, 24, isToday ? "Inter Bold" : "Inter Semi", isToday ? INK : LABEL3, "center");
    text(ctx, dayName(d.date, "narrow"), bx + barW / 2, chartBottom + 34, 26, isToday ? "Inter Bold" : "Inter Medium", isToday ? INK : LABEL3, "center");
  });
  ctx.save(); ctx.setLineDash([8, 8]); ctx.lineWidth = 3; ctx.strokeStyle = LABEL3;
  ctx.beginPath(); ctx.moveTo(x, yOf(avg)); ctx.lineTo(x + w, yOf(avg)); ctx.stroke(); ctx.restore();
}

// Usage limits per provider: 5-hour session and weekly windows, used % and time to reset.
const PROVIDER_NAME = { claude: "Claude", codex: "Codex", opencode: "OpenCode", antigravity: "Antigravity", deepseek: "DeepSeek", cursor: "Cursor" };
const WINDOW_LABEL = { session: "5h", weekly: "Week", monthly: "Month", daily: "Day" };
function untilReset(iso, now) {
  if (!iso) return "";
  const ms = Date.parse(iso) - now;
  if (ms <= 0) return "now";
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  if (m < 24 * 60) return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`.replace(/ 00m$/, "");
  return new Date(iso).toLocaleDateString("en-GB", { weekday: "short" });
}
const PROVIDER_LOGO = { claude: loadIcon("claude.png"), codex: loadIcon("codex.png"), antigravity: loadIcon("antigravity.png") };
const WINDOW_MS = { session: 5 * 3600e3, daily: 864e5, weekly: 7 * 864e5, monthly: 30 * 864e5 };
// Window length for the pace tick: the provider's own windowMinutes when it reports one, else the kind's usual length.
const windowLength = (wd) => (Number(wd?.windowMinutes) > 0 ? wd.windowMinutes * 60000 : WINDOW_MS[wd?.kind] || null);

// Provider name line with its logo; returns the x after the name.
function providerTitle(ctx, provider, x, y) { // logo + name, 40px
  const logo = PROVIDER_LOGO[provider];
  let tx = x;
  if (logo) { ctx.drawImage(logo, x, y - 38, 48, 48); tx = x + 62; }
  return tx + text(ctx, PROVIDER_NAME[provider] || provider, tx, y, 40, "Inter Bold");
}

// One capsule: black fill = remaining %, hatched = used.
// White tick = pace, same as TokeX/T3: the share of the window still to run (time left ÷ window length).
// Fill reaching past the tick = under pace (lasts to the reset); falling short of it = burning too fast.
function capsule(ctx, x, y, w, h, remaining, resetsAt, windowMs, now, showLabel = true) {
  ctx.save();
  ctx.beginPath(); ctx.roundRect(x, y, w, h, h / 2); ctx.clip();
  ctx.fillStyle = "#e4e4e4"; ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = "#b8b8b8"; ctx.lineWidth = 3;
  for (let i = -h; i < w + h; i += 12) { ctx.beginPath(); ctx.moveTo(x + i, y + h); ctx.lineTo(x + i + h, y); ctx.stroke(); }
  // fill: the outer ends stay fully round (from the clip); the edge in the middle is a softly-rounded square
  // (as the fill reaches the round cap its end rounds off too, so a 99% bar doesn't look clipped)
  const fillW = (w * Math.min(100, remaining)) / 100;
  if (remaining > 0) {
    const endR = Math.min(h / 2, Math.max(6, h / 2 - (w - fillW)));
    ctx.fillStyle = INK; ctx.beginPath();
    ctx.roundRect(x, y, Math.max(fillW, endR), h, [0, endR, endR, 0]); ctx.fill();
  }
  if (resetsAt && windowMs) {
    const pace = Math.max(0, Math.min(1, (Date.parse(resetsAt) - now) / windowMs));
    const mx = x + pace * w;
    ctx.fillStyle = INK; ctx.fillRect(mx - 4, y, 8, h);
    ctx.fillStyle = PAPER; ctx.fillRect(mx - 2, y, 4, h);
  }
  ctx.restore();
  if (!showLabel) return;
  // % label, drawn whole: white when it sits fully on the black fill, otherwise black on a light pad
  const fs = Math.round(h * 0.62);
  const label = `${Math.round(remaining)}%`, ty = y + h / 2 + fs * 0.36;
  ctx.save(); ctx.font = font(fs, "Inter Bold"); ctx.textAlign = "center";
  const tw = ctx.measureText(label).width, tx = x + w / 2;
  if (x + fillW >= tx + tw / 2 + 8) { ctx.fillStyle = PAPER; ctx.fillText(label, tx, ty); }
  else {
    rrect(ctx, tx - tw / 2 - 8, y + 5, tw + 16, h - 10, (h - 10) / 2, "#ececec");
    ctx.fillStyle = INK; ctx.fillText(label, tx, ty);
  }
  ctx.restore();
}

// Pace verdict for a window: compare % left with the pace tick (time left ÷ window length).
// Within ±5 points = on pace; more left than the tick = under pace; less = over pace (will run out early).
const PACE_ORDER = { over: 2, on: 1, under: 0 };
function paceStatus(remaining, resetsAt, windowMs, now) {
  const r = Date.parse(resetsAt || "");
  if (!windowMs || !Number.isFinite(r)) return null;
  const tick = 100 * Math.max(0, Math.min(1, (r - now) / windowMs));
  const diff = remaining - tick;
  return Math.abs(diff) <= 5 ? "on" : diff > 0 ? "under" : "over";
}
const worstPace = (list) => list.filter(Boolean).sort((a, b) => PACE_ORDER[b] - PACE_ORDER[a])[0] || null;

// Status pill, right-aligned at (rx, y): over = solid black, on = outlined, under = light grey.
function pacePill(ctx, status, rx, y) {
  if (!status) return;
  const label = `${status} pace`;
  const tw = measure(ctx, label, 30, "Inter Bold"), pw = tw + 36, ph = 48, px = rx - pw;
  if (status === "over") rrect(ctx, px, y, pw, ph, ph / 2, INK);
  else if (status === "under") rrect(ctx, px, y, pw, ph, ph / 2, FILL);
  else { ctx.save(); ctx.beginPath(); ctx.roundRect(px + 2, y + 2, pw - 4, ph - 4, ph / 2); ctx.lineWidth = 4; ctx.strokeStyle = INK; ctx.stroke(); ctx.restore(); }
  text(ctx, label, px + pw / 2, y + 34, 30, "Inter Bold", status === "over" ? PAPER : INK, "center");
}

// Built to be read from across the room: per window a big "% left" number, a thick bar and the reset time.
function limitsWidget(ctx, x, y, w, h, limits, now) {
  widget(ctx, x, y, w, h);
  header(ctx, x, y, w, "Limits · % left", glyphs.gauge);
  if (!limits || !limits.length) { text(ctx, "Limits unavailable", x + w / 2, y + h / 2 + 20, 40, "Inter Semi", LABEL3, "center"); return; }

  const TITLE_H = 58, ROW_H = 64, BAR_H = 26;
  const labelW = 64, numW = 190, resetW = 136;
  const left = (wd) => Math.max(0, 100 - wd.usedPercent);
  const isPooled = (p) => p.perAccount?.length > 1;
  const blockH = (p) => TITLE_H + (isPooled(p) ? 2 : Math.max(1, Math.min(2, p.windows.length))) * ROW_H;

  const top = y + P + 66, bottom = y + h - P + 10;
  const used = limits.reduce((s, p) => s + blockH(p), 0);
  const gap = limits.length > 1 ? Math.max(18, (bottom - top - used) / (limits.length - 1)) : 0;
  let by = top;

  // one window row: "5h" · 75% · bar(s) · 4h 39m
  const row = (ry, label, pct, resetsAt, drawBar) => {
    const cy = ry + ROW_H / 2;
    text(ctx, label, x + P, cy + 12, 32, "Inter Semi", INK);
    text(ctx, `${Math.round(pct)}%`, x + P + labelW + numW - 22, cy + 21, 60, "Inter Bold", INK, "right");
    drawBar(x + P + labelW + numW, cy - BAR_H / 2, w - 2 * P - labelW - numW - resetW - 12);
    text(ctx, untilReset(resetsAt, now), x + w - P, cy + 12, 32, "Inter Semi", INK, "right");
  };

  limits.forEach((p, i) => {
    if (i) { ctx.fillStyle = SEP; ctx.fillRect(x + P, by - gap / 2, w - 2 * P, 2); }
    const nameEnd = providerTitle(ctx, p.provider, x + P, by + 40);

    if (!isPooled(p)) {
      const wins = p.windows.slice(0, 2);
      // pace verdict = the 7-day window only (5h windows swing too fast to plan around)
      const wk = wins.find((wd) => wd.kind === "weekly");
      pacePill(ctx, wk ? paceStatus(left(wk), wk.resetsAt, windowLength(wk), now) : null, x + w - P, by + 6);
      if (!wins.length && p.balanceUsd != null) text(ctx, `${fmtCost(p.balanceUsd)} left`, x + w - P, by + 44, 40, "Inter Bold", INK, "right");
      wins.forEach((wd, j) => row(by + TITLE_H + j * ROW_H, wd.kind === "weekly" ? "7d" : "5h", left(wd), wd.resetsAt,
        (bx, byy, bw) => capsule(ctx, bx, byy, bw, BAR_H, left(wd), wd.resetsAt, windowLength(wd), now, false)));
    } else {
      // Antigravity: big number = average across accounts; bar = one mini capsule per account
      const accts = p.perAccount;
      text(ctx, `×${accts.length}`, nameEnd + 12, by + 40, 28, "Inter Semi", LABEL3);
      const stats = Object.fromEntries(["session", "weekly"].map((k) => {
        const xs = accts.map((a) => a[k]).filter(Boolean);
        const rem = xs.length ? xs.reduce((s, a) => s + a.remaining, 0) / xs.length : 0;
        const resets = xs.map((a) => a.resetsAt).filter(Boolean).sort();
        return [k, { rem, soonest: resets[0] || null, status: paceStatus(rem, resets[0], windowLength({ kind: k }), now) }];
      }));
      pacePill(ctx, stats.weekly.status, x + w - P, by + 6);
      [["session", "5h"], ["weekly", "7d"]].forEach(([k, label], j) =>
        row(by + TITLE_H + j * ROW_H, label, stats[k].rem, stats[k].soonest, (bx, byy, bw) => {
          const g = 10, cw = (bw - g * (accts.length - 1)) / accts.length;
          accts.forEach((a, n) => {
            const win = a[k] || { remaining: 0, resetsAt: null };
            capsule(ctx, bx + n * (cw + g), byy, cw, BAR_H, win.remaining, win.resetsAt, windowLength({ ...win, kind: k }), now, false);
          });
        }));
    }
    by += blockH(p) + gap;
  });
}

function todoWidget(ctx, x, y, w, h, todos) {
  widget(ctx, x, y, w, h);
  header(ctx, x, y, w, "To-Do List", glyphs.warplan);
  if (!todos) { text(ctx, "War Plan unavailable", x + w / 2, y + h / 2, 34, "Inter Medium", LABEL3, "center"); return; }

  // Two columns, filled left-right; finished items are struck through and dimmed; empty slots dotted.
  const cols = 2, colGap = 60, colW = (w - 2 * P - colGap) / cols;
  const listY = y + P + 60, rowsN = Math.max(2, Math.ceil(todos.tasks.length / cols));
  const rowH = (y + h - P + 10 - listY) / rowsN;
  for (let i = todos.tasks.length; i < rowsN * cols; i++)
    dotted(ctx, x + P + (i % cols) * (colW + colGap), listY + Math.floor(i / cols) * rowH + 8, colW, rowH - 16);
  if (!todos.tasks.length) text(ctx, "Nothing scheduled", x + w - P, y + P + 30, 34, "Inter Semi", LABEL3, "right");
  todos.tasks.slice(0, rowsN * cols).forEach((t, i) => {
    const cx = x + P + (i % cols) * (colW + colGap), ry = listY + Math.floor(i / cols) * rowH;
    if (i >= cols) { ctx.fillStyle = SEP; ctx.fillRect(cx, ry, colW, 2); }
    const ty = ry + rowH / 2 + 15;
    const label = fit(ctx, t.title, 56, "Inter Semi", colW);
    const tw = text(ctx, label, cx, ty + 4, 56, "Inter Semi", t.done ? LABEL3 : INK);
    if (t.done) { ctx.fillStyle = LABEL3; ctx.fillRect(cx, ty - 15, tw, 4); }
  });
}

function agentsWidget(ctx, x, y, w, h, agents, now) {
  widget(ctx, x, y, w, h);
  const count = (s) => agents.filter((a) => a.status === s).length;
  const summary = [["needs_you", "input"], ["done", "done"], ["failed", "failed"], ["stopped", "stopped"], ["working", "running"], ["waiting", "waiting"]]
    .filter(([s]) => count(s)).map(([s, l]) => `${count(s)} ${l}`).join("  ·  ");
  header(ctx, x, y, w, "T3 Code", glyphs.t3, summary || "None");

  // two-column grid filled left-to-right, at most MAX_AGENTS (overflow becomes "N more" in the last slot)
  const cols = AGENT_COLS, colGap = cols > 1 ? 56 : 0;
  const colW = (w - 2 * P - colGap) / cols;
  const top = y + P + 70, rowH = Math.max(AGENT_ROW, (y + h - P + 10 - top) / Math.ceil(MAX_AGENTS / cols)); // stretch rows to the card
  const pad = (rowH - AGENT_ROW) / 2; // keeps each agent's content centred in its slot
  const list = agents.length > MAX_AGENTS ? agents.slice(0, MAX_AGENTS - 1) : agents;

  // empty slots: dotted rounded rectangles, so the fixed grid always reads as a grid
  const used = list.length + (list.length < agents.length ? 1 : 0);
  for (let i = used; i < MAX_AGENTS; i++) {
    const sx = x + P + (i % cols) * (colW + colGap), sy = top + Math.floor(i / cols) * rowH;
    dotted(ctx, sx, sy + 10, colW, rowH - 20);
  }
  list.forEach((a, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    const ax = x + P + col * (colW + colGap), ay = top + row * rowH + pad;
    if (row) { ctx.fillStyle = SEP; ctx.fillRect(ax + 64, ay - pad, colW - 64, 2); }
    statusIcon(ctx, a.status, ax + 24, ay + 46, 24);
    const runLabel = dur(a.runMs);
    const stateW = measure(ctx, STATE[a.status] || a.status, 28, "Inter Semi");
    text(ctx, fit(ctx, a.title || "(untitled)", 42, "Inter Semi", colW - 64 - 150), ax + 64, ay + 58, 42, "Inter Semi", INK);
    text(ctx, runLabel, ax + colW, ay + 58, 40, "Inter Bold", INK, "right");
    const meta = [a.provider, prettyModel(a.model)].filter(Boolean).join("  ·  ");
    text(ctx, fit(ctx, meta, 30, "Inter", colW - 64 - stateW - 60), ax + 64, ay + 102, 30, "Inter", INK);
    // state pill
    const pw = stateW + 28, dark = NEEDS_YOU.has(a.status);
    rrect(ctx, ax + colW - pw, ay + 72, pw, 40, 20, dark ? INK : FILL);
    text(ctx, STATE[a.status] || a.status, ax + colW - pw / 2, ay + 101, 28, "Inter Semi", dark ? PAPER : INK, "center");
  });
  if (list.length < agents.length) {
    const i = list.length, col = i % cols, row = Math.floor(i / cols);
    text(ctx, `${agents.length - list.length} more`, x + P + col * (colW + colGap) + 64, top + row * rowH + 70, 36, "Inter Semi", LABEL3);
  }
}

// ---------- layout ----------
// standalone: the frame the Kindle shows when the PC goes away. Last PC data, but the clock strip and the
// weather card are left empty for the Kindle to fill in live (see kindle/kindlepanel.koplugin).
function render({ agents = [], usage = null, weather = null, todos = null, limits = null, battery = null, playing = null, now = Date.now() } = {}, { standalone = false } = {}) {
  const c = createCanvas(W, H);
  const ctx = c.getContext("2d");
  ctx.fillStyle = PAPER; ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = "alphabetic";

  const full = W - 2 * M;
  let y = TOP_Y;
  // clock + Usage on top, T3 Code, Limits · To-Do, Weather at the bottom
  const topH = TOP_H;
  drawTop(ctx, y, topH, now, { weather, battery, playing }, standalone); y += topH + GAP;
  const usageH = 470;
  usageWidget(ctx, M, y, full, usageH, usage); y += usageH + GAP;

  const todoH = 340;
  todoWidget(ctx, M, y, full, todoH, todos); y += todoH + GAP;

  const weatherH = 500, weatherY = H - M - weatherH;
  const rowH = weatherY - GAP - y;
  const limW = Math.round(full * 0.52);
  limitsWidget(ctx, M, y, limW, rowH, limits, now);
  agentsWidget(ctx, M + limW + GAP, y, full - limW - GAP, rowH, agents, now);

  if (standalone) rrect(ctx, M, weatherY, full, weatherH, R, KINDLE_CARD); // the Kindle fills it in
  else weatherCard(ctx, M, weatherY, full, weatherH, weather);

  return grayPng(ctx.getImageData(0, 0, W, H).data, W, H);
}

// The Kindle framebuffer is 8-bit grayscale; eips mangles RGBA PNGs, so encode 8-bit gray ourselves.
function grayPng(rgba, w, h) {
  const zlib = require("node:zlib");
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0, i = 0; y < h; y++) {
    raw[y * (w + 1)] = 0; // filter: none
    for (let x = 0; x < w; x++, i += 4)
      raw[y * (w + 1) + 1 + x] = Math.round(0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 0; // 8-bit, grayscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// resolves once all icons above have decoded
const ready = Promise.all(iconLoads);

// Weather icons for the Kindle's own weather card, one 160x160 PNG per kind, on the grey the Kindle
// clears that card to (fbink's GRAYE, a shade off CARD) so they don't show as boxes.
const ICON_BOX = 160, KINDLE_CARD = "#eeeeee";
function renderIcons() {
  const codes = { sun: 0, partly: 2, cloud: 3, fog: 45, rain: 61, snow: 71, storm: 95 };
  return Object.entries(codes).map(([kind, code]) => {
    const c = createCanvas(ICON_BOX, ICON_BOX), ctx = c.getContext("2d");
    ctx.fillStyle = KINDLE_CARD; ctx.fillRect(0, 0, ICON_BOX, ICON_BOX);
    weatherIcon(ctx, code, ICON_BOX / 2, ICON_BOX / 2, 62, KINDLE_CARD);
    return { kind, png: grayPng(ctx.getImageData(0, 0, ICON_BOX, ICON_BOX).data, ICON_BOX, ICON_BOX) };
  });
}

// Where the Kindle draws its live parts, so they line up with the PC's frame. Written to the Kindle as a Lua table.
function kindleLayout() {
  const { sep1, ix, blockW, sep2, mx, mw, boxY, boxH } = topLayout(createCanvas(10, 10).getContext("2d"));
  const weatherH = 500;
  return {
    W, H, M, P, topY: TOP_Y, topH: TOP_H, sep1, ix, blockW: Math.round(blockW), sep2, mx, mw, boxY, boxH,
    wx: { x: M, y: H - M - weatherH, w: W - 2 * M, h: weatherH, nowW: 520 }, icon: ICON_BOX, city: CITY,
  };
}

module.exports = { render, renderIcons, kindleLayout, ready };
