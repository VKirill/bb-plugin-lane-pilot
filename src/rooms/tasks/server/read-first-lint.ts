import { resolve } from "node:path";
import type { TaskV2 } from "../../contracts";
import { parseReadFirstHints, parseReadFirstSelector } from "../read-first";

export function readFirstProbePaths(task:Pick<TaskV2, "read_first">, workspacePath:string, repoRootPath?:string|null):string[] {
  let hints:string[] = [];
  try { hints = parseReadFirstHints(task.read_first).flatMap((hint) => {
    const selected=parseReadFirstSelector(hint.path), root=selected.scope==="repo"?repoRootPath:workspacePath;
    return root?[resolve(root,selected.path)]:[];
  }); } catch { /* reported by lintContract */ }
  return hints;
}

export function readFirstFindings(input:{ task:TaskV2; workspacePath:string; repoRootPath?:string|null; hostId:string; kinds:ReadonlyMap<string, string>|null }):Array<{code:string;message:string}> {
  const { task } = input;
  const kindOf = (path:string) => input.kinds?.get(path);
  const errors:Array<{code:string;message:string}> = [];
  // read_first: a project-relative path that exists on the writer's machine and is a file.
  try {
    for (const hint of parseReadFirstHints(task.read_first)) {
      const selected=parseReadFirstSelector(hint.path), root=selected.scope==="repo"?input.repoRootPath:input.workspacePath;
      if(!root) { errors.push({code:"read_first_repo_unknown",message:`read_first repository root is unverified on the workspace host: ${hint.path}`}); continue; }
      const kind = kindOf(resolve(root, selected.path));
      if (kind === "directory") errors.push({ code:"read_first_folder", message:`read_first is a directory, not a file: ${hint.path}/ is a folder; name the files inside it (read_first takes files, optionally with line windows), or put the folder in owns_paths` });
      else if (kind === "symlink" || kind === "other") errors.push({ code:"read_first_not_file", message:`read_first is not a regular file (${kind}): ${hint.path}; point it at the real file` });
      else if (kind === "missing" && !task.depends_on.length && !task.expected_outputs.some((entry) => entry.replace(/^\.\//, "") === hint.path)) {
        errors.push({ code:"read_first_missing", message:`read_first source is missing: ${hint.path} does not exist on the writer's machine (${input.hostId}); correct the path, or drop it when the task creates that file` });
      }
    }
  } catch (cause) {
    errors.push({ code:"read_first_path", message:cause instanceof Error ? cause.message : String(cause) });
  }

  return errors;
}
