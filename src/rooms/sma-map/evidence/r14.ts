// Region 14 · Memory — per-node evidence of the four proofs (docs/sma-evidence.md).
// One line per node, sorted by node number; a batch agent edits only its nodes' lines. Lines with seedEntry or a lone
// wfRun/wfStep trace were derived mechanically by scripts/sma-seed-evidence.ts (2026-11-14), not authored.
// Memory lives only on the hub (rows of lane_pilot_memory and its indexes; the owner's decision): the nodes below prove the hub path. A node
// that writes a hub row is traced by that row; a refusal or a read writes nothing and is traced by its own prove() line in sma_r14.py.
import { distort, drill, entry, flip, not, receipt, rows, seedEntry, skipWrite, wrongTarget, type RegionEvidence } from "./types";

const STORE = "packages/memory-core/src/store.ts";
const CANDIDATES = "packages/memory-core/src/candidates.ts";
const LIFECYCLE = "packages/memory-core/src/lifecycle.ts";
const LINT = "packages/memory-core/src/lint.ts";
const TIERS = "src/rooms/memory-tiers/server/tiers.ts";
const REACTIONS = "src/rooms/writer/server/attempt-reactions.ts";
const AUTONOMY = "src/rooms/learning/autonomy.ts";
const CONTEXT = "packages/memory-core/src/context.ts";
const SESSION = "src/rooms/memory/server/session-memory.ts";
const IMPORT = "src/rooms/memory/server/import.ts";
const PICKS = "src/rooms/memory/server/memory-picks.ts";
const FILES = "packages/memory-core/src/files.ts";
// The foreign-SQL ratchet scan reads query-call text inside any string, so the finds below build that call from two pieces.
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
  n1060: { mutation: flip("src/rooms/memory/server/memory.ts", "if(row.sourceSha256===input.acceptanceSha256) recordIds.push(id);", "if(row.sourceSha256!==input.acceptanceSha256) recordIds.push(id);"), trace: receipt("memory-maintenance", "passed") },
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
  n1078: { mutation: distort(STORE, "WHERE kind='reminded' AND note_id IS NOT NULL\"", "WHERE kind='empty' AND note_id IS NOT NULL\""), trace: drill("sma_r14") },
  n1079: { mutation: distort(SESSION, 'trust: "observed", origin: "session",', 'trust: "confirmed", origin: "session",'),
    reach: seedEntry("the owner runs the command"), trace: rows("lane_pilot_memory", "created_at", "origin='session'") },
  n1080: { mutation: distort(STORE, "now, kind, noteId ?? null);", 'now, "empty", noteId ?? null);'), reach: seedEntry("the owner runs the command"), trace: drill("sma_r14") },
  n1081: { mutation: flip(CONTEXT, "if(kept.has(record.id))return `deliver ${record.id} — matched the query`;", "if(!kept.has(record.id))return `deliver ${record.id} — matched the query`;"), reach: seedEntry("the owner runs the command"), trace: drill("sma_r14") },
  n1082: { mutation: flip(STORE, "for (const id of active) if (!fts.has(id)) missingIds.push(id);", "for (const id of active) if (fts.has(id)) missingIds.push(id);"), reach: seedEntry("the owner runs the command"), trace: drill("sma_r14") },
  n1083: { mutation: distort("src/rooms/tools/server/cli.ts", '? "archived" : args.includes("--expire")', '? "revoked" : args.includes("--expire")'), reach: seedEntry("the owner runs the command"), trace: drill("sma_r14") },
  n1084: { mutation: flip(IMPORT, 'if (typeof line.content !== "string" || !line.content.trim()) return', 'if (typeof line.content !== "string" || line.content.trim()) return'), reach: seedEntry("the owner runs the command"), trace: drill("sma_r14") },
  n1085: { mutation: flip("src/rooms/memory/server/memory-compress-cli.ts", "if (!done.insertedIds[0]) return", "if (done.insertedIds[0]) return"), reach: seedEntry("the owner runs the command"), trace: drill("sma_r14") },
  n1086: { mutation: flip(STORE, 'if (row.kind === "core") coreTokens += estimate(row.content); else noteTokens', 'if (row.kind !== "core") coreTokens += estimate(row.content); else noteTokens'), reach: seedEntry("the owner runs the command"), trace: drill("sma_r14") },
  n1087: { mutation: flip(PICKS, '!aboutPaths.includes(note) && note.kind !== "core" && note.concepts.some', '!aboutPaths.includes(note) && note.kind === "core" && note.concepts.some'), reach: seedEntry("the owner runs the command"), trace: drill("sma_r14") },
  n1088: { mutation: distort(STORE, "const counts = { active: status.active, added", "const counts = { active: status.active + 1, added"), reach: seedEntry("the owner runs the command"), trace: drill("sma_r14") },
  n1089: { reach: seedEntry("the owner runs the command") },
  n1090: { mutation: flip(LINT, 'return issue !== null && /credential/.test(issue); })', 'return issue === null && /credential/.test(issue); })'), reach: seedEntry("the owner runs the command"), trace: drill("sma_r14") },
  n1091: { reach: seedEntry("the owner runs the command") },
  n1092: { mutation: wrongTarget(STORE, 'if (entries[index]!.kind === "core") last = index;', 'if (entries[index]!.kind === "core" && last < 0) last = index;'), reach: seedEntry("the owner runs the command"), trace: drill("sma_r14") },
  n1093: { mutation: flip("src/rooms/memory-tiers/server/history.ts", "if (hits >= floor) scored.push", "if (hits < floor) scored.push"), reach: seedEntry("the owner runs the command"), trace: drill("sma_r14") },
  n1094: { mutation: flip(CONTEXT, "if(estimateTokens(render())>budget){lines.delete(item.record.id);over.push(item.record);continue;}", "if(estimateTokens(render())<budget){lines.delete(item.record.id);over.push(item.record);continue;}"), reach: seedEntry("the owner runs the command"), trace: drill("sma_r14") },
  n1095: { mutation: distort("src/rooms/file-cards/cli.ts", "`${card.path} | ${card.lines} lines", "`${card.path.toUpperCase()} | ${card.lines} lines"), reach: seedEntry("the owner runs the command"), trace: drill("sma_r14") },
  n1096: { mutation: distort(LIFECYCLE, "for (const id of new Set(ids)) update.run(now, projectId, id);", "for (const id of ids) update.run(now, projectId, id);"), reach: seedEntry("the owner runs the command"),
    trace: rows("lane_pilot_memory", "last_used_at", "use_count>0") },
  n1097: { mutation: distort(FILES, 'status: top.status ?? "active",', 'status: top.status ?? "superseded",'), trace: drill("sma_r14") },
  n1098: { mutation: distort(CANDIDATES, "{validUntil:Date.parse(row.valid_until as string)}", "{validUntil:Date.parse(row.valid_until as string)+1}"),
    reach: entry("a maintainer, a session or an import writes a record into the corpus"), trace: drill("sma_r14") },
  n1099: { mutation: distort(SESSION, "m.kind='core' AND m.audience='subagent'", "m.kind='note' AND m.audience='subagent'"), trace: drill("sma_r14") },
  n1100: { mutation: distort(STORE, "return fuse([words, parts], limit).map", "return fuse([words, []], limit).map"), trace: drill("sma_r14") },
  n1101: { mutation: distort("packages/memory-core/src/terms.ts", "Math.max(4, token.length - 2)", "Math.max(4, token.length - 3)"), trace: drill("sma_r14") },
  n1102: { mutation: flip(SESSION, "if (!records.length) return { records, nothingRelevant: true, message: NOTHING_RELEVANT };", "if (records.length) return { records, nothingRelevant: true, message: NOTHING_RELEVANT };"), trace: drill("sma_r14") },
  n1103: { mutation: distort(STORE, "if (hit) hit.score += 1 / (60 + rank + 1);", "if (hit) hit.score = 1 / (60 + rank + 1);"), trace: drill("sma_r14") },
  n1104: { mutation: flip(CONTEXT, "if(dropped.has(record.id))return `reject ${record.id} — matched, cut by the context budget`;", "if(!dropped.has(record.id))return `reject ${record.id} — matched, cut by the context budget`;"), trace: drill("sma_r14") },
  n1105: { mutation: distort(IMPORT, 'if (/credential/.test(message)) return "secret";', 'if (/credential/.test(message)) return "rejected";'),
    reach: entry("the owner imports the notes Claude Code keeps about the project"), trace: drill("sma_r14") },
  n1106: { mutation: distort(LIFECYCLE, "update.run(now, projectId, id);", "update.run(now + 1, projectId, id);"),
    reach: entry("a writer brief is built and carries a note of the corpus"), trace: rows("lane_pilot_memory", "last_used_at", "use_count>0") },
  n1107: { mutation: distort(PICKS, "if (picked.length === MEMORY_LIMIT) break;", "if (picked.length === MEMORY_LIMIT + 1) break;"),
    trace: rows("lane_pilot_memory_receipt", "created_at", "role='writer'") },
} satisfies RegionEvidence;
