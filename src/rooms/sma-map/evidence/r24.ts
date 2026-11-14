// Region 24 · Safety nets, budget and guards — per-node evidence of the four proofs (docs/sma-evidence.md).
// One line per node, sorted by node number; a batch agent edits only its nodes' lines. Lines with seedEntry or a lone
// wfRun/wfStep trace were derived mechanically by scripts/sma-seed-evidence.ts (2026-11-14), not authored.
import { distort, drill, entry, flip, kv, outside, rows, skipWrite, type RegionEvidence } from "./types";

const CLI = "src/rooms/tools/server/cli-inspect.ts";
const GUARD = "lane-stack/hooks/guard_shell.py";
const HOOKS = "src/rooms/session-hooks/logic.ts";

export default {
  n1653: {
    mutation: flip("src/rooms/rollback/server/rollback.ts", "if (getAttempt(db, attempt.id)?.state !== \"accepted\") return refuse(", "if (getAttempt(db, attempt.id)?.state === \"accepted\") return refuse("),
    reach: entry("the owner runs `bb lane-pilot revert <task>` for an accepted task"),
    // A merged revert leaves a task receipt of kind revert; the hub has none in 30 days and the `revert` drill scene has no passed receipt.
    trace: [rows("lane_pilot_task_receipt", "at", "kind = 'revert' AND state = 'merged'"), drill("revert")],
  },
  n1654: {
    mutation: flip(CLI, "$2 < cut {print $1}", "$2 > cut {print $1}"),
    reach: { ...entry("the owner runs `bb lane-pilot airbag <project>`"), notGatedBy: { "hook.prompt_recall": "the anchor registerCli registers every verb and reads hook settings for other verbs; airbag only lists git refs", "hook.subagent_pack": "same: read for another verb, not by airbag" } },
    trace: outside("a list, prune or probe of refs/lane-airbag/* is an owner CLI run on the project's host; no plugin database row records it"),
  },
  n1655: {
    mutation: flip("src/rooms/money/logic.ts", "if (row.day.startsWith(month))", "if (!row.day.startsWith(month))"),
    reach: entry("the owner opens the money window (money_status) or a paid lane asks the money hold"),
    trace: outside("the spend book is computed on each money_status read from lane_pilot_token_daily; the read itself leaves no row"),
  },
  n1656: {
    mutation: distort("src/rooms/tools/server/cli-pipeline.ts", "by:row.by, why:row.reason", "by:row.by, why:row.by"),
    reach: entry("the owner runs `bb lane-pilot breaker [project]` or `breaker rearm <id> --why`"),
    trace: kv("rules:breaker"),
  },
  n1657: {
    mutation: distort("src/rooms/tasks/gate-report.ts", "&&acked.has(event.id)).length;", "&&!acked.has(event.id)).length;"),
    reach: entry("the owner runs `bb lane-pilot gates ack <event-id> --why` or reads the gate report"),
    trace: kv("gates:acks"),
  },
  n1658: {
    mutation: distort(CLI, "why: ${row.why}", "why: ${row.target}"),
    reach: entry("the owner runs `bb lane-pilot evidence <project>`"),
    trace: outside("evidence records live in plugin KV (evidence:<project>), not in the plugin database"),
  },
  n1659: {
    mutation: distort("src/rooms/policy/protections.ts", "failedStageReceiptsSince(db, projectId, disarm.at)", "failedStageReceiptsSince(db, projectId, disarm.until)"),
    reach: entry("the owner runs `bb lane-pilot integrity [project]` (or --renew / --rearm)"),
    trace: rows("lane_pilot_project_settings", "updated_at", "key LIKE 'protection.disarm.%'"),
  },
  n1660: {
    mutation: distort(GUARD, "run(\"add\", \"-A\")", "run(\"add\", \"-u\")"),
    trace: outside("the return point is a git ref refs/lane-airbag/<epoch> in the writer's checkout on its host; no plugin database row"),
  },
  n1661: {
    mutation: flip("src/rooms/money/logic.ts", "cap > 0 ? cap : null", "cap >= 0 ? cap : null"),
    trace: outside("a money hold would appear as a `money cap` reason on a task; the hub has none (every lane is a subscription)"),
  },
  n1662: {
    mutation: distort("src/rooms/usage/token-math.ts", "nMaybe(\"cachedInputTokens\") ?? nMaybe(\"cacheReadInputTokens\") ?? 0;", "nMaybe(\"cachedInputTokens\") ?? 0;"),
    trace: rows("lane_pilot_token_cursor", "updated_at", "provider_id = 'claude-code' AND last_json NOT LIKE '%\"total\":0,%'"),
  },
  n1663: {
    mutation: distort("src/rooms/money/logic.ts", "return list[key ?? \"default\"] ?? PRICE_LIST", "return list[\"default\"] ?? PRICE_LIST"),
    trace: outside("the price list is read in memory by the spend book and the per-task estimate; no row"),
  },
  n1664: {
    mutation: flip("src/rooms/learning/breaker.ts", "row.count >= TRIP_AT", "row.count > TRIP_AT"),
    trace: kv("rules:breaker"),
  },
  n1665: {
    mutation: flip(HOOKS, "current.readRun >= 8", "current.readRun >= 9"),
    trace: outside("a stall hint is advice printed into the worker's session by the hook; the session state file is not in the plugin database"),
  },
  n1666: {
    mutation: flip(GUARD, "if seen >= 2:", "if seen >= 3:"),
    trace: outside("a reflex line is advice printed by the guard hook into the worker's session; the counter is a file under ~/.lane-pilot/session-hooks"),
  },
  n1667: {
    mutation: flip(HOOKS, "gate.mode === \"block\" ? blocks : warnings", "gate.mode === \"block\" ? warnings : blocks"),
    trace: outside("a convention warning lands on the attempt's card in finish-attempt-body; rules.gates is set on no project of the hub, so nothing fired"),
  },
  n1668: {
    mutation: flip("src/rooms/storage/evidence-store.ts", ".sort((a, b) => b.at - a.at)", ".sort((a, b) => a.at - b.at)"),
    trace: outside("evidence records live in plugin KV (evidence:<project>), not in the plugin database"),
  },
  n1669: {
    mutation: distort("src/rooms/policy/protections.ts", "const level = disarm.before !== undefined ? disarm.before : protection.warning;", "const level = disarm.before !== undefined ? disarm.before : protection.armed;"),
    trace: rows("lane_pilot_owner_item", "created_at", "source = 'disarm-guard' AND key LIKE 'protection-rearm:%'"),
  },
  n1670: {
    mutation: flip(GUARD, "link = _linked_store(cwd)\n        if link:", "link = _linked_store(cwd)\n        if not link:"),
    trace: outside("a refusal is a guard hook decision in the worker's session; no plugin database row"),
  },
  n1671: {
    mutation: distort("src/rooms/verification/git-integrate/deps-install.ts", ".update(await readTextOrNull(join(entry.dir,\"package-lock.json\")) ?? \"\")", ".update(\"\")"),
    trace: outside("the store journal is a file (STORE_JOURNAL) on the project's host"),
  },
  n1672: {
    mutation: distort("src/rooms/host-worker/handlers/machine.ts", "decision: input.decision, why: input.why, at: Date.now() / 1000", "decision: input.decision, why: \"\", at: Date.now() / 1000"),
    reach: entry("the PM answers a writer's permit ticket with lane_pilot_permit"),
    trace: outside("the answer is a file ~/.agents/permits/<session>/<ticket>.answer.json on the host; the evidence of it is in plugin KV"),
  },
  n1673: {
    mutation: skipWrite(GUARD, "verdict[\"used\"] = time.time()"),
    reach: entry("a writer worker runs a command the guard would refuse (a permit ticket is filed), a model turn or a stage"),
    trace: outside("a ticket is a file under ~/.agents/permits on the host; the run budget refusal is a transition (run_budget_exceeded), the hub has none in 30 days"),
  },
  n1674: {
    mutation: distort("src/rooms/writer/progress-journal.ts", "`… ${lines.length - PROGRESS_CAP} more not shown`", "`… ${lines.length - PROGRESS_CAP + 1} more not shown`"),
    trace: outside("PROGRESS.md is a file in the task folder on the project's host"),
  },
  n1676: {
    mutation: flip("src/rooms/native-agent/native-claude-host.ts", "if rule not in mine: mine.append(rule)", "if rule in mine: mine.append(rule)"),
    reach: entry("a helper (non-person) Claude session is launched through the native launcher"),
    trace: outside("the merged settings file is written to the host's temp folder at launch; no plugin database row"),
  },
  n1678: {
    mutation: flip("src/rooms/usage/statusline-segment.ts", "now - Date.parse(at!) > 2 * 3_600_000", "now - Date.parse(at!) > 6 * 3_600_000"),
    trace: outside("the segment is printed by `bb lane-pilot statusline <host>` into a terminal; no row"),
  },
  n1679: {
    mutation: flip("src/rooms/policy/policy.ts", "RESTRICTION[hit.tier] > RESTRICTION[worst]", "RESTRICTION[hit.tier] < RESTRICTION[worst]"),
    trace: outside("the tier file policy/night-policy.json is read in memory by the night; a classification leaves no row"),
  },
} satisfies RegionEvidence;
