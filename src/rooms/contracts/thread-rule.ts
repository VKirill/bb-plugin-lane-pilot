/**
 * The exact memory rule a plugin-spawned thread's brief ends with (and the line AGENTS.md carries). A leaf module:
 * writer-task and errands import it without pulling the memory server's graph (thread-block → self-repair → writer
 * cycled through it).
 */
export const THREAD_MEMORY_RULE = [
  'Память проекта — Lane Pilot: искать `bb lane-pilot memory search "<вопрос>"`, записать `bb lane-pilot memory write "<факт>"`;',
  "не в файлы ~/.claude/…/memory и не в BB memory",
] as const;
