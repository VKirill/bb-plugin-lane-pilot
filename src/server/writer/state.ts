import { RunWriterPool } from "../../stages/run-policy";
import type { ServerCore } from "../core";

export function createWriterState(ctx: ServerCore) {
  const activeWriterTasks = new Set<string>();

  const runWriterPool = new RunWriterPool();

  return { activeWriterTasks, runWriterPool };
}
