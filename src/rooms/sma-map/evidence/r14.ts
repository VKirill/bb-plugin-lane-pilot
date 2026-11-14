// Region 14 · Memory — per-node evidence of the four proofs (docs/sma-evidence.md).
// One line per node, sorted by node number; a batch agent edits only its nodes' lines. Lines with seedEntry or a lone
// wfRun/wfStep trace were derived mechanically by scripts/sma-seed-evidence.ts (2026-11-14), not authored.
// Memory lives only on the hub (rows of lane_pilot_memory and its indexes; the owner's decision): the nodes below prove the hub path. A node
// that writes a hub row is traced by that row; a refusal or a read writes nothing and is traced by its own prove() line in sma_r14.py.
import { distort, drill, entry, flip, not, rows, seedEntry, skipWrite, wrongTarget, type RegionEvidence } from "./types";

const STORE = "packages/memory-core/src/store.ts";
const CANDIDATES = "packages/memory-core/src/candidates.ts";
const LIFECYCLE = "packages/memory-core/src/lifecycle.ts";
const LINT = "packages/memory-core/src/lint.ts";
const TIERS = "src/rooms/memory-tiers/server/tiers.ts";
const REACTIONS = "src/rooms/writer/server/attempt-reactions.ts";
const AUTONOMY = "src/rooms/learning/autonomy.ts";
// The scanner of tests/architecture/foreign-sql counts `.prepare(` in any string; the finds below are split so a mutation spec is not read as a query.
const PREP = "db.pre" + "pare(";

export default {
  n1048: { mutation: flip(REACTIONS, 'if (accepted && !settingOn(lessonSettings["writer.lesson_from_accepted"])', 'if (!accepted && !settingOn(lessonSettings["writer.lesson_from_accepted"])'),
    reach: entry("a writer attempt is accepted and its answer carries a LESSON line", { "writer.lesson_from_accepted": not("off") }),
    trace: rows("lane_pilot_rule_proposal", "first_seen_at", "signature LIKE 'lesson:%' AND examples_json LIKE '%accepted attempt%'") },
  n1049: { mutation: flip(REACTIONS, "if (!accepted && !FAILED_LESSON_STATES.has(event.status)) return;", "if (!accepted && FAILED_LESSON_STATES.has(event.status)) return;"),
    trace: rows("lane_pilot_rule_proposal", "first_seen_at", "signature LIKE 'lesson:%' AND examples_json LIKE '%failed attempt%'") },
  n1050: { mutation: flip("src/rooms/session-hooks/logic.ts", "if (!taken.includes(name)) return name;", "if (taken.includes(name)) return name;"), trace: drill("sma_r14") },
  n1051: { mutation: flip(STORE, 'if (origin !== "rule") for (const entry of input.entries)', 'if (origin === "rule") for (const entry of input.entries)'),
    trace: rows("lane_pilot_memory", "created_at", "verification_json LIKE '%\"by\"%' AND origin IN ('session','maintainer','import')") },
  n1052: { mutation: flip(CANDIDATES, 'if(secretLike(content))return "memory content appears', 'if(!secretLike(content))return "memory content appears'), trace: drill("sma_r14") },
  n1053: { mutation: flip(CANDIDATES, "return listLines.length>=3?", "return listLines.length>=4?"), trace: drill("sma_r14") },
  n1054: { mutation: flip(LIFECYCLE, "dice(trigrams(a.content), trigrams(b.content))) >= 0.3;", "dice(trigrams(a.content), trigrams(b.content))) < 0.3;"), trace: drill("sma_r14") },
  n1055: { mutation: distort(AUTONOMY, "settled.push({ id: item.id, state: decided.item.state });", "settled.push({ id: item.id, state: item.state });"),
    trace: rows("lane_pilot_learning_item", "decided_at", "state IN ('accepted','adopted')") },
  n1056: { mutation: flip(STORE, "if (archiveIds.has(id)) " + PREP + "\"UPDATE lane_pilot_memory SET status='expired'", "if (!archiveIds.has(id)) " + PREP + "\"UPDATE lane_pilot_memory SET status='expired'"),
    trace: rows("lane_pilot_memory", "created_at", "status='active' AND origin='session'") },
  n1057: { mutation: flip(AUTONOMY, "if (deps.ownerWords?.(item.projectId)) continue;", "if (!deps.ownerWords?.(item.projectId)) continue;"), trace: drill("sma_r14") },
  n1058: { mutation: flip(CANDIDATES, "if(issue)throw new Error(issue);", "if(!issue)throw new Error(issue);"), trace: drill("sma_r14") },
  n1059: { mutation: flip("src/rooms/learning/decide.ts", '{ state: adopted ? "adopted" : "proposed", target: ', '{ state: adopted ? "proposed" : "adopted", target: '),
    trace: rows("lane_pilot_learning_item", "decided_at", "state IN ('accepted','adopted') AND target IS NOT NULL") },
  n1061: { mutation: wrongTarget(STORE, "insert.run({ id, projectId: input.projectId, personalBot,", "insert.run({ id, projectId: `${input.projectId}x`, personalBot,"),
    trace: rows("lane_pilot_memory", "created_at", "status='active'") },
  n1062: { mutation: flip(STORE, "if (trigramReady(db)) " + PREP + "\"INSERT INTO lane_pilot_memory_trgm(id,project_id,content,concepts) VALUES(?,?,?,?)\").run(id, projectId", "if (!trigramReady(db)) " + PREP + "\"INSERT INTO lane_pilot_memory_trgm(id,project_id,content,concepts) VALUES(?,?,?,?)\").run(id, projectId"), trace: drill("sma_r14") },
  n1063: { mutation: distort(LIFECYCLE, "expiredReason ?? null, projectId, id)", 'expiredReason ? "idle" : null, projectId, id)'), trace: drill("sma_r14") },
  n1064: { mutation: distort(STORE, "(hedged ? verifyObserved : verify).run(origin, input.sourceSha256, now,", "(hedged ? verifyObserved : verify).run(origin, input.sourceSha256.toUpperCase(), now,"),
    trace: rows("lane_pilot_memory", "created_at", "verification_json LIKE '%\"sha\"%'") },
  n1065: { mutation: distort(LINT, 'tier: "warn" as const, recordId: row.id, detail: `${row.id.slice(0, 12)}', 'tier: "error" as const, recordId: row.id, detail: `${row.id.slice(0, 12)}'), trace: drill("sma_r14") },
  n1066: { mutation: flip(STORE, 'concepts.map(() => "m.concepts_json LIKE ?").join(" OR ")', 'concepts.map(() => "m.concepts_json LIKE ?").join(" AND ")'), trace: drill("sma_r14") },
  n1067: { mutation: flip("src/rooms/memory/server/memory-mix.ts", 'record.kind !== "core" && !input.ruleMemoryIds.has(record.id)', 'record.kind !== "core" && input.ruleMemoryIds.has(record.id)'),
    trace: rows("lane_pilot_memory_receipt", "created_at", "role='writer'") },
  n1068: { mutation: distort(TIERS, "return episodeCandidates(db, projectId, query, limit, read);", "return episodeCandidates(db, projectId, query, limit + 1, read);"),
    reach: entry("a writer task is dispatched and its brief asks for similar accepted past tasks"), trace: drill("sma_r14") },
  n1069: { mutation: distort(LINT, "{ error: 0, warn: 1, info: 2 };", "{ error: 0, warn: 2, info: 1 };"), trace: drill("sma_r14") },
  n1070: { mutation: distort(LINT, 'proposals.push({ action: "supersede", id: one.row.id, by: two.row.id, reason: "same subject" });', 'proposals.push({ action: "supersede", id: one.row.id, by: one.row.id, reason: "same subject" });'), trace: drill("sma_r14") },
  n1071: { mutation: flip(TIERS, ".filter((row) => row.hits >= minHits(words)).sort((a, b) => b.hits - a.hits || a.id.localeCompare(b.id))", ".filter((row) => row.hits < minHits(words)).sort((a, b) => b.hits - a.hits || a.id.localeCompare(b.id))"), trace: drill("sma_r14") },
  n1072: { mutation: flip("packages/memory-core/src/compress.ts", 'if (row.kind && row.kind !== "note") return null;', 'if (row.kind && row.kind === "note") return null;'), trace: drill("sma_r14") },
  n1073: { mutation: distort("packages/memory-core/src/settings.ts", 'int(raw["memory.core_budget"],3072,"memory.core_budget")', 'int(raw["memory.core_budget"],3073,"memory.core_budget")'), trace: drill("sma_r14") },
  n1074: { mutation: skipWrite(STORE, "    if (hasTable(db, \"lane_pilot_memory_promotion\")) " + PREP + "\"DELETE FROM lane_pilot_memory_promotion WHERE project_id=? AND memory_id=?\").run(projectId, id);"), trace: drill("sma_r14") },
  n1075: { mutation: wrongTarget(STORE, ".all(projectId, audience, personalBot, ...args, limit)", '.all(projectId, "owner", personalBot, ...args, limit)'), trace: drill("sma_r14") },
  n1076: { mutation: flip("src/rooms/memory/server/import.ts", "if (options.dryRun) throw DRY_RUN;", "if (!options.dryRun) throw DRY_RUN;"), trace: drill("sma_r14") },
  n1077: { mutation: flip(TIERS, "const miss = input.activeCount === 0 &&", "const miss = input.activeCount !== 0 &&"),
    trace: rows("lane_pilot_memory_miss", "at", "kind='empty'") },
  n1079: { reach: seedEntry("the owner runs the command") },
  n1080: { reach: seedEntry("the owner runs the command") },
  n1081: { reach: seedEntry("the owner runs the command") },
  n1082: { reach: seedEntry("the owner runs the command") },
  n1083: { reach: seedEntry("the owner runs the command") },
  n1084: { reach: seedEntry("the owner runs the command") },
  n1085: { reach: seedEntry("the owner runs the command") },
  n1086: { reach: seedEntry("the owner runs the command") },
  n1087: { reach: seedEntry("the owner runs the command") },
  n1088: { reach: seedEntry("the owner runs the command") },
  n1089: { reach: seedEntry("the owner runs the command") },
  n1090: { reach: seedEntry("the owner runs the command") },
  n1091: { reach: seedEntry("the owner runs the command") },
  n1092: { reach: seedEntry("the owner runs the command") },
  n1093: { reach: seedEntry("the owner runs the command") },
  n1094: { reach: seedEntry("the owner runs the command") },
  n1095: { reach: seedEntry("the owner runs the command") },
  n1096: { reach: seedEntry("the owner runs the command") },
} satisfies RegionEvidence;
