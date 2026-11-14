import type { TaskV2 } from "../../contracts";
import { parseReadFirstHints } from "../read-first";

type Finding = { code:string; message:string; data?:Record<string, unknown> };

/**
 * read_first stays inside the task's own world (docs/task-folder.md §read_first, SMA wi_spool): never another task's home, never the shared
 * `.agents/plans/*` (the plan travels as text and Lane Pilot snapshots it into the task's home), never another chat's `.bb/chats/<id>/`.
 */
export function readFirstScopeFindings(task:Pick<TaskV2, "id" | "read_first">, chatId?:string | null):Finding[] {
  const findings:Finding[] = [];
  let hints:ReturnType<typeof parseReadFirstHints>;
  try { hints = parseReadFirstHints(task.read_first); } catch { return findings; }
  for (const hint of hints) {
    const path = hint.path.replace(/^\.\/+/, "").replaceAll("\\", "/");
    const home = /^\.agents\/tasks\/([^/]+)/.exec(path)?.[1];
    const item = /^\.agents\/plans\/items\/([^/]+)/.exec(path)?.[1];
    const chat = /^\.bb\/chats\/([^/]+)/.exec(path)?.[1];
    if (home !== undefined && home !== task.id) {
      findings.push({ code:"read_first_foreign_task", message:`read_first names another task's home: ${hint.path}; a writer reads only its own task (.agents/tasks/${task.id}/). Put what it needs from that task into this task's plan text` });
    } else if (path.startsWith(".agents/plans/") && item !== task.id) {
      findings.push({ code:"read_first_shared_plan", message:`read_first names a shared planning file: ${hint.path}; send the plan as text in the plan field (or the path as the whole plan): Lane Pilot snapshots it into .agents/tasks/${task.id}/ and the writer reads it there` });
    } else if (chat !== undefined && chat !== chatId) {
      findings.push({ code:"read_first_foreign_chat", message:`read_first names a chat folder that is not this PM chat's: ${hint.path}; put what the writer needs into the plan text instead` });
    }
  }
  return findings;
}
