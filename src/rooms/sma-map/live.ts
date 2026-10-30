// Live evidence of the SMA map: per group of nodes, what in the plugin's database shows that the group worked on real work, and
// where to look when its trace is not in this database. `entries.ts` proves that the code exists; this says whether it ran.
// Each query takes :since (ms) and returns `n` (how many times in the window) and `last` (ms of the newest, or null).

export type LiveSource = { sql: string } | { outside: string };

const t = (table: string, at: string, where = "1=1"): LiveSource => ({ sql: `SELECT COUNT(*) AS n, MAX(${at}) AS last FROM ${table} WHERE ${at} >= :since AND (${where})` });
const wf = (...ids: string[]): LiveSource => t("lane_pilot_wf_run", "created_at", `workflow_id IN (${ids.map((id) => `'${id}'`).join(",")})`);
const part = (where: string): LiveSource => t("lane_pilot_phase_part", "at", where);
const stage = (...ids: string[]): LiveSource => t("lane_pilot_stage_event", "occurred_at", `stage_id IN (${ids.map((id) => `'${id}'`).join(",")})`);
const gate = (...ids: string[]): LiveSource => t("lane_pilot_gate_event", "occurred_at", `gate IN (${ids.map((id) => `'${id}'`).join(",")})`);
const jevOf = (...ids: string[]): LiveSource => t("lane_pilot_jev_receipt", "at", `judgment IN (${ids.map((id) => `'${id}'`).join(",")})`);
const outside = (where: string): LiveSource => ({ outside: where });

/** Keyed by `region | group` as the map names them (SMA_NODES); a region without groups has the key `region | `. */
export const SMA_LIVE: Readonly<Record<string, LiveSource>> = {
  "Phase graph | 1 · 1 · Discussion": part("section IN ('goal','discussion')"),
  "Phase graph | 2 · 2 · Planning": part("section='plan'"),
  "Phase graph | 3 · 3 · Design": part("section='design'"),
  "Phase graph | 4 · 4 · Execution by plans": part("section='execution'"),
  "Phase graph | 5 · 5 · Verification": part("section='verification'"),
  "Phase graph | 6 · 6 · Acceptance": part("section='acceptance'"),
  "Phase graph | 7 · 7 · Lessons": part("section='lessons'"),
  "Phase graph | Phase control work": t("lane_pilot_phase", "updated_at"),
  "Phase graph | Phase controls": part("section='decisions'"),
  "Task graph | Life of one attempt": t("lane_pilot_attempt_transition", "at"),
  "Task graph | Fleet attempt automaton": t("lane_pilot_attempt", "created_at"),
  "Task graph | Work acceptance": gate("accept", "validate"),
  "Task graph | Task birth and words": t("lane_pilot_task", "created_at"),
  "Task graph | Durable queue row": t("lane_pilot_attempt_transition", "at", "to_state IN ('queued','running')"),
  "Task graph | Task steps": stage("pm-read", "plan-critique", "writer-agent", "verification", "acceptance-receipt"),
  "Batch graph | Batch closure": t("lane_pilot_run_goal", "at"),
  "Batch graph | Formation and composition": t("lane_pilot_run", "created_at"),
  "Batch graph | Issue, pilot, fan-out": t("lane_pilot_attempt", "created_at", "attempt_no=1"),
  "Batch graph | Wave verification and acceptance": part("kind IN ('wave_in','wave_table','wave_stopped')"),
  "Worker | Worker boundaries": gate("owns-paths"),
  "Worker | Capability cells": t("lane_pilot_capability", "at"),
  "Worker | Strict worker: separate user": outside("worker.strict_user is off; the lp-worker OS user is not created on any machine"),
  "Worker | Roles and vendors": stage("writer-agent"),
  "Daemon tick | ": t("lane_pilot_schedule_run", "started_at"),
  "Daemon life | Daemon boot": t("lane_pilot_schedule_run", "started_at"),
  "Daemon life | Settings file": t("lane_pilot_project_settings", "updated_at"),
  "Daemon life | Stop and restart": t("lane_pilot_outage", "noticed_at"),
  "Daemon life | The voice outward": t("lane_pilot_pm_notice", "sent_at"),
  "Daemon life | Watchdog and outage": t("lane_pilot_outage", "noticed_at"),
  "Conversation and intake | Conversation book": t("lane_pilot_wf_event", "at"),
  "Conversation and intake | Checks from the conversation": t("lane_pilot_baseline", "at"),
  "Conversation and intake | Conversation door": jevOf("intake.weight"),
  "Conversation and intake | Turn engine": jevOf("intake.weight", "learning.owner_message"),
  "Conversation and intake | Free branch: the model": stage("pm-read"),
  "Conversation and intake | Backlog intake": t("lane_pilot_backlog_issue", "issued_at"),
  "Conversation and intake | Stage questions": part("kind IN ('question','answer')"),
  "Conversation and intake | Word and composition proposals": t("lane_pilot_learning_signal", "at", "kind='owner_question'"),
  "Providers, models, accounts | Accounts and the separate user": outside("worker.strict_user is off; accounts are BB providers"),
  "Providers, models, accounts | Vendor lanes": stage("writer-agent"),
  "Providers, models, accounts | The worker ' s personal layer": stage("writer-agent"),
  "Providers, models, accounts | Model and worker choice": t("lane_pilot_stage_receipt", "updated_at", "stage_id='writer-agent'"),
  "Providers, models, accounts | Money and spend": t("lane_pilot_token_daily", "CAST(strftime('%s', day) AS INTEGER) * 1000"),
  "Providers, models, accounts | Capability probes and drills": t("lane_pilot_capability", "at"),
  "Providers, models, accounts | Launch command assembly": stage("writer-agent"),
  "Providers, models, accounts | Subscription windows": t("lane_pilot_token_daily", "CAST(strftime('%s', day) AS INTEGER) * 1000"),
  "Daemon front outside the graphs | Entry and pass": outside("BB core owner-auth (vk), opt-in; port 38886 behind bb-door.service on the hub"),
  "Daemon front outside the graphs | Roster and switches": t("lane_pilot_project_settings", "updated_at"),
  "Daemon front outside the graphs | Bring your own helpers": outside("plugin KV front:helpers (bb lane-pilot helpers)"),
  "Daemon front outside the graphs | Machines and one household": outside("plugin KV front:peers (cockpit «Машины»)"),
  "Daemon front outside the graphs | First run": t("lane_pilot_activation", "claimed_at"),
  "Daemon front outside the graphs | Projects": t("lane_pilot_activation", "claimed_at"),
  "Daemon front outside the graphs | Reads and the live stream": outside("BB rpc timing log (front actions_recent)"),
  "Daemon front outside the graphs | Ship and update": outside("~/.lane-pilot/deploys.log on the deploying machine"),
  "Person and window | Doors (72)": outside("BB web UI: plugin pages and RPC calls (front actions_recent)"),
  "Person and window | The whole window": outside("BB web UI: cockpit_seen (plugin KV)"),
  "Person and window | Window screens": outside("BB web UI: cockpit_seen (plugin KV)"),
  "Telegram | Bridge and polling": outside("telegram-projects plugin data.db: queue:/sent: keys"),
  "Telegram | Connecting the bot": outside("telegram-projects plugin data.db: link state"),
  "The forge | ": t("lane_pilot_wf_draft", "created_at"),
  "Supervisor | Live drills": outside("<plugin>/.agents/runs/drills/*.json on the deploying machine"),
  "Supervisor | Separate worker user": outside("worker.strict_user is off"),
  "Supervisor | Lift on Windows and Mac": outside("launchd/systemd units of the BB daemon on each machine"),
  "Supervisor | Logs and the terminal": outside("~/.bb-machines/*/logs on each machine"),
  "Supervisor | Queue Postgres": outside("BB core SQLite queue (no Postgres)"),
  "Supervisor | Watchdog without a terminal": outside("hub-watchdog.timer journal on the hub"),
  "Guard tools | ": outside("~/.agents/hooks guard log on each machine"),
  "Memory | ": t("lane_pilot_memory", "created_at"),
  "Memory | Corpus care": t("lane_pilot_memory_probe", "at"),
  "Memory | Memory verbs in the terminal": t("lane_pilot_memory", "last_used_at"),
  "Memory | How memory reaches a session": t("lane_pilot_memory", "last_used_at"),
  "How we prove it | Durable records": t("lane_pilot_stage_receipt", "updated_at"),
  "How we prove it | Graph release series": outside("<plugin>/.agents/runs/drills/*.json on the deploying machine"),
  "Slash commands and workflows | Design and execution": wf("lp.build", "review-fix", "ui-audit", "impeccable-build"),
  "Slash commands and workflows | Todos, notes, seeds": t("lane_pilot_backlog_issue", "issued_at"),
  "Slash commands and workflows | Verification, transition, lessons": wf("debug", "full-lifecycle", "grill-plan", "lp.close", "review-fix", "test-gen", "ui-audit", "validate-phase"),
  "Slash commands and workflows | Debugging and repair": wf("debug"),
  "Slash commands and workflows | Documents and summaries": stage("docs-maintenance"),
  "Slash commands and workflows | Ideas, spikes, sketches": wf("analyze-code", "spike", "brainstorm-driven"),
  "Slash commands and workflows | Quick work and autopilot": wf("companion", "issue-quick", "lp-task-pipeline"),
  "Slash commands and workflows | Navigation and session": wf("resume"),
  "Slash commands and workflows | Phase planning": wf("grill-driven", "lp.plan", "lp.analyze", "plan-review-convergence", "plan-only"),
  "Slash commands and workflows | Review, security, audit": wf("code-review", "eval-review", "review-fix", "security-audit", "test-gen", "ui-audit", "validate-phase", "lp.review"),
  "Slash commands and workflows | Roadmap editing": wf("roadmap-driven"),
  "Slash commands and workflows | Settings and profile": t("lane_pilot_project_settings", "updated_at"),
  "Slash commands and workflows | Before the plan: discussion and contracts": wf("ai-integration-phase", "grill-plan", "impeccable-build", "lp.brainstorm"),
  "Slash commands and workflows | Shipping and milestones": wf("cleanup", "code-review", "deploy", "milestone-close", "new-milestone", "pr-branch", "ship"),
  "Slash commands and workflows | Help names without a file": outside("SMA help names these commands with no file behind them; nothing runs them in SMA either"),
  "Slash commands and workflows | Project start and workspaces": wf("analyze-code", "new-milestone", "project-start"),
  "Agent roles (subagents) | Roles for AI phases": outside("Lane Stack subagent spawns (sma_hooks spawn log on each machine)"),
  "Agent roles (subagents) | Execution and repair roles": stage("writer-agent", "code-critique"),
  "Agent roles (subagents) | Verification roles": stage("verification", "plan-critique", "code-critique"),
  "Agent roles (subagents) | Document and knowledge roles": stage("docs-maintenance", "memory-maintenance"),
  "Agent roles (subagents) | Research and planning roles": stage("pm-read", "plan-critique"),
  "Agent roles (subagents) | Who may spawn subagents": outside("Lane Stack spawn guard log on each machine"),
  "Claude Code session hooks | ": outside("Lane Stack hook logs on each machine (~/.agents/hooks)"),
  "Claude Code session hooks | End of turn and session": outside("Lane Stack hook logs on each machine (~/.agents/hooks)"),
  "Claude Code session hooks | Session start and prompt": outside("Lane Stack hook logs on each machine (~/.agents/hooks)"),
  "Claude Code session hooks | Subagents and compaction": outside("Lane Stack hook logs on each machine (~/.agents/hooks)"),
  "Claude Code session hooks | Around every tool call": outside("Lane Stack guard log on each machine (~/.agents/hooks)"),
  "Install, update, remove | Removal": outside("~/.agents/.lane-stack-version on each machine"),
  "Install, update, remove | The init installer": outside("~/.agents/.lane-stack-version on each machine"),
  "Install, update, remove | Update": outside("~/.agents/.lane-stack-version on each machine"),
  "Terminal coordination | ": outside("lane_coord claims in each project's .agents/coord"),
  "sma-tools: project queries | ": outside("Lane Stack sma-tools calls in sessions"),
  "The project. planning folder | ": outside("each project's .agents/planning (lane-plan)"),
  "Templates, references, contexts | ": outside("Lane Stack templates/ (read by lane-plan)"),
  "Templates, references, contexts | References for agents": outside("Lane Stack references/ (read by agents)"),
  "Templates, references, contexts | Document templates": outside("Lane Stack templates/ (read by lane-plan)"),
  "Safety nets, budget and guards | ": t("lane_pilot_failure_triage", "triaged_at"),
  "Receipts and evidence | ": t("lane_pilot_stage_receipt", "updated_at"),
  "Self-improvement and measurement | ": t("lane_pilot_wall_entry", "recorded_at"),
  "Shipping and honest numbers | ": outside("<plugin>/CHANGELOG.md and GitHub releases"),
  "Design training and evaluation | ": t("lane_pilot_harness", "created_at"),
};

export type LiveRow = { key: string; region: string; group: string; nodes: number; n: number | null; last: number | null; outside: string | null; error?: string };

/** Runs every query of SMA_LIVE over the window; a query that fails says why instead of hiding the group. */
export function readSmaLive(db: { prepare(sql: string): { get(...args: unknown[]): unknown } }, groups: ReadonlyArray<{ region: string; group: string; nodes: number }>, since: number): LiveRow[] {
  return groups.map(({ region, group, nodes }) => {
    const key = `${region} | ${group}`;
    const source = SMA_LIVE[key];
    if (!source) return { key, region, group, nodes, n: null, last: null, outside: null, error: "no live source" };
    if ("outside" in source) return { key, region, group, nodes, n: null, last: null, outside: source.outside };
    try {
      const row = db.prepare(source.sql.replace(/:since/g, String(Math.floor(since)))).get() as { n?: number; last?: number | null } | undefined;
      return { key, region, group, nodes, n: Number(row?.n ?? 0), last: row?.last ?? null, outside: null };
    } catch (cause) {
      return { key, region, group, nodes, n: null, last: null, outside: null, error: cause instanceof Error ? cause.message : String(cause) };
    }
  });
}

/** The map's groups with their node counts, in map order. */
export function smaGroups(nodes: ReadonlyArray<readonly [string, number, string, string, string]>, regions: readonly string[]) {
  const seen = new Map<string, { region: string; group: string; nodes: number }>();
  for (const [, region, group] of nodes) {
    const key = `${regions[region]} | ${group}`;
    const row = seen.get(key) ?? { region: regions[region]!, group, nodes: 0 };
    row.nodes += 1;
    seen.set(key, row);
  }
  return [...seen.values()];
}

/** `--live [--days N]`: per region how many nodes sit in groups that worked in the window, that stayed silent, or whose trace lives elsewhere. */
export function renderSmaLive(rows: readonly LiveRow[], days: number, now = Date.now()): string {
  const regions = [...new Set(rows.map((row) => row.region))];
  const sum = (list: readonly LiveRow[], test: (row: LiveRow) => boolean) => list.filter(test).reduce((total, row) => total + row.nodes, 0);
  const live = (row: LiveRow) => (row.n ?? 0) > 0, silent = (row: LiveRow) => row.n === 0, away = (row: LiveRow) => !!row.outside;
  const lines = [`SMA map, live in the last ${days} day(s): ${sum(rows, live)} nodes in groups that worked, ${sum(rows, silent)} silent, ${sum(rows, away)} traced outside this database.`, "",
    "region                                   live silent outside"];
  for (const region of regions) {
    const part = rows.filter((row) => row.region === region);
    lines.push(`${region.slice(0, 40).padEnd(40)} ${String(sum(part, live)).padStart(4)} ${String(sum(part, silent)).padStart(6)} ${String(sum(part, away)).padStart(7)}`);
  }
  lines.push("", "silent groups (no trace in the window):");
  for (const row of rows.filter(silent)) lines.push(`  ${row.key} (${row.nodes} nodes)${row.last ? "" : ""}`);
  lines.push("", "groups that worked:");
  for (const row of rows.filter(live)) lines.push(`  ${row.key} — ${row.n} time(s), last ${Math.round((now - (row.last ?? now)) / 3_600_000)} h ago`);
  const failed = rows.filter((row) => row.error);
  if (failed.length) lines.push("", "queries that failed:", ...failed.map((row) => `  ${row.key}: ${row.error}`));
  return lines.join("\n");
}

// ---- dark tables (W32 rank 9) ----

/** A table nobody counts is a silent instrument: 7 tables wrote nothing for 30 days without a single report naming them
 * (stage_return, checker_run, checker_result, harness_experience, memory_miss, outage, bench_noise on 2026-10-31). Every
 * `lane_pilot_*` table a migration creates is named here with the column its recency is read on (`""`: no clock, counted in
 * full — a dimension/cursor store). tests/sma-live.test.ts fails on a new migration table missing from this map, and on one
 * missing from scripts/lp-wall-morning.sql, so no table goes silently dark again. */
export const TABLE_CLOCKS: Record<string, string> = {
  lane_pilot_accepted_fact: "created_at", lane_pilot_activation: "claimed_at", lane_pilot_attempt: "created_at",
  lane_pilot_attempt_change: "updated_at", lane_pilot_attempt_reasoning: "",
  lane_pilot_attempt_transition: "at", lane_pilot_backlog_issue: "issued_at", lane_pilot_baseline: "at",
  lane_pilot_bench_mark: "", lane_pilot_bench_noise: "created_at", lane_pilot_bench_project: "updated_at",
  lane_pilot_bench_result: "recorded_at", lane_pilot_bench_run: "started_at", lane_pilot_bench_set: "created_at",
  lane_pilot_bench_task: "", lane_pilot_bench_verdict: "created_at", lane_pilot_capability: "at",
  lane_pilot_check_duration: "at", lane_pilot_checker_result: "recorded_at", lane_pilot_checker_run: "started_at",
  lane_pilot_council: "created_at", lane_pilot_council_message: "at", lane_pilot_deferral: "created_at",
  lane_pilot_diff_hidden_audit: "recorded_at", lane_pilot_failure_triage: "triaged_at", lane_pilot_gate_event: "occurred_at",
  lane_pilot_handoff: "created_at", lane_pilot_handoff_event: "occurred_at", lane_pilot_harness: "created_at",
  lane_pilot_harness_experience: "created_at", lane_pilot_hypothesis: "created_at", lane_pilot_janitor: "at", lane_pilot_jev_receipt: "at",
  lane_pilot_learning_item: "created_at", lane_pilot_learning_obs: "at", lane_pilot_learning_signal: "at",
  lane_pilot_memory: "created_at", lane_pilot_memory_conflict: "", lane_pilot_memory_miss: "at",
  lane_pilot_memory_probe: "at", lane_pilot_memory_promotion: "at", lane_pilot_memory_receipt: "created_at",
  lane_pilot_model_rebench: "recorded_at", lane_pilot_outage: "noticed_at", lane_pilot_owner_config: "updated_at", lane_pilot_owner_item: "created_at",
  lane_pilot_owner_push: "", lane_pilot_phase: "created_at", lane_pilot_phase_part: "at",
  lane_pilot_pm_notice: "sent_at", lane_pilot_project_settings: "updated_at", lane_pilot_reconcile_cursor: "updated_at",
  lane_pilot_regress_pass: "at", lane_pilot_regression: "found_at", lane_pilot_rule_event: "at",
  lane_pilot_rule_promotion: "created_at", lane_pilot_rule_proposal: "updated_at",
  lane_pilot_run: "created_at", lane_pilot_run_goal: "at", lane_pilot_schedule: "created_at",
  lane_pilot_schedule_run: "started_at", lane_pilot_secret_issuance: "at",
  lane_pilot_setting_generation: "", lane_pilot_skill_metric: "recorded_at", lane_pilot_stage_event: "occurred_at", lane_pilot_stage_receipt: "updated_at",
  lane_pilot_stage_return: "at", lane_pilot_task: "created_at", lane_pilot_task_git_base: "",
  lane_pilot_task_plan: "", lane_pilot_task_receipt: "at",
  lane_pilot_token_cursor: "updated_at", lane_pilot_token_daily: "day", lane_pilot_wall: "created_at",
  lane_pilot_wall_class: "updated_at", lane_pilot_wall_entry: "recorded_at", lane_pilot_wall_night: "started_at",
  lane_pilot_wall_repair: "created_at", lane_pilot_wall_rerun: "created_at", lane_pilot_wf_arrival: "at",
  lane_pilot_wf_draft: "created_at", lane_pilot_wf_draft_version: "at", lane_pilot_wf_effect: "created_at",
  lane_pilot_wf_event: "at", lane_pilot_wf_run: "created_at",
  lane_pilot_wf_step: "updated_at", lane_pilot_wf_test: "at", lane_pilot_wf_trigger: "created_at", lane_pilot_world: "",
};

export type DarkTableRow = { table: string; clock: string | null; n: number; last: number | null };

type DarkDb = { prepare(sql: string): { all(...args: unknown[]): unknown[]; get(...args: unknown[]): unknown } };

/** The SQL a table's recency is counted on: a column name, or the day-as-ms expression `lane_pilot_token_daily` uses. */
export const darkClockExpr = (table: string): string | null => {
  const clock = TABLE_CLOCKS[table];
  return clock === undefined ? null : clock === "day" ? "CAST(strftime('%s', day) AS INTEGER) * 1000" : clock || null;
};

/** Tables skipped on purpose: `*_next`/`_nv`/`_v` are rename-squash intermediates, `lane_pilot_memory_fts*` are FTS5
 * plumbing behind lane_pilot_memory — neither is an instrument. */
export const TABLE_SKIP_RE = /lane_pilot_(memory_fts|.*_next|.*_nv|.*_v)$/;

/** Every named table with the rows it took in the window — all rows when it has no clock. Absent tables are skipped. */
export function darkTables(db: DarkDb, since: number): DarkTableRow[] {
  const present = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'lane_pilot_%' AND name NOT LIKE 'lane_pilot_memory_fts%'").all() as Array<{ name: string }>).map((row) => row.name));
  return Object.keys(TABLE_CLOCKS).filter((table) => present.has(table)).map((table) => {
    const clock = darkClockExpr(table);
    const row = (clock
      ? db.prepare(`SELECT COUNT(*) AS n, MAX(${clock}) AS last FROM ${table} WHERE ${clock} >= ?`).get(since)
      : db.prepare(`SELECT COUNT(*) AS n, NULL AS last FROM ${table}`).get()) as { n: number; last: number | null };
    return { table, clock, n: row.n, last: row.last };
  });
}

/** The names of the tables that wrote nothing in the window — the «0 rows in 30 days» paragraph of the night summary. */
export function darkTableNames(db: DarkDb, since: number): string[] {
  return darkTables(db, since).filter((row) => row.n === 0).map((row) => row.table);
}

