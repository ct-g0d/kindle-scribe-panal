// Loop: read T3 agents + TokeX usage + War Plan to-dos + weather -> render PNG -> push to the Kindle over SSH -> draw with eips.
// Usage: node run.js            (loop)
//        node run.js --once     (single push)
//        node run.js --preview  (write preview.png only, no Kindle)
const fs = require("node:fs");
const path = require("node:path");

const { spawn } = require("node:child_process");
const { readAgents } = require("./agents");
const { render, renderOffline, ready } = require("./panel");
const { readUsage, readWeather, readLimits, readNowPlaying } = require("./extras");
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

// Offline watchdog lives on the Kindle (it has to: the PC can't report its own absence).
// Uploaded once at startup; every push makes sure it's running.
const WATCHDOG = "/mnt/us/panel-watchdog.sh";
// "[p]anel" so pgrep doesn't match this very ssh command line, which contains the name too
const ENSURE_WATCHDOG = `pgrep -f "[p]anel-watchdog" >/dev/null || setsid nohup sh ${WATCHDOG} </dev/null >/dev/null 2>&1 &`;
async function installWatchdog() {
  const banner = renderOffline(); // sized and placed to cover the Now Playing box exactly
  const script = fs.readFileSync(path.join(__dirname, "panel-watchdog.sh"), "utf8")
    .replace("__X__", banner.x).replace("__Y__", banner.y);
  const ok = await upload(Buffer.from(script), WATCHDOG) &&
    await upload(banner.png, "/mnt/us/panel-offline.png");
  if (ok) await upload(Buffer.alloc(0), "/dev/null; pkill -f '[p]anel-watchdog'; true"); // old copy exits; next push starts the new one
  console.log(ok ? "watchdog installed on the Kindle" : "watchdog install skipped (Kindle unreachable), will retry on restart");
}

function push(png, full) {
  // after drawing, report the battery (shown on the next frame)
  const cmd = `cat > /tmp/agents.png && eips ${full ? "-f -w gc16" : "-w gl16"} -g /tmp/agents.png >/dev/null && { ${ENSURE_WATCHDOG} } && ${BATTERY_CMD}`;
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

async function tick() {
  const data = await gather();
  const png = render(data);
  const full = pushes % FULL_EVERY === 0;
  await push(png, full);
  pushes++;
  const n = (s) => data.agents.filter((a) => a.status === s).length;
  console.log(`${new Date().toLocaleTimeString()}  pushed${full ? " (full refresh)" : ""}  working ${n("working")}  needs-you ${n("needs_you")}  ` +
    `tokens ${data.usage ? data.usage.tokens : "n/a"}  weather ${data.weather ? "ok" : "n/a"}  ` +
    `battery ${data.battery ? data.battery.level + "%" : "pending"}  playing ${data.playing ? data.playing.title : "-"}`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--preview")) {
    fs.writeFileSync(path.join(__dirname, "preview.png"), render(await gather()));
    return console.log("wrote preview.png");
  }
  fs.writeFileSync(path.join(__dirname, "panel.pid"), String(process.pid)); // lets stop-panel.ps1 find this loop
  await ready;
  await installWatchdog();
  await readBattery();
  if (args.includes("--once")) return tick();

  console.log(`Agents panel -> ${HOST}:${PORT} every ${INTERVAL / 1000}s (Ctrl+C to stop)`);
  for (;;) {
    try { await tick(); }
    catch (e) { console.error(`${new Date().toLocaleTimeString()}  push failed: ${e.message.split("\n")[0]}`); }
    await new Promise((r) => setTimeout(r, INTERVAL));
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
