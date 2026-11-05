// Today's War Plan to-do list.
// The task schedule lives in the War Plan app's own code (TASK_DEFS + V2_DAYS), so we lift that block out of
// the app bundle and run it in a sandbox, then mark tasks done from the app's saved state (war-plan.json).
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const APP_HTML = process.env.WARPLAN_HTML || "D:/Nexus/Nexus_Standalone_Apps/WarPlan/resources/app/dist/index.html";
// War Plan's save file. When War Plan is started from inside the Claude app (a packaged app), Windows redirects
// its AppData into Claude's package storage, so the real file may live there instead. Use whichever copy is newest.
const STATE_REL = path.join("warplan", "war-plan.json");
function statePath() {
  if (process.env.WARPLAN_STATE) return process.env.WARPLAN_STATE;
  const local = process.env.LOCALAPPDATA || path.join(require("node:os").homedir(), "AppData", "Local");
  const candidates = [path.join(process.env.APPDATA || "", STATE_REL)];
  try {
    for (const d of fs.readdirSync(path.join(local, "Packages")))
      if (/^Claude_/i.test(d)) candidates.push(path.join(local, "Packages", d, "LocalCache", "Roaming", STATE_REL));
  } catch { /* no packaged apps */ }
  const found = candidates.map((p) => { try { return { p, t: fs.statSync(p).mtimeMs }; } catch { return null; } }).filter(Boolean);
  if (!found.length) throw new Error(`War Plan save file not found (looked in ${candidates.join(", ")})`);
  return found.sort((a, b) => b.t - a.t)[0].p;
}

let cache = { mtime: 0, api: null };

function loadPlanCode() {
  const mtime = fs.statSync(APP_HTML).mtimeMs;
  if (cache.api && cache.mtime === mtime) return cache.api;
  const s = fs.readFileSync(APP_HTML, "utf8");
  const start = s.indexOf("const SCORE=");
  const end = s.indexOf("function missionQuotaTotal");
  const stagesStart = s.indexOf("const stages=[");
  const stagesEnd = s.indexOf("];", stagesStart) + 2;
  if (start < 0 || end < 0 || stagesStart < 0) throw new Error("War Plan task code not found (app updated?)");
  const code = s.slice(start, end) + "\n" + s.slice(stagesStart, stagesEnd) + `
    function activeStage(key){return stages.find(s=>key>=s.start&&key<=s.end)||null}
    globalThis.__wp = { getActiveTaskIds, getTaskView };`;
  const ctx = vm.createContext({});
  vm.runInContext(code, ctx, { timeout: 2000 });
  cache = { mtime, api: ctx.__wp };
  return cache.api;
}

function localKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function readTodos(date = new Date()) {
  const key = localKey(date);
  const api = loadPlanCode();
  const state = JSON.parse(JSON.parse(fs.readFileSync(statePath(), "utf8"))["charles-war-plan-v1"]);
  const checks = state.checks?.[key] || {};
  const tasks = api.getActiveTaskIds(key).map((id) => {
    const v = api.getTaskView(id, key);
    return { id, title: v.title, sub: v.sub, pts: v.pts, done: !!checks[id] };
  });
  return { date: key, tasks, sealed: !!state.sealed?.[key] };
}

module.exports = { readTodos };

if (require.main === module) console.dir(readTodos(), { depth: 3 });
