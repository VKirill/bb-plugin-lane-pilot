/**
 * Every way project memory, rules and lessons reach an agent (SMA block 4, «Memory you can prove», P0-3).
 *
 * Why a registry: Matvey Maslov's system carried zero lessons through one delivery path for three months and nobody saw it,
 * because nothing asked each path whether it delivers. Here each path is named once, with the code sites that inject
 * for it, and
 *  - `tests/memory-paths.test.ts` scans the source for the injection helpers (`MEMORY_PRIMITIVES`) and fails when a call
 *    appears (or disappears) without an entry here: a new reader of memory cannot ship unregistered;
 *  - `bb lane-pilot memory-probe` (src/rooms/memory-probe/server/services/memory-probe.ts) writes a note, a core note and a rule that carry
 *    a unique token through the one write door and asks every `probed` path for what its agent would receive;
 *  - the drill scenario `memory_paths` (scripts/lp-drill.py) runs the probe and then checks the real writer brief and the real PM
 *    prompt in their thread logs. (2026-10-29) the Lane Stack terminal (`lane-memory`) is not a consumer.
 * A path that cannot be probed is `exempt` with the reason; the reason is the entry's point.
 */

/** What a probe plants: a note naming a path and a core convention. */
export type ProbeKind = "note" | "core";

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
  /** Behavioral tests that exercise this exempt path; structural registry scanning is not coverage by itself. */
  behavioralTests?: readonly string[];
};

/** The functions that put memory or owner facts in front of an agent (or fetch them for one). The scan in the test counts their calls. */
export const MEMORY_PRIMITIVES = [
  "writerKnowledge", "mixWriterMemory", "mixReviewerMemory", "reviewerMemoryFor", "writerContextBlocks",
  "contributeInstructions",
  "pmMemoryContext", "pmMemoryContextJudged", "searchMemoryRecords", "listMemory", "memoryContext",
  "session_memory_search", "session_memory_core", "enrichMemoryContext",
] as const;
export type MemoryPrimitive = (typeof MEMORY_PRIMITIVES)[number];

export const MEMORY_PATHS: readonly MemoryPath[] = [
  { id: "writer.brief", consumer: "a writer's first prompt (spawnWriterAttempt)", carries: ["note", "core"], alwaysOn: ["core"], status: "probed", live: "writer-brief",
    sites: [
      { file: "src/rooms/writer/server/services/spawn.ts", primitive: "writerKnowledge", count: 1 },
      { file: "src/rooms/writer/server/services/writer-knowledge.ts", primitive: "mixWriterMemory", count: 1 },
      { file: "src/rooms/memory/server/services/memory-mix.ts", primitive: "searchMemoryRecords", count: 1 },
      { file: "src/rooms/memory/server/services/memory-mix.ts", primitive: "listMemory", count: 1 },
    ] },
  { id: "writer.repair", consumer: "the code-critique repair round (the dispatch context of the first brief, kept in the attempt trace)", carries: ["note", "core"], alwaysOn: ["core"], status: "probed",
    sites: [{ file: "src/rooms/writer/server/services/critique-gate.ts", primitive: "writerContextBlocks", count: 1 }] },
  { id: "bb.thread", consumer: "every ordinary BB thread of the project (contributeInstructions, the L1 showcase)", carries: ["core"], alwaysOn: [], status: "probed",
    sites: [{ file: "src/rooms/memory/server/handlers/thread-block.ts", primitive: "contributeInstructions", count: 1 }] },
  { id: "pm.memory_tool", consumer: "the PM tool lane_pilot_memory {action:\"context\"}", carries: ["note", "core"], alwaysOn: [], status: "probed",
    sites: [
      { file: "src/rooms/memory/server/services/memory.ts", primitive: "pmMemoryContextJudged", count: 1 },
      { file: "src/rooms/memory/server/services/memory-mix.ts", primitive: "memoryContext", count: 2 },
      { file: "src/rooms/memory/server/services/memory-mix.ts", primitive: "searchMemoryRecords", count: 1 },
    ] },
  { id: "schedule.agent", consumer: "the first message of a scheduled agent run (kind agent of the schedule board): the project's notes for the standing task", carries: ["note", "core"], alwaysOn: [], status: "probed",
    sites: [{ file: "src/rooms/memory/server/services/memory-mix.ts", primitive: "pmMemoryContext", count: 1 }] },
  { id: "critic.code", consumer: "the code critic's prompt (critique-runs)", carries: ["note", "core"], alwaysOn: ["core"], status: "probed",
    sites: [
      { file: "src/rooms/critique/server/services/code-critique.ts", primitive: "reviewerMemoryFor", count: 1 },
      { file: "src/rooms/memory/server/services/memory-mix.ts", primitive: "mixReviewerMemory", count: 1 },
      { file: "src/rooms/memory/server/services/memory-mix.ts", primitive: "searchMemoryRecords", count: 1 },
      { file: "src/rooms/memory/server/services/memory-mix.ts", primitive: "listMemory", count: 2 },
    ] },
  { id: "hub.memory_import_eval", consumer: "the M1 import gate (RPC memory_import_eval): measures how many imported records the PM search finds", carries: [], alwaysOn: [], status: "exempt", behavioralTests: ["tests/server/session-memory.test.ts"],
    reason: "A measurement over the import receipt, read by the operator; nothing it finds reaches an agent prompt.",
    sites: [{ file: "src/rooms/memory/server/services/import.ts", primitive: "searchMemoryRecords", count: 1 }] },
  { id: "hub.session_rpc", consumer: "the hub session_memory RPCs, not a Lane Pilot agent prompt", carries: [], alwaysOn: [], status: "exempt", behavioralTests: ["tests/server/session-memory.test.ts"],
    reason: "The RPCs answer `bb lane-pilot memory search|write` (an agent's shell command, M2 rule): the agent reads the answer as command output, not as injected prompt text.",
    sites: [
      { file: "src/rooms/memory/server/handlers/session-memory.ts", primitive: "session_memory_search", count: 1 },
      { file: "src/rooms/tools/server/handlers/cli.ts", primitive: "session_memory_search", count: 1 },
      { file: "src/rooms/memory/server/handlers/session-memory.ts", primitive: "session_memory_core", count: 1 },
      { file: "src/rooms/memory/server/services/memory-search.ts", primitive: "searchMemoryRecords", count: 1 },
      { file: "src/rooms/memory/server/services/memory-mix.ts", primitive: "listMemory", count: 1 },
    ] },
  { id: "hook.prompt_recall", consumer: "the pointers the session hook prints under a prompt (`bb lane-pilot memory search --recall`, confirmedWordHits)", carries: [], alwaysOn: [], status: "exempt", behavioralTests: ["tests/session-hooks/parity-g2-hooks-2.test.ts"],
    reason: "Confirmed notes of the caller's own project by the word index only, masked, one line each, three at most; the probe asks the PM and writer prompts, not a hook's context line (tests/session-hooks/parity-g2-hooks-2.test.ts drives the verb on a real database).",
    sites: [{ file: "src/rooms/memory/server/services/session-memory.ts", primitive: "searchMemoryRecords", count: 1 }] },
  { id: "cli.memory_load", consumer: "`bb lane-pilot memory load --tags a,b`: the core plus the notes carrying the tags, printed for whoever ran the command", carries: [], alwaysOn: [], status: "exempt",     reason: "A command's printed output (like the session search above), not text injected into a prompt; nothing reaches an agent unless it ran the command itself.",
    sites: [{ file: "src/rooms/tools/server/handlers/cli.ts", primitive: "listMemory", count: 2 }] },
  { id: "pm.cold", consumer: "cold notes added when the PM asks for memory and the active set is thin", carries: ["note"], alwaysOn: [], status: "exempt",     reason: "It only adds notes the active search missed. The probe's active note is already delivered by pm.memory_tool.",
    sites: [{ file: "src/rooms/memory/server/services/memory.ts", primitive: "enrichMemoryContext", count: 1 }] },
  { id: "maintainer.existing", consumer: "the memory maintainer's list of EXISTING NOTES", carries: [], alwaysOn: [], status: "exempt", behavioralTests: ["tests/server/memory-lifecycle.test.ts"],
    reason: "A dedupe aid for the stage that writes notes, not a delivery to a worker; the notes are data it compares against and acts on only by `supersedes`.",
    sites: [{ file: "src/rooms/memory/server/services/memory.ts", primitive: "searchMemoryRecords", count: 1 }] },
  { id: "cli.parity_report", consumer: "`bb lane-pilot parity`: which memory ids an attempt and a terminal session would both get", carries: [], alwaysOn: [], status: "exempt",     reason: "A command's printed comparison of ids, not text injected into a prompt; nothing reaches an agent unless it ran the command itself.",
    sites: [
      { file: "src/rooms/native-agent/server/services/terminal-parity.ts", primitive: "listMemory", count: 1 },
    ] },
  { id: "writer.file_notes", consumer: "the file-note advice of the guard (FILECARDS.md of the task folder, written at dispatch and task update)", carries: [], alwaysOn: [], status: "exempt", behavioralTests: ["tests/session-hooks/parity-g1-hooks-1.test.ts"],
    reason: "Only trust-confirmed notes of the task's own paths, masked and clipped, reach a file the guard reads at an Edit; the probe asks prompts, not that file (the test drives taskFileCards on a real db).",
    sites: [{ file: "src/rooms/writer/server/services/writer-knowledge.ts", primitive: "searchMemoryRecords", count: 1 }] },
];

export const pathById = (id: string): MemoryPath | undefined => MEMORY_PATHS.find((entry) => entry.id === id);
