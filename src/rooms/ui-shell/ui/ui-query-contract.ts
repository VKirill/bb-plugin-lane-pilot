import { z } from "zod";
import { defineRpcContract } from "@get-bb/plugin-sdk";

const method = { input: z.unknown(), output: z.unknown() } as const;

/**
 * ponytail: contract for the UI's watched reads only. Schemas are permissive — the server
 * validates every input anyway, and the client contract exists because experimental_useRpcQuery
 * requires one for method names and optional invalidation tags (none declared here, so the
 * poll is the staleness fallback, same as before). Ceiling: importing the real rpcContract here
 * would drag src/rooms/contracts → ../schedule → @lane-pilot/kit node builtins into the UI
 * bundle (tests/architecture forbids it). Upgrade: lift the used input/output schemas into
 * zod-only contract files, then swap `method` entries for the real ones.
 */
export const uiQueryContract = defineRpcContract({
  helper_thread_labels: method,
  list_helper_threads: method,
  owner_waiting: method,
  task_board: method,
  thread_live: method,
  work_graph_strips: method,
  work_graph_task: method,
  world_version: { ...method, tags: () => ["world_version"] },
});
