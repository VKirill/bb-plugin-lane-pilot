/**
 * Every way project memory, rules and lessons reach an agent (SMA block 4, «Memory you can prove», P0-3).
 *
 * Why a registry: Matvey Maslov's system carried zero lessons through one delivery path for three months and nobody saw it,
 * because nothing asked each path whether it delivers. Here each path is named once, with the code sites that inject
 * for it, and
 *  - `tests/memory-paths.test.ts` scans the source for the injection helpers (`MEMORY_PRIMITIVES`) and fails when a call
 *    appears (or disappears) without an entry here: a new reader of memory cannot ship unregistered;
 *  - `bb lane-pilot memory-probe` (src/rooms/memory-probe/server/memory-probe.ts) writes a note, a core note and a rule that carry
 *    a unique token through the one write door and asks every `probed` path for what its agent would receive;
 *  - the drill scenario `memory_paths` (scripts/lp-drill.py) runs the probe and then checks the real writer brief and the real PM
 *    prompt in their thread logs. (2026-10-29) the Lane Stack terminal (`lane-memory`) is not a consumer.
 * A path that cannot be probed is `exempt` with the reason; the reason is the entry's point.
 */

/** What a probe plants: a note naming a path, a core convention, and a rule that is always on. */
export type ProbeKind = "note" | "core" | "rule";

export type MemoryPath = {
  id: string;
  /** Who reads it, in a phrase. */
  consumer: string;
  /** The kinds of record the positive probe must find in the agent's input. */
  carries: readonly ProbeKind[];
  /** Kinds this path hands to every task by design, so the negative probe (an unrelated query) is allowed to find them. */
  alwaysOn: readonly ProbeKind[];
  /** Where the code injects: `count` calls of `primitive` in `file`. */
  sites: ReadonlyArray<{ file: string; primitive: MemoryPrimitive; count: number }>;
  /** probed: the probe asks the path; exempt: reason says why not. */
  status: "probed" | "exempt";
  reason?: string;
  /** How the drill checks the real thing besides the probe. */
  live?: "writer-brief" | "pm-prompt";
};

/** The functions that put memory, rules or owner facts in front of an agent (or fetch them for one). The scan in the test counts their calls. */
export const MEMORY_PRIMITIVES = [
  "writerKnowledge", "writerRules", "stickyTurnPromptWithRules", "mixWriterMemory", "mixReviewerMemory", "reviewerMemoryFor", "writerContextBlocks",
  "pmRulesPromptBlock", "pmRulesBlock", "pmRulesOf", "pmResumeInstructions", "contributeInstructions", "ownerCardBlock",
  "pmMemoryContext", "councilMemoryBlock", "searchMemoryRecords", "listMemory", "memoryContext", "acceptedRules",
  "session_memory_search", "session_memory_core", "enrichMemoryContext",
] as const;
export type MemoryPrimitive = (typeof MEMORY_PRIMITIVES)[number];

export const MEMORY_PATHS: readonly MemoryPath[] = [
  { id: "writer.brief", consumer: "a writer's first prompt (spawnWriterAttempt)", carries: ["note", "core", "rule"], alwaysOn: ["core", "rule"], status: "probed", live: "writer-brief",
    sites: [
      { file: "src/rooms/writer/server/spawn.ts", primitive: "writerKnowledge", count: 1 },
      { file: "src/rooms/writer/server/writer-knowledge.ts", primitive: "writerRules", count: 1 },
      { file: "src/rooms/writer/server/writer-knowledge.ts", primitive: "acceptedRules", count: 1 },
      { file: "src/rooms/writer/server/writer-knowledge.ts", primitive: "mixWriterMemory", count: 1 },
      { file: "src/rooms/memory/server/memory-mix.ts", primitive: "searchMemoryRecords", count: 1 },
      { file: "src/rooms/memory/server/memory-mix.ts", primitive: "listMemory", count: 1 },
    ] },
  { id: "writer.turn", consumer: "the turn that gives a continuing writer thread its next task (stickyTurnPrompt)", carries: ["rule"], alwaysOn: ["rule"], status: "probed",
    sites: [
      { file: "src/rooms/writer/server/start-writer-task.ts", primitive: "stickyTurnPromptWithRules", count: 1 },
      { file: "src/rooms/writer/server/writer-knowledge.ts", primitive: "writerRules", count: 1 },
    ] },
  { id: "writer.repair", consumer: "the code-critique repair round (the dispatch context of the first brief, kept in the attempt trace)", carries: ["note", "core", "rule"], alwaysOn: ["core", "rule"], status: "probed",
    sites: [{ file: "src/rooms/writer/server/critique-gate.ts", primitive: "writerContextBlocks", count: 1 }] },
  { id: "pm.start", consumer: "a PM's first prompt (activation)", carries: ["rule"], alwaysOn: ["rule"], status: "probed", live: "pm-prompt",
    sites: [
      { file: "src/rooms/native-agent/server/activation.ts", primitive: "pmRulesPromptBlock", count: 1 },
      { file: "src/rooms/learning/pm-rules.ts", primitive: "pmRulesBlock", count: 3 },
      { file: "src/rooms/learning/pm-rules.ts", primitive: "pmRulesOf", count: 2 },
    ] },
  { id: "pm.resume", consumer: "a PM session that starts or resumes (contributeInstructions)", carries: ["rule"], alwaysOn: ["rule"], status: "probed",
    sites: [
      { file: "src/rooms/learning/service.ts", primitive: "contributeInstructions", count: 1 },
      { file: "src/rooms/learning/service.ts", primitive: "pmResumeInstructions", count: 1 },
    ] },
  { id: "bb.thread", consumer: "every ordinary BB thread of the project (contributeInstructions, the L1 showcase)", carries: ["core"], alwaysOn: [], status: "probed",
    sites: [{ file: "src/rooms/memory/server/thread-block.ts", primitive: "contributeInstructions", count: 1 }] },
  { id: "pm.rules_tool", consumer: "the PM tool lane_pilot_memory {action:\"learned\", op:\"rules\"}", carries: ["rule"], alwaysOn: ["rule"], status: "probed",
    sites: [{ file: "src/rooms/learning/service.ts", primitive: "pmRulesOf", count: 1 }] },
  { id: "pm.contract", consumer: "path-scoped rules returned with a queued task contract", carries: ["rule"], alwaysOn: [], status: "exempt",
    reason: "Handed back on the dispatch reply for the task's paths. Startup and resume do not pass paths, so a path selector stays quiet there.",
    sites: [{ file: "src/rooms/writer/server/dispatch.ts", primitive: "pmRulesOf", count: 1 }] },
  { id: "pm.memory_tool", consumer: "the PM tool lane_pilot_memory {action:\"context\"}", carries: ["note", "core"], alwaysOn: [], status: "probed",
    sites: [
      { file: "src/rooms/memory/server/memory.ts", primitive: "pmMemoryContext", count: 1 },
      { file: "src/rooms/memory/server/memory-mix.ts", primitive: "memoryContext", count: 1 },
      { file: "src/rooms/memory/server/memory-mix.ts", primitive: "searchMemoryRecords", count: 1 },
    ] },
  { id: "schedule.agent", consumer: "the first message of a scheduled agent run (kind agent of the schedule board): the project's notes for the standing task", carries: ["note", "core"], alwaysOn: [], status: "probed",
    sites: [{ file: "src/rooms/memory/server/memory-mix.ts", primitive: "pmMemoryContext", count: 1 }] },
  { id: "critic.code", consumer: "the code critic's prompt (critique-runs)", carries: ["note", "core"], alwaysOn: ["core"], status: "probed",
    sites: [{ file: "src/rooms/critique/server/critique-runs/code-critique.ts", primitive: "reviewerMemoryFor", count: 1 }] },
  { id: "night.review", consumer: "the night review's prompt", carries: ["note", "core"], alwaysOn: ["core"], status: "probed",
    sites: [
      { file: "src/rooms/memory/server/memory-mix.ts", primitive: "mixReviewerMemory", count: 1 },
      { file: "src/rooms/memory/server/memory-mix.ts", primitive: "searchMemoryRecords", count: 1 },
      { file: "src/rooms/memory/server/memory-mix.ts", primitive: "listMemory", count: 2 },
    ] },
  { id: "council.evidence", consumer: "the evidence pack of a council of directors", carries: ["note", "core"], alwaysOn: [], status: "probed",
    sites: [
      { file: "src/rooms/council/server/council-graph.ts", primitive: "councilMemoryBlock", count: 1 },
      { file: "src/rooms/council/server/council.ts", primitive: "searchMemoryRecords", count: 1 },
      { file: "src/rooms/council/server/council.ts", primitive: "memoryContext", count: 1 },
    ] },
  { id: "hub.memory_import_eval", consumer: "the M1 import gate (RPC memory_import_eval): measures how many imported records the PM search finds", carries: [], alwaysOn: [], status: "exempt",
    reason: "A measurement over the import receipt, read by the operator; nothing it finds reaches an agent prompt.",
    sites: [{ file: "src/rooms/memory/server/import.ts", primitive: "searchMemoryRecords", count: 1 }] },
  { id: "hub.session_rpc", consumer: "the hub session_memory RPCs, not a Lane Pilot agent prompt", carries: [], alwaysOn: [], status: "exempt",
    reason: "The RPCs answer `bb lane-pilot memory search|write` (an agent's shell command, M2 rule): the agent reads the answer as command output, not as injected prompt text.",
    sites: [
      { file: "src/rooms/memory/server/session-memory.ts", primitive: "session_memory_search", count: 1 },
      { file: "src/rooms/tools/server/cli.ts", primitive: "session_memory_search", count: 1 },
      { file: "src/rooms/memory/server/session-memory.ts", primitive: "session_memory_core", count: 1 },
      { file: "src/rooms/memory/server/session-memory.ts", primitive: "searchMemoryRecords", count: 1 },
    ] },
  { id: "hook.prompt_recall", consumer: "the pointers the session hook prints under a prompt (`bb lane-pilot memory search --recall`, confirmedWordHits)", carries: [], alwaysOn: [], status: "exempt",
    reason: "Confirmed notes of the caller's own project by the word index only, masked, one line each, three at most; the probe asks the PM and writer prompts, not a hook's context line (tests/sma/parity-g2-hooks-2.test.ts drives the verb on a real database).",
    sites: [{ file: "src/rooms/memory/server/session-memory.ts", primitive: "searchMemoryRecords", count: 1 }] },
  { id: "hook.subagent_pack", consumer: "the rules and lessons of a Task subagent's context pack (`bb lane-pilot subagent-pack`, only where hook.subagent_pack is on)", carries: [], alwaysOn: [], status: "exempt",
    reason: "Accepted always-rules of the caller's sections and confirmed notes, masked, inside the 2 KB pack; it is the subagent's prompt, which the PM and writer probes do not see (tests/sma/parity-g2-hooks-2.test.ts drives the verb on a real database).",
    sites: [{ file: "src/rooms/tools/server/cli.ts", primitive: "pmRulesOf", count: 1 }] },
  { id: "cli.memory_load", consumer: "`bb lane-pilot memory load --tags a,b`: the core plus the notes carrying the tags, printed for whoever ran the command", carries: [], alwaysOn: [], status: "exempt",
    reason: "A command's printed output (like the session search above), not text injected into a prompt; nothing reaches an agent unless it ran the command itself.",
    sites: [{ file: "src/rooms/tools/server/cli.ts", primitive: "listMemory", count: 2 }] },
  { id: "pm.cold", consumer: "cold notes added when the PM asks for memory and the active set is thin", carries: ["note"], alwaysOn: [], status: "exempt",
    reason: "It only adds notes the active search missed. The probe's active note is already delivered by pm.memory_tool.",
    sites: [{ file: "src/rooms/memory/server/memory.ts", primitive: "enrichMemoryContext", count: 1 }] },
  { id: "maintainer.existing", consumer: "the memory maintainer's list of EXISTING NOTES", carries: [], alwaysOn: [], status: "exempt",
    reason: "A dedupe aid for the stage that writes notes, not a delivery to a worker; the notes are data it compares against and acts on only by `supersedes`.",
    sites: [{ file: "src/rooms/memory/server/memory.ts", primitive: "searchMemoryRecords", count: 1 }] },
  { id: "memory.golden_eval", consumer: "the retrieval evaluation (golden queries)", carries: [], alwaysOn: [], status: "exempt",
    reason: "It measures search quality for the owner and delivers nothing to an agent.",
    sites: [{ file: "src/rooms/self-repair/server/insights.ts", primitive: "searchMemoryRecords", count: 1 }] },
  { id: "pm.replay_arm", consumer: "the PM prompt a pm-replay arm is graded on (armPrompt in src/rooms/pm-replay/surface.ts)", carries: ["rule"], alwaysOn: [], status: "exempt",
    reason: "The arm prompt wraps the same pmRulesOf/pmRulesBlock pair pm.start delivers; probing pm.start already proves the rules reach this prompt.",
    sites: [
      { file: "src/rooms/pm-replay/surface.ts", primitive: "pmRulesOf", count: 1 },
      { file: "src/rooms/pm-replay/surface.ts", primitive: "pmRulesBlock", count: 1 },
    ] },
  { id: "pm.owner_card", consumer: "the owner card in a PM's first prompt (anamnesis)", carries: [], alwaysOn: [], status: "exempt",
    reason: "Facts about the owner from the anamnesis room, not project memory; it has its own checks (`bb lane-pilot anamnesis status`).",
    sites: [{ file: "src/rooms/native-agent/server/activation.ts", primitive: "ownerCardBlock", count: 1 }] },
  { id: "analyze.owner_card", consumer: "the owner card handed to the phase analysis (lp.analyze) when phase.gray_areas is on", carries: [], alwaysOn: [], status: "exempt",
    reason: "The same anamnesis card pm.owner_card names, not project memory; it rides only when the owner switched the gray-areas question on.",
    sites: [{ file: "src/rooms/phase/server/driver-wiring.ts", primitive: "ownerCardBlock", count: 1 }] },
  { id: "cli.parity_report", consumer: "`bb lane-pilot parity`: which memory and rule ids an attempt and a terminal session would both get", carries: [], alwaysOn: [], status: "exempt",
    reason: "A command's printed comparison of ids, not text injected into a prompt; nothing reaches an agent unless it ran the command itself.",
    sites: [
      { file: "src/rooms/native-agent/terminal-parity.ts", primitive: "listMemory", count: 1 },
      { file: "src/rooms/native-agent/terminal-parity.ts", primitive: "pmRulesOf", count: 1 },
    ] },
  { id: "writer.file_notes", consumer: "the file-note advice of the guard (FILECARDS.md of the task folder, written at dispatch and task update)", carries: [], alwaysOn: [], status: "exempt",
    reason: "Only trust-confirmed notes of the task's own paths, masked and clipped, reach a file the guard reads at an Edit; the probe asks prompts, not that file (the test drives taskFileCards on a real db).",
    sites: [{ file: "src/rooms/writer/server/writer-knowledge.ts", primitive: "searchMemoryRecords", count: 1 }] },
];

export const pathById = (id: string): MemoryPath | undefined => MEMORY_PATHS.find((entry) => entry.id === id);
