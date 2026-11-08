// Loop: read T3 agents + TokeX usage + War Plan to-dos + weather -> render PNG -> push to the Kindle over SSH -> draw with eips.
// Usage: node run.js            (loop)
//        node run.js --once     (single push)
//        node run.js --preview  (write preview.png only, no Kindle)
const fs = require("node:fs");
const path = require("node:path");

const os = require("node:os");
const { spawn, execFile } = require("node:child_process");
const { readAgents } = require("./agents");
const { render, renderIcons, kindleLayout, ready } = require("./panel");
const { readUsage, readLimits, readNowPlaying } = require("./extras");
const { readWeather } = require("./weather");
const { readTodos } = require("./warplan");

const HOST = process.env.KINDLE_HOST || "192.168.68.58";
const PORT = process.env.KINDLE_PORT || "2222";
const INTERVAL = Number(process.env.INTERVAL_SEC || 60) * 1000;
// Every push redraws without flashing (GL16 waveform); every FULL_EVERY pushes a flashing
// full GC16 refresh (every 10 min) clears the ghosting that non-flashing updates leave behind.
const FULL_EVERY = Number(process.env.FULL_REFRESH_EVERY || 10);
const SSH = process.env.SSH_BIN || "C:\\Program Files\\Git\\usr\\bin\\ssh.exe";

// KOReader's SSH server is set to "login without password"; feed ssh an empty password.
const ASKPASS = path.join(__dirname, "askpass.sh");
if (!fs.existsSync(ASKPASS)) fs.writeFileSync(ASKPASS, '#!/bin/sh\necho ""\n', { mode: 0o755 });

const BATTERY_CMD = "lipc-get-prop com.lab126.powerd battLevel; lipc-get-prop com.lab126.powerd isCharging";
const parseBattery = (out) => {
  const [lvl, chg] = out.trim().split(/\s+/).map(Number);
  if (Number.isFinite(lvl)) battery = { level: lvl, charging: chg === 1 };
};
const sshArgs = (cmd) => ["-p", PORT, "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=8",
  "-o", "NumberOfPasswordPrompts=1", `root@${HOST}`, cmd];
const sshEnv = { ...process.env, SSH_ASKPASS: ASKPASS, SSH_ASKPASS_REQUIRE: "force", DISPLAY: "x" };

// Each signed-in Windows account runs its own copy; only the session on screen pushes (session-active.ps1 prints 1/0).
const SESSION_PS = path.join(__dirname, "session-active.ps1");
function sessionActive() {
  return new Promise((resolve) => {
    execFile("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SESSION_PS],
      { timeout: 8000, windowsHide: true, encoding: "utf8" }, (err, out) => resolve((out || "").trim() !== "0"));
  });
}

// battery only (used once at startup so the first frame already has it)
function readBattery() {
  return new Promise((resolve) => {
    const p = spawn(SSH, sshArgs(BATTERY_CMD), { env: sshEnv, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("error", () => resolve());
    p.on("close", () => { parseBattery(out); resolve(); });
  });
}

// Copy a file to the Kindle over ssh (stdin -> path). Resolves true on success.
function upload(buf, dest) {
  return new Promise((resolve) => {
    const p = spawn(SSH, sshArgs(`cat > ${dest}`), { env: sshEnv, stdio: ["pipe", "ignore", "ignore"] });
    p.on("error", () => resolve(false));
    p.on("close", (code) => resolve(code === 0));
    p.stdin.on("error", () => {});
    p.stdin.end(buf);
  });
}

// Run a command on the Kindle; resolves its stdout, or null if it failed.
function remote(cmd) {
  return new Promise((resolve) => {
    const p = spawn(SSH, sshArgs(cmd), { env: sshEnv, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("error", () => resolve(null));
    p.on("close", (code) => resolve(code === 0 ? out : null));
  });
}

// The Kindle app (KOReader plugin) is what shows the panel. It draws this PC's frames while they keep coming,
// and its own clock / weather / battery over the last frame once they stop. Installed (refreshed) at startup.
const APP = "/mnt/us/kindlepanel"; // fonts, icons, layout, weather cache
const PLUGIN = "/mnt/us/koreader/plugins/kindlepanel.koplugin";
const toLua = (v) => typeof v === "object"
  ? `{ ${Object.entries(v).map(([k, x]) => `${k} = ${toLua(x)}`).join(", ")} }`
  : typeof v === "string" ? JSON.stringify(v) : String(v);
// layout.lua also tells the Kindle where it is (for its own Open-Meteo weather); rewritten when the PC moves
let place = { name: "Auckland", lat: -36.85, lon: 174.76 }, layoutKey = null;
const placeKey = (p) => `${p.name}|${p.lat}|${p.lon}`;
const layoutLua = () => Buffer.from(`-- written by run.js on the PC\nreturn ${toLua({
  ...kindleLayout(), city: place.name, lat: String(place.lat), lon: String(place.lon), tz: "auto" })}\n`);
async function installApp() {
  if ((await remote(`mkdir -p ${APP}/fonts ${PLUGIN} /mnt/us/documents && ls ${APP}/fonts`)) == null)
    return console.log("app install skipped (Kindle unreachable), will retry on restart");
  const have = new Set((await remote(`ls ${APP}/fonts`) || "").split(/\s+/));
  const kdir = path.join(__dirname, "kindle");
  const files = [
    ...["_meta.lua", "main.lua"].map((f) => [fs.readFileSync(path.join(kdir, "kindlepanel.koplugin", f)), `${PLUGIN}/${f}`]),
    // fonts are big and never change: only the missing ones
    ...fs.readdirSync(path.join(kdir, "fonts")).filter((f) => !have.has(f))
      .map((f) => [fs.readFileSync(path.join(kdir, "fonts", f)), `${APP}/fonts/${f}`]),
    ...renderIcons().map(({ kind, png }) => [png, `${APP}/wx-${kind}.png`]),
    [layoutLua(), `${APP}/layout.lua`],
    [Buffer.from("Tap to open the Kindle Panel. Long-press or swipe the panel to close it.\n"), "/mnt/us/documents/Kindle Panel.kpanel"],
  ];
  let ok = true;
  for (const [buf, dest] of files) ok = (await upload(buf, `'${dest}'`)) && ok;
  if (ok) layoutKey = placeKey(place);
  // the old shell watchdog is replaced by the app
  await remote("pkill -f '[p]anel-watchdog'; rm -f /mnt/us/panel-watchdog.sh /mnt/us/panel-offline.png; true");
  console.log(ok ? "Kindle app installed (restart KOReader once to load a new version)" : "Kindle app install incomplete, will retry on restart");
}

// Written to a temp name first so the Kindle app never reads half a file.
function push(png, full) {
  // Only draw while the panel is open (KOReader running, app's flag set) and the Kindle is awake; otherwise it
  // paints over the normal UI or the sleep screen. The file is still updated so the app shows it when opened/woken.
  // After that, report the battery (next frame).
  const cmd = `cat > /tmp/agents.png.new && mv /tmp/agents.png.new /tmp/agents.png && ` +
    `{ ! [ -e /tmp/kindlepanel.open ] || ! ps | grep -q '[r]eader.lua' || ` +
    `[ "$(lipc-get-prop com.lab126.powerd state)" != active ] || ` +
    `eips ${full ? "-f -w gc16" : "-w gl16"} -g /tmp/agents.png >/dev/null; } && ${BATTERY_CMD}`;
  return new Promise((resolve, reject) => {
    const p = spawn(SSH, sshArgs(cmd), { env: sshEnv, stdio: ["pipe", "pipe", "pipe"] });
    let err = "", out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => {
      parseBattery(out);
      return code === 0 ? resolve() : reject(new Error(err.trim() || `ssh exited ${code}`));
    });
    p.stdin.on("error", () => {}); // connection dropped mid-push: the close handler reports it, loop keeps going
    p.stdin.end(png);
  });
}

let pushes = 0;
let battery = null; // Kindle battery from the last push
let lastTodos = null;

// Each source fails independently so one outage doesn't blank the whole panel.
async function gather() {
  await ready; // icons decoded
  const safe = (fn) => { try { return fn(); } catch (e) { console.error(`  ${fn.name}: ${e.message}`); return null; } };
  return {
    agents: safe(readAgents) || [],
    usage: safe(readUsage),
    // War Plan rewrites its file on save; a read mid-write fails, so keep showing the last good list
    todos: (lastTodos = safe(readTodos) || lastTodos),
    weather: await readWeather(),
    limits: await readLimits(),
    playing: await readNowPlaying(),
    battery,
    now: Date.now(),
  };
}

// The frame the Kindle falls back to when the PC goes away; refreshed every BASE_EVERY pushes.
const BASE_EVERY = 5;
let lastPushAt = 0;
let active = null; // last session state, so the log only notes changes
let installed = false;
async function tick() {
  const inUse = await sessionActive();
  if (inUse !== active) {
    console.log(`${new Date().toLocaleTimeString()}  ${inUse ? "this session is in use: pushing" : "another session is in use: paused"}`);
    if (inUse) lastPushAt = 0; // coming back: someone else drew meanwhile, so flash a full refresh
    active = inUse;
  }
  if (!active) return;
  // only the session in use touches the Kindle, so two accounts never install at once
  if (!installed) { installed = true; await installApp(); await readBattery(); }
  const data = await gather();
  if (data.weather?.place?.name) place = data.weather.place;
  if (layoutKey !== placeKey(place) && await upload(layoutLua(), `${APP}/layout.lua`)) {
    layoutKey = placeKey(place);
    console.log(`Kindle weather location: ${place.name} (${place.lat}, ${place.lon})`);
  }
  const png = render(data);
  // full refresh on the usual cycle, and when coming back after a gap (the Kindle drew its own screen meanwhile)
  const full = pushes % FULL_EVERY === 0 || Date.now() - lastPushAt > 5 * 60e3;
  await push(png, full);
  lastPushAt = Date.now();
  if (pushes % BASE_EVERY === 0)
    await upload(render(data, { standalone: true }), "/tmp/panel-base.png.new && mv /tmp/panel-base.png.new /tmp/panel-base.png");
  pushes++;
  const n = (s) => data.agents.filter((a) => a.status === s).length;
  console.log(`${new Date().toLocaleTimeString()}  pushed${full ? " (full refresh)" : ""}  working ${n("working")}  needs-you ${n("needs_you")}  ` +
    `tokens ${data.usage ? data.usage.tokens : "n/a"}  weather ${data.weather ? "ok" : "n/a"}  ` +
    `battery ${data.battery ? data.battery.level + "%" : "pending"}  playing ${data.playing ? data.playing.title : "-"}`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--preview")) {
    const data = await gather();
    fs.writeFileSync(path.join(__dirname, "preview.png"), render(data));
    fs.writeFileSync(path.join(__dirname, "preview-offline.png"), render(data, { standalone: true }));
    return console.log("wrote preview.png, preview-offline.png");
  }
  // one per account, since every signed-in account runs its own loop from this folder (stop-panel.ps1 reads it)
  fs.writeFileSync(path.join(__dirname, `panel-${os.userInfo().username}.pid`), String(process.pid));
  await ready;
  if (args.includes("--once")) return tick();

  console.log(`Agents panel -> ${HOST}:${PORT} every ${INTERVAL / 1000}s (Ctrl+C to stop)`);
  for (;;) {
    try { await tick(); }
    catch (e) { console.error(`${new Date().toLocaleTimeString()}  push failed: ${e.message.split("\n")[0]}`); }
    await new Promise((r) => setTimeout(r, INTERVAL));
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
