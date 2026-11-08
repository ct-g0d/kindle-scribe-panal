// Token usage (from TokeX's local DB, read-only), usage limits and now playing. Weather is in weather.js.
const { DatabaseSync } = require("node:sqlite");

const TOKEX_DB = process.env.TOKEX_DB || "D:/TokeX/data/token-monitor.sqlite";

function localDate(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA").format(d); // YYYY-MM-DD in the PC's own time zone
}

function readUsage() {
  const db = new DatabaseSync(TOKEX_DB, { readOnly: true });
  try {
    const today = localDate();
    const totals = db.prepare(`
      select coalesce(sum(total_tokens),0) tokens, coalesce(sum(cost),0) cost, coalesce(sum(turn_count),0) turns
      from daily_rollups where date = ?`).get(today);
    const byClient = db.prepare(`
      select client, sum(total_tokens) tokens, sum(cost) cost from daily_rollups
      where date = ? group by client order by cost desc`).all(today);
    const days = db.prepare(`
      select date, sum(total_tokens) tokens, sum(cost) cost from daily_rollups
      where date > date(?, '-7 days') and date <= ? group by date order by date`).all(today, today);
    const byModel = db.prepare(`
      select model, client, sum(total_tokens) tokens, sum(cost) cost, sum(turn_count) turns from daily_rollups
      where date = ? group by model, client order by cost desc`).all(today);
    const period = (n) => ({ ...db.prepare(`
      select coalesce(sum(total_tokens),0) tokens, coalesce(sum(cost),0) cost from daily_rollups
      where date > date(?, ?) and date <= ?`).get(today, `-${n} days`, today) });
    const all = { ...db.prepare("select coalesce(sum(total_tokens),0) tokens, coalesce(sum(cost),0) cost, min(date) since from daily_rollups").get() };
    // daily history for the heatmap (26 weeks, like TokeX)
    const history = db.prepare(`
      select date, sum(total_tokens) tokens, sum(cost) cost from daily_rollups
      where date > date(?, '-182 days') and date <= ? group by date`).all(today, today);
    const plain = (rows) => rows.map((r) => ({ ...r }));
    return {
      today, ...totals,
      byClient: plain(byClient), byModel: plain(byModel), days: plain(days), history: plain(history),
      periods: { d7: period(7), d30: period(30), d90: period(90), all },
    };
  } finally {
    db.close();
  }
}

// Cache files can be shared by several accounts' loops: write a temp file and rename it in, so a reader
// never sees half a file.
function writeCache(file, data) {
  const fs = require("node:fs"), tmp = `${file}.${process.pid}.tmp`;
  try { fs.writeFileSync(tmp, JSON.stringify(data)); fs.renameSync(tmp, file); }
  catch { try { fs.unlinkSync(tmp); } catch { /* cache is optional */ } }
}

// Usage limits (5h session / weekly windows) via TokeX's own limits module, using the logins TokeX already
// has and the providers enabled in its settings. TokeX keeps these only in memory, so we ask the same way it
// does, at most every LIMITS_TTL.
const TOKEX_DIR = process.env.TOKEX_DIR || "D:/TokeX";
const LIMITS_TTL = 5 * 60e3;
// last good snapshot survives restarts (percentages and reset times only, no account details).
// Per Windows account: each has its own TokeX logins, and a stale provider from another account would stick.
const LIMITS_FILE = require("node:path").join(__dirname, `limits-cache-${require("node:os").userInfo().username}.json`);
let limitsCache = (() => {
  try { return { at: 0, data: JSON.parse(require("node:fs").readFileSync(LIMITS_FILE, "utf8")) }; } catch { return null; }
})();
async function readLimits() {
  if (limitsCache && Date.now() - limitsCache.at < LIMITS_TTL) return limitsCache.data;
  try {
    const path = require("node:path");
    const dataDir = path.join(process.env.APPDATA || "", "Token Monitor");
    const settings = JSON.parse(require("node:fs").readFileSync(path.join(dataDir, "settings.json"), "utf8"));
    const { collectLimitsOnce } = require(`${TOKEX_DIR}/src/shared/limits/collector.js`);

    // Antigravity limits come from the Google accounts TokeX manages. We only read those logins;
    // no renewal callback is passed, so nothing is ever written back to TokeX's credential store.
    let antigravityManagedAccounts;
    try {
      const { CredentialStore } = require(`${TOKEX_DIR}/src/shared/credentialStore.js`);
      const oauth = require(`${TOKEX_DIR}/src/shared/providers/antigravity/oauth.js`);
      const store = new CredentialStore(dataDir);
      antigravityManagedAccounts = oauth.managedAccountsForCollector(settings.antigravityManagedAccounts,
        (id) => { try { return store.readAntigravityCredential(id); } catch { return null; } });
    } catch { /* Antigravity just won't show */ }

    const s = await collectLimitsOnce({
      limitsEnabled: true,
      limitProviders: settings.limitProviders || "claude,codex",
      ...(antigravityManagedAccounts ? { antigravityManagedAccounts } : {}),
    });

    // Group accounts per provider; average each window across accounts and keep the soonest reset.
    const groups = new Map();
    for (const p of s.providers.filter((p) => p.status === "ok")) {
      const g = groups.get(p.provider) || { provider: p.provider, accounts: 0, windows: new Map(), balanceUsd: null, perAccount: [] };
      g.accounts++;
      // per-account Gemini windows for Antigravity (shown as one pill per account)
      if (p.provider === "antigravity") {
        const pick = (re) => {
          const w = (p.windows || []).find((x) => re.test(x.label || ""));
          return w ? { remaining: w.usedPercent == null ? 0 : Math.max(0, 100 - w.usedPercent), resetsAt: w.resetsAt, windowMinutes: w.windowMinutes ?? null } : null;
        };
        g.perAccount.push({ session: pick(/gemini.*5-?h/i), weekly: pick(/gemini.*week/i) });
      }
      if (p.balanceUsd != null) g.balanceUsd = (g.balanceUsd || 0) + p.balanceUsd;
      for (const w of p.windows || []) {
        if (w.usedPercent == null) continue;
        const key = `${w.kind}|${w.label || ""}`;
        const acc = g.windows.get(key) || { kind: w.kind, label: w.label || "", sum: 0, n: 0, resetsAt: null, windowMinutes: w.windowMinutes ?? null };
        acc.sum += w.usedPercent; acc.n++;
        if (w.resetsAt && (!acc.resetsAt || w.resetsAt < acc.resetsAt)) acc.resetsAt = w.resetsAt;
        g.windows.set(key, acc);
      }
      groups.set(p.provider, g);
    }
    const data = [...groups.values()].map((g) => {
      let windows = [...g.windows.values()].map((w) => ({ kind: w.kind, label: w.label, usedPercent: w.sum / w.n, resetsAt: w.resetsAt, windowMinutes: w.windowMinutes }));
      // more than two windows (e.g. Antigravity's Gemini + Claude/GPT pools): keep the two closest to their limit
      if (windows.length > 2) windows = windows.sort((a, b) => b.usedPercent - a.usedPercent).slice(0, 2)
        .sort((a, b) => (a.kind === "session" ? -1 : 1) - (b.kind === "session" ? -1 : 1));
      return { provider: g.provider, accounts: g.accounts, windows, balanceUsd: g.balanceUsd, perAccount: g.perAccount };
    }).filter((p) => p.windows.length || p.balanceUsd != null);

    // A provider that failed this round (rate limit, network) keeps its last good snapshot.
    for (const prev of limitsCache?.data || []) {
      if (!data.some((p) => p.provider === prev.provider)) data.push(prev);
    }
    const order = ["claude", "codex", "antigravity"];
    data.sort((a, b) => (order.indexOf(a.provider) + 1 || 99) - (order.indexOf(b.provider) + 1 || 99));
    limitsCache = { at: Date.now(), data };
    writeCache(LIMITS_FILE, data);
    return data;
  } catch (e) {
    return limitsCache?.data || null; // keep the last good snapshot
  }
}

// What the PC is playing (any app in the Windows media flyout: Spotify, browsers, Media Player...).
const NOWPLAYING_PS = require("node:path").join(__dirname, "nowplaying.ps1");
function readNowPlaying() {
  return new Promise((resolve) => {
    require("node:child_process").execFile("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", NOWPLAYING_PS],
      { timeout: 8000, windowsHide: true, encoding: "utf8" }, (err, out) => {
        try { const j = JSON.parse((out || "").trim() || "{}"); resolve(j.title ? j : null); } catch { resolve(null); }
      });
  });
}

module.exports = { readUsage, readLimits, readNowPlaying, writeCache };

if (require.main === module) {
  console.dir(readUsage(), { depth: 3 });
}
