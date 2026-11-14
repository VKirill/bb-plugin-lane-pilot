// Region 8 · Daemon front outside the graphs — per-node evidence of the four proofs (docs/sma-evidence.md).
// One line per node, sorted by node number; a batch agent edits only its nodes' lines. Lines with seedEntry or a lone
// wfRun/wfStep trace were derived mechanically by scripts/sma-seed-evidence.ts (2026-11-14), not authored.
import { distort, drill, entry, flip, wrongTarget, type RegionEvidence, voidIsHave, voidStays } from "./types";

// Batch a (n674–n702): the door, the window, the roster and the helper import write no hub table row (the journal and the conveyor are plugin KV, the drafts
// go to a machine), so each node's trace is its own prove() line in scripts/lp_drill/scenes/sma_r08.py. Later batches append their nodes to the same scene.
// Core-resident (a `core:` anchor, nothing to mutate here): n673, n676, n677, n679, n680, n681, n693, n694.
const SCENE = drill("sma_r08");

export default {

  n674: { mutation: wrongTarget("src/rooms/contracts/index.ts", "  ...rpcWorkflowMap,", "  ...rpcWorkflowExport,"), trace: SCENE },
  n675: { mutation: flip("src/rooms/contracts/rpc-ops.ts", "halt_run: {\n    input: z.object({ runId: z.string().min(1) }).strict(),", "halt_run: {\n    input: z.object({ runId: z.string() }).strict(),"), trace: SCENE },
  n678: { mutation: flip("src/rooms/runs/server/task-reconcile.ts", "graceMs:startup ? 0 : PERIODIC_INTENT_GRACE_MS", "graceMs:startup ? PERIODIC_INTENT_GRACE_MS : 0"), trace: SCENE },
  n682: { mutation: flip("src/rooms/front/server/index.ts", "if (!MUTATING_RPC.test(name)) return;", "if (MUTATING_RPC.test(name)) return;"), trace: SCENE },
  n683: { mutation: flip("src/rooms/core/server/rpc-timing.ts", '${refused ? " refused" : failed ? " failed" : ""}', '${refused ? " failed" : failed ? " refused" : ""}'), trace: SCENE },
  n684: { mutation: distort("app.tsx", 'path: "lane-pilot-cockpit",', 'path: "lane-pilot-cockpit-x",'), trace: SCENE },
  n685: { mutation: distort("package.json", '"app": "./app.tsx"', '"app": "./app.css"'), trace: SCENE },
  n686: { mutation: distort("src/rooms/pages/tabs-model.ts", 'monitor: { tab: "runs", segment: "board" },', 'monitor: { tab: "runs", segment: "service" },'), reach: entry("the owner opens an old Lane Pilot link or a saved tab id from before the regroup"), trace: SCENE },
  n687: { mutation: distort("packages/host-calls/src/run-on-host.ts", "(args.timeoutSec + 5) * 1000", "(args.timeoutSec + 50) * 1000"), trace: SCENE },
  n688: { mutation: distort("src/rooms/contracts/host/machine.ts", "  readUsageWindows: {", "  task_word: {"), trace: SCENE },
  n689: { mutation: wrongTarget("src/rooms/writer/server/writer-host.ts", "[...new Set([...MAIN_AGENT_PROFILE_IDS, ...Object.keys(owned)])]", "[...new Set([...Object.keys(owned), ...MAIN_AGENT_PROFILE_IDS])]"), trace: SCENE },
  n690: { mutation: flip("packages/models/src/model-profiles.ts", "entry === key ||", "entry !== key ||"), trace: SCENE },
  n691: { mutation: flip("src/rooms/contracts/native-agent-static.ts", "return (MAIN_AGENT_PROFILE_IDS as readonly string[]).includes(id);", "return !(MAIN_AGENT_PROFILE_IDS as readonly string[]).includes(id);"), trace: SCENE },
  n692: { mutation: distort("src/rooms/writer/server/writer-task.ts", 'context.skills.join(", ")', 'context.skills.join(" ")'), trace: SCENE },
  n695: { mutation: distort("src/rooms/contracts/helper-context.ts", 'skills: ["lp-writer", "karpathy-guidelines"], mcpServers: ["gitnexus"] };', 'skills: ["lp-writer", "karpathy-guidelines"], mcpServers: ["metamcp"] };'), trace: SCENE, voidReview: voidIsHave("реестр подключений MCP на машине держат BB и MetaMCP; какие серверы получает роль, задаёт профиль роли (mcpServers, обязательные серверы), переключатель — n696") },
  n696: { mutation: flip("src/rooms/contracts/helper-context.ts", 'out[group] = mode === "allow"', 'out[group] = mode !== "allow"'), trace: SCENE },
  n697: { mutation: flip("src/rooms/runs/conveyor.ts", "else if ((await conveyorState(kv)).on) await kv.set", "else if (!(await conveyorState(kv)).on) await kv.set"), trace: SCENE },
  n698: { mutation: flip("src/rooms/usage/server/attempt-metrics.ts", 'rows.filter((row) => row.state === "accepted").map', 'rows.filter((row) => row.state !== "accepted").map'), trace: SCENE },
  n699: { mutation: flip("src/rooms/front/logic.ts", 'const kind = skill ? "skill" : "agent";', 'const kind = skill ? "agent" : "skill";'), trace: SCENE },
  n700: { mutation: distort("src/rooms/front/logic.ts", 'path.startsWith(".opencode/") ? "opencode"', 'path.startsWith(".opencode/") ? "claude"'), trace: SCENE },
  n701: { mutation: flip("src/rooms/front/server/index.ts", 'const path = helper.kind === "skill" ?', 'const path = helper.kind !== "skill" ?'), trace: SCENE },
  n702: { mutation: flip("src/rooms/front/server/index.ts", 'written.status === "conflict" ?', 'written.status !== "conflict" ?'), reach: entry("the owner picks the project's own helpers in the window and takes them as drafts"), trace: SCENE },
  n703: { voidReview: voidStays("блока домохозяйства нет: машины и единственный хаб принадлежат ядру BB, плагин берёт hostId у BB, и поведения от самообъявленной роли нет") },
  n710: { voidReview: voidStays("нет адреса, приходящего от пира: хосты приходят из регистрации BB, единственный внешний адрес events.webhook_url задаёт владелец (только https), SSRF-входа нет") },
  n714: { voidReview: voidIsHave("назначение «на пира можно передать только разрешённые действия» выполняет закрытый контракт хоста: фиксированный список методов, слова ворот в него не входят (n688)") },
  n744: { voidReview: voidStays("по собственной карте SMA значение стиля осталось без экрана и никем не читается; факты стиля живут в DESIGN.md") },
  n750: { voidReview: voidIsHave("публикация требует квитанции зелёного полного прогона, ключённой по дереву и версии node и лежащей на диске (переживает рестарт), — предела SMA «только в памяти» нет") },
} satisfies RegionEvidence;
