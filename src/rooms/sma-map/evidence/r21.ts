// Region 21 · sma-tools: project queries — per-node evidence of the four proofs (docs/sma-evidence.md).
// One line per node, sorted by node number; a batch agent edits only its nodes' lines. Lines with seedEntry or a lone
// wfRun/wfStep trace were derived mechanically by scripts/sma-seed-evidence.ts (2026-11-14), not authored.
// The query tools of this region read the project's state (phases, roadmap, settings, capabilities, code facts) and write nothing to the hub
// database (n1585 writes one memory note the scene reads back), so the node-level trace is the region scene sma_r21: it runs the real verbs
// and functions of the commit under drill on a scratch database, a fixture planning folder and a scratch git repo. No model, no hub write.
import { distort, drill, entry, flip, type RegionEvidence, seedEntry, voidStays } from "./types";

const INSPECT = "src/rooms/phase/server/driver-methods-inspect.ts";
const STAGES = "src/rooms/phase/stages.ts";
const ROLES = "packages/models/src/role-models.ts";
const SCENE = drill("sma_r21");
const BY_VERB = "the owner or a PM runs in a shell: bb lane-pilot";

export default {
  n1560: { mutation: flip("src/rooms/tools/server/cli-commands.ts", ".filter((c) => !new RegExp(", ".filter((c) => new RegExp("), reach: entry("the owner or a PM types bb lane-pilot with a verb, or with an unknown one"), trace: SCENE },
  n1561: { mutation: distort("src/rooms/tools/server/cli.ts", 'name:"lane-pilot",', 'name:"lane-pilot-x",'), reach: entry("the owner or a PM runs bb lane-pilot <verb> from any shell block"), trace: SCENE },
  n1562: { voidReview: voidStays("удобство разбора команды sma-tools («state.update» и «state update»); глаголы Lane Pilot — одно слово, шаги графа — типизированные действия, сопоставлять нечего") },
  n1563: { mutation: flip(INSPECT, "sections.Decisions = [...own.Decisions ?? [], `${STATE_MANUAL}", "sections.Decisions = [...[], `${STATE_MANUAL}"), reach: entry(`${BY_VERB} phase state <phase-id>`), trace: SCENE },
  n1564: { mutation: flip(STAGES, "if (line.trim().match(ROW) || /^#{1,6}\\s/.test(line.trim())) break;", "if (line.trim().match(ROW) && /^#{1,6}\\s/.test(line.trim())) break;"), reach: entry(`${BY_VERB} phase roadmap <phase-id> [row]`), trace: SCENE },
  n1565: { mutation: distort("src/rooms/phase/store.ts", "VALUES(?,?,?,?,?,?,'discussion','active','{}',?,?)", "VALUES(?,?,?,?,?,?,'planning','active','{}',?,?)"), reach: entry("a PM opens a phase for the owner's heavy request (lane_pilot_phase open)"), trace: SCENE },
  n1566: { mutation: distort(STAGES, 'failed: rows.filter((row) => row[1] === "!")', 'failed: rows.filter((row) => row[1] !== "!")'), reach: entry("the owner says yes to the UAT of a phase whose UAT.md has checkboxes only"), trace: SCENE },
  n1567: { mutation: flip("src/rooms/phase/logic/next-action.ts", 'if (verdict?.state === "failed") return', 'if (verdict?.state !== "failed") return'), reach: entry(`${BY_VERB} phase show <phase-id>, or a PM reads the phase status`), trace: SCENE },
  n1568: { mutation: flip("src/rooms/phase/server/auto-stages.ts", 'material: r.drawMaterial === "on",', 'material: r.drawMaterial !== "on",'), reach: entry("the phase driver starts a stage's workflow and hands it the phase's inputs"), trace: SCENE },
  n1569: { mutation: flip(ROLES, "if (row.least && belowTier(modelTier(model), row.least)) { escalated = true; continue; }", "if (row.least && !belowTier(modelTier(model), row.least)) { escalated = true; continue; }"), reach: entry("a graph's agent step names a role and the harness asks which model the role runs on"), trace: SCENE },
  n1570: { mutation: distort(ROLES, '{ id: "analyst", default: { model: "claude-opus-5-5"', '{ id: "analyst", default: { model: "claude-sonnet-5-5"'), reach: entry("the owner opens the role table in settings, or an agent step resolves its role"), trace: SCENE },
  n1571: { mutation: flip("src/rooms/writer/server/skill-pick.ts", ".filter((name) => names.has(name)).slice(0, SKILL_HINT_LIMIT);", ".filter((name) => !names.has(name)).slice(0, SKILL_HINT_LIMIT);"), reach: entry("a writer attempt spawns for a task whose contract names skills"), trace: SCENE },
  n1572: { mutation: flip("src/rooms/docs/git-docs.ts", 'if (!staged) return { status:"nothing" as const', 'if (staged) return { status:"nothing" as const'), reach: entry("the phase driver or the nightly docs pass commits the documents it wrote"), trace: SCENE },
  n1573: { mutation: flip("src/rooms/settings/setting-validation.ts", "parsed < 1 || parsed > 3) {", "parsed < 1 || parsed > 4) {"), reach: entry("the owner saves a setting in the settings window, or a PM saves one through the settings tool"), trace: SCENE },
  n1574: { mutation: flip(STAGES, "...items.filter((item) => item.wave === wave).map((item) => [", "...items.filter((item) => item.wave !== wave).map((item) => ["), reach: entry("a phase's plan is admitted and its PLAN.md is written from the pieces"), trace: SCENE },
  n1575: { mutation: flip("src/rooms/docs/docs-lint.ts", "if (at < 0) { lines.push(line); return null; }", "if (at <= 0) { lines.push(line); return null; }"), reach: entry(`${BY_VERB} frontmatter <project> <file> [--set k=v] [--merge k=a,b]`), trace: SCENE },
  n1576: { mutation: flip("src/rooms/phase/logic/gates.ts", "if (task.id !== item.id) why.push(", "if (task.id === item.id) why.push("), reach: entry(`a PM submits a phase's plan, or ${BY_VERB} phase show <phase-id>`), trace: SCENE },
  n1577: { mutation: distort("src/rooms/phase/logic/waves.ts", "[...new Set(items.map((item) => item.wave))].sort((a, b) => a - b);", "[...new Set(items.map((item) => item.wave))].sort((a, b) => b - a);"), reach: entry("the phase driver issues the pieces of an admitted plan wave by wave"), trace: SCENE },
  n1578: { reach: seedEntry("the owner runs the command"), voidReview: voidStays("крючки отрисовки обслуживали убранный цикл (2026-10-30); точки расширения Lane Pilot — фиксированные шаги графа вроде lp.after-accept, правятся в самом графе") },
  n1579: { mutation: distort("src/rooms/native-install/feature-registry.ts", "agents: { claude: [id], opencode: [id] },", "agents: { claude: [id], opencode: [] },"), reach: entry("the atlas generator or the install check reads the feature registry"), trace: SCENE },
  n1580: { mutation: distort("scripts/atlas/logic.ts", "{ capabilities: input.capabilities, streams:", "{ capabilities: input.capabilities.slice(1), streams:"), reach: entry("the owner or the publish gate runs the atlas generator (npx tsx scripts/generate-atlas.ts)"), trace: SCENE },
  n1581: { voidReview: voidStays("это самоописание SMA для её реестра возможностей, загрузчика здесь нет; Lane Pilot описывают созданный атлас и манифест плагина") },
  n1582: { mutation: flip("src/rooms/capability/server/cli.ts", 'includes("not_supported")) ? 1 : 0', 'includes("supported")) ? 1 : 0'), reach: entry(`${BY_VERB} capabilities [--probe]`), trace: SCENE },
  n1583: { mutation: flip("src/rooms/runs/ui/run-card.tsx", '.filter((state) => state === "accepted").length;', '.filter((state) => state !== "accepted").length;'), reach: entry("a PM message carries the ::lane-run directive and the owner reads the chat"), trace: SCENE },
  n1584: { mutation: distort(INSPECT, 'state: "open", line });', 'state: "failed", line });'), reach: entry(`${BY_VERB} phase uat [--project <id>]`), trace: SCENE },
  n1585: { mutation: flip("src/rooms/phase/server/driver-journal.ts", 'const error = decision === "yes" ? writeLesson(phase, draft.text) : null;', 'const error = decision === "no" ? writeLesson(phase, draft.text) : null;'), reach: entry("the owner says yes to the lesson draft of a closed phase"), trace: SCENE },
  n1586: { mutation: flip("src/rooms/platform/code-facts.ts", 'if ((head && last && head === last) || behind === "0")', 'if ((head && last && head !== last) || behind === "0")'), reach: entry(`${BY_VERB} intel <project> [--refresh]`), trace: SCENE },
  n1587: { mutation: flip(STAGES, "if (num > prev + 1) findings.push(", "if (num > prev + 2) findings.push("), reach: entry(`${BY_VERB} phase validate <phase-id>`), trace: SCENE },
  n1588: { mutation: flip("src/rooms/phase/server/driver-methods-admission.ts", ".find((phase) => phase.record.roadmapRow === input.roadmapRow);", ".find((phase) => phase.record.roadmapRow !== input.roadmapRow);"), reach: entry("a PM opens a second phase on a different roadmap row while the first runs"), trace: SCENE },
  n1589: { voidReview: voidStays("единственный вызывающий — старый update.md, который SMA сама не подключила (n1788 upstream); обновление плагина ведут задачи установки BB") },
} satisfies RegionEvidence;
