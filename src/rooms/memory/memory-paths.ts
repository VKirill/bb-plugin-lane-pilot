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
 *    prompt in their thread logs, and a Lane Stack terminal through `lane-memory`.
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
  live?: "writer-brief" | "pm-prompt" | "terminal";
};

/** The functions that put memory, rules or owner facts in front of an agent (or fetch them for one). The scan in the test counts their calls. */
export const MEMORY_PRIMITIVES = [
  "writerKnowledge", "writerRules", "stickyTurnPromptWithRules", "mixWriterMemory", "mixReviewerMemory", "reviewerMemoryFor", "writerContextBlocks",
  "pmRulesPromptBlock", "pmRulesBlock", "pmRulesOf", "pmResumeInstructions", "contributeInstructions", "ownerCardBlock",
  "pmMemoryContext", "councilMemoryBlock", "searchMemoryRecords", "listMemory", "memoryContext", "acceptedRules",
  "session_memory_search", "session_memory_core",
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
    ] },
  { id: "writer.turn", consumer: "the turn that gives a continuing writer thread its next task (stickyTurnPrompt)", carries: ["rule"], alwaysOn: ["rule"], status: "probed",
    sites: [
      { file: "src/rooms/writer/server/start.ts", primitive: "stickyTurnPromptWithRules", count: 1 },
      { file: "src/rooms/writer/server/writer-knowledge.ts", primitive: "writerRules", count: 1 },
    ] },
  { id: "writer.repair", consumer: "the code-critique repair round (the dispatch context of the first brief, kept in the attempt trace)", carries: ["note", "core", "rule"], alwaysOn: ["core", "rule"], status: "probed",
    sites: [{ file: "src/rooms/writer/server/finish.ts", primitive: "writerContextBlocks", count: 1 }] },
  { id: "pm.start", consumer: "a PM's first prompt (activation)", carries: ["rule"], alwaysOn: ["rule"], status: "probed", live: "pm-prompt",
    sites: [
      { file: "src/rooms/native-agent/server/activation.ts", primitive: "pmRulesPromptBlock", count: 1 },
      { file: "src/rooms/learning/pm-rules.ts", primitive: "pmRulesBlock", count: 2 },
      { file: "src/rooms/learning/pm-rules.ts", primitive: "pmRulesOf", count: 2 },
    ] },
  { id: "pm.resume", consumer: "a PM session that starts or resumes (contributeInstructions)", carries: ["rule"], alwaysOn: ["rule"], status: "probed",
    sites: [
      { file: "src/rooms/learning/service.ts", primitive: "contributeInstructions", count: 1 },
      { file: "src/rooms/learning/service.ts", primitive: "pmResumeInstructions", count: 1 },
    ] },
  { id: "pm.rules_tool", consumer: "the PM tool lane_pilot_memory {action:\"learned\", op:\"rules\"}", carries: ["rule"], alwaysOn: ["rule"], status: "probed",
    sites: [{ file: "src/rooms/learning/service.ts", primitive: "pmRulesOf", count: 1 }] },
  { id: "pm.memory_tool", consumer: "the PM tool lane_pilot_memory {action:\"context\"}", carries: ["note", "core"], alwaysOn: [], status: "probed",
    sites: [
      { file: "src/rooms/memory/server/memory.ts", primitive: "pmMemoryContext", count: 1 },
      { file: "src/rooms/memory/server/memory-mix.ts", primitive: "memoryContext", count: 1 },
      { file: "src/rooms/memory/server/memory-mix.ts", primitive: "searchMemoryRecords", count: 1 },
    ] },
  { id: "schedule.agent", consumer: "the first message of a scheduled agent run (kind agent of the schedule board): the project's notes for the standing task", carries: ["note", "core"], alwaysOn: [], status: "probed",
    sites: [{ file: "src/rooms/memory/server/memory-mix.ts", primitive: "pmMemoryContext", count: 1 }] },
  { id: "critic.code", consumer: "the code critic's prompt (critique-runs)", carries: ["note", "core"], alwaysOn: ["core"], status: "probed",
    sites: [{ file: "src/rooms/critique/server/critique-runs.ts", primitive: "reviewerMemoryFor", count: 1 }] },
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
  { id: "terminal.search", consumer: "a Lane Stack terminal session: lane-memory search / context (session_memory_search)", carries: ["note", "core"], alwaysOn: [], status: "probed", live: "terminal",
    sites: [
      { file: "src/rooms/memory/server/session-memory.ts", primitive: "session_memory_search", count: 1 },
      { file: "src/rooms/memory/server/session-memory.ts", primitive: "searchMemoryRecords", count: 1 },
    ] },
  { id: "terminal.core", consumer: "a Lane Stack terminal session: CORE block of CLAUDE.md/AGENTS.md (inject_core via session_memory_core)", carries: ["core"], alwaysOn: ["core"], status: "probed", live: "terminal",
    sites: [{ file: "src/rooms/memory/server/session-memory.ts", primitive: "session_memory_core", count: 1 }] },
  { id: "maintainer.existing", consumer: "the memory maintainer's list of EXISTING NOTES", carries: [], alwaysOn: [], status: "exempt",
    reason: "A dedupe aid for the stage that writes notes, not a delivery to a worker; the notes are data it compares against and acts on only by `supersedes`.",
    sites: [{ file: "src/rooms/memory/server/memory.ts", primitive: "searchMemoryRecords", count: 1 }] },
  { id: "memory.golden_eval", consumer: "the retrieval evaluation (golden queries)", carries: [], alwaysOn: [], status: "exempt",
    reason: "It measures search quality for the owner and delivers nothing to an agent.",
    sites: [{ file: "src/rooms/self-repair/server/insights.ts", primitive: "searchMemoryRecords", count: 1 }] },
  { id: "pm.owner_card", consumer: "the owner card in a PM's first prompt (anamnesis)", carries: [], alwaysOn: [], status: "exempt",
    reason: "Facts about the owner from the anamnesis room, not project memory; it has its own checks (`bb lane-pilot anamnesis status`).",
    sites: [{ file: "src/rooms/native-agent/server/activation.ts", primitive: "ownerCardBlock", count: 1 }] },
];

export const pathById = (id: string): MemoryPath | undefined => MEMORY_PATHS.find((entry) => entry.id === id);
