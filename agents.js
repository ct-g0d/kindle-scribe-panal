// Reads agent status from T3 Code's local state DB (read-only).
// Shows only threads that matter right now:
//   needs_you - a pending input/approval request
//   done      - finished (or failed) and not yet settled, i.e. waiting for you to open it
//   working   - a run in progress
//   waiting   - a run queued/waiting to start
// Hidden: settled threads (marked settled, or opened after the run finished, unless forced "active"),
// and sub-threads unless they are running or need input themselves (T3 shows them under their parent).
const { DatabaseSync } = require("node:sqlite");
const path = require("node:path");
const os = require("node:os");

const DB_PATH = process.env.T3_DB || path.join(os.homedir(), ".t3", "userdata", "statev2.sqlite");

const latest = (...ts) => ts.filter(Boolean).sort().at(-1) || null;

function readAgents() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    const projects = new Map(
      db.prepare("select project_id, title from projection_projects").all().map((p) => [p.project_id, p.title])
    );
    const threads = db.prepare(`
      select thread_id, project_id, title, default_provider, updated_at, created_at, payload_json
      from orchestration_v2_projection_threads
      where archived_at is null and deleted_at is null`).all();

    const lastRun = db.prepare(`
      select status, requested_at, completed_at from orchestration_v2_projection_runs
      where thread_id = ? order by ordinal desc limit 1`);
    // open requests; non-blocking ones (async questions the run keeps working past) don't need you yet
    const pending = db.prepare(`
      select payload_json from orchestration_v2_projection_runtime_requests
      where thread_id = ? and status not in ('resolved', 'cancelled')`);
    const lastMsg = db.prepare(`
      select payload_json, updated_at from orchestration_v2_projection_messages
      where thread_id = ? and role = 'assistant' order by updated_at desc limit 1`);

    const now = Date.now();
    const agents = [];
    for (const t of threads) {
      const p = safeJson(t.payload_json) || {};
      const run = lastRun.get(t.thread_id);
      if (p.snoozedUntil && Date.parse(p.snoozedUntil) > now) continue; // snoozed in T3

      const visitedAfterFinish = !!(p.lastVisitedAt && run?.completed_at && p.lastVisitedAt >= run.completed_at);
      // "unsettled" after being settled (unsettledAt newer than settledAt) brings the thread back
      const settledAt = p.settledAt && !(p.unsettledAt && p.unsettledAt > p.settledAt) ? p.settledAt : null;
      const settled = p.settledOverride === "settled" || (p.settledOverride !== "active" && (!!settledAt || visitedAfterFinish));
      const child = !!p.lineage?.parentThreadId;
      const blocking = pending.all(t.thread_id).some((r) => safeJson(r.payload_json)?.blocking !== false);

      // T3 run statuses: preparing queued starting running waiting | completed interrupted failed cancelled rolled_back
      const rs = run?.status;
      let status = null;
      if (blocking) status = "needs_you";
      else if (["preparing", "starting", "running"].includes(rs)) status = "working";
      else if (child && rs !== "waiting") status = null; // finished sub-threads live under their parent in T3
      else if (["queued", "waiting"].includes(rs)) status = "waiting";
      else if (!settled && rs === "completed") status = "done";
      else if (!settled && rs === "failed") status = "failed";
      else if (!settled && ["interrupted", "cancelled"].includes(rs)) status = "stopped";
      if (!status) continue;

      const msg = lastMsg.get(t.thread_id);
      agents.push({
        id: t.thread_id,
        title: t.title,
        project: projects.get(t.project_id) || "",
        provider: t.default_provider,
        model: (p.modelSelection?.model || "").split("/").at(-1),
        branch: p.branch || "",
        child,
        status,
        // running -> time so far; finished -> how long the run took; waiting -> time since created
        runMs: run?.requested_at
          ? (run.completed_at ? Date.parse(run.completed_at) : now) - Date.parse(run.requested_at)
          : now - Date.parse(t.created_at),
        lastActivity: latest(t.updated_at, run?.requested_at, run?.completed_at, msg?.updated_at),
        snippet: (safeJson(msg?.payload_json)?.text || "").replace(/\s+/g, " ").trim(),
      });
    }

    const rank = { needs_you: 0, done: 1, failed: 1, stopped: 1, working: 2, waiting: 3 };
    return agents.sort((a, b) => rank[a.status] - rank[b.status] || (b.lastActivity || "").localeCompare(a.lastActivity || ""));
  } finally {
    db.close();
  }
}

function safeJson(s) {
  try { return s ? JSON.parse(s) : null; } catch { return null; }
}

module.exports = { readAgents };

if (require.main === module) console.table(readAgents().map(({ snippet, id, branch, ...a }) => a));
