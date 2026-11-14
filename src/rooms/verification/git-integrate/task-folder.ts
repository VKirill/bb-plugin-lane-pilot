import { maskCredentials } from "@lane-pilot/kit";

/** Lane Pilot's per-task folder; never committed, never produced, never an owns_paths hit. The leading double star
 * is what makes the one line match at any depth (a pattern with a middle slash would be anchored to the repo root
 * and miss a workspace that is a subfolder — the real-git test caught exactly that). */
export const TASK_FOLDER_EXCLUDE = "**/.agents/plans/items/";

export function taskFolderRel(taskId:string):string|null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(taskId)) return null;
  return `.agents/plans/items/${taskId}`;
}

/**
 * The shell that appends the task-folder exclude line to the repository's real info/exclude, which git itself
 * resolves (`--git-path`): a workspace that is a repo subfolder gets no stray `.git`, and a linked worktree's
 * shared exclude gets the line. Idempotent POSIX sh; run on the workspace's host with cwd at the workspace.
 */
export function appendExcludeCommand(line:string):string {
  const quoted=line.replace(/'/g,"'\\''");
  return `f=$(git rev-parse --git-path info/exclude) || exit 1
grep -qxF '${quoted}' "$f" 2>/dev/null || { mkdir -p "$(dirname "$f")" && printf '%s\\n' '${quoted}' >> "$f"; }`;
}

/** What ensureExcludeLinesCommand prints: «lp:added <line>» for each line it appended, «lp:not-git» outside a repository. */
export const EXCLUDE_ADDED = "lp:added ";
export const EXCLUDE_NOT_GIT = "lp:not-git";

/**
 * Like appendExcludeCommand for several lines at once, telling which ones were missing and are now there. A last line
 * without a newline is closed first, so the first appended line is not glued to it. Idempotent POSIX sh.
 */
export function ensureExcludeLinesCommand(lines:readonly string[]):string {
  const quoted=lines.map((line)=>`'${line.replace(/'/g,"'\\''")}'`).join(" ");
  return `f=$(git rev-parse --git-path info/exclude 2>/dev/null) || { echo '${EXCLUDE_NOT_GIT}'; exit 0; }
mkdir -p "$(dirname "$f")" || exit 1
for l in ${quoted}; do
  grep -qxF -- "$l" "$f" 2>/dev/null && continue
  { [ ! -s "$f" ] || [ -z "$(tail -c1 "$f")" ] || printf '\\n' >> "$f"; } && printf '%s\\n' "$l" >> "$f" && printf '${EXCLUDE_ADDED}%s\\n' "$l"
done`;
}

/** REFLEXES.md of a task: only the «WHEN <trigger> → <act>» lines, so the guard can fire them at the act (SMA k_lib_reflex); null with none.
 * One text for the task home and the old folder. */
export function reflexesFileText(lines:string[]):string|null {
  const kept = lines.filter((line) => /WHEN\s+.+?\s*(?:→|->)\s*.+/.test(line));
  return kept.length ? `# Reflexes\n\n${kept.join("\n")}\n` : null;
}

/** FILECARDS.md of a task (SMA k_hs_context): the line enters the model's context, so it is masked here, whoever built it, and clipped; null with none. */
export function filecardsFileText(lines:string[]):string|null {
  const kept = lines.map((line)=>maskCredentials(line.slice(0,260)).text).filter(Boolean).slice(0,40);
  return kept.length ? `# File notes\n\n${kept.join("\n")}\n` : null;
}

export async function persistTaskFolder(input:{
  taskId:string; plan?:string;
  /** Terminal outcome of the task (SMA k_pl_quick): written to OUTCOME.md beside PLAN.md. */
  outcome?:string;
  /** Project lessons with a «WHEN <trigger> → <act>» line; written to REFLEXES.md (SMA k_lib_reflex). */
  reflexes?:string[];
  /** «path -> claim» lines of the confirmed notes that concern the task's paths; written to FILECARDS.md (SMA k_hs_context). */
  filecards?:string[];
  /** Whether a file of the task folder is there already (task-folder relative path): an empty list then blanks the file instead of leaving a retired rule in it. */
  exists?:(relativePath:string)=>Promise<boolean>;
  /** Appends the exclude line to the repo's real info/exclude on the workspace's host; a failure skips only the line. */
  exclude?:(line:string)=>Promise<void>;
  writeFile:(relativePath:string, content:string)=>Promise<void>;
}):Promise<{folder:string}|null> {
  const folder = taskFolderRel(input.taskId);
  if (!folder) return null;
  if (input.exclude) {
    try { await input.exclude(TASK_FOLDER_EXCLUDE); }
    catch (cause) {
      console.warn(`lane-pilot: skipped the task-folder exclude line: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
  if (input.plan !== undefined) {
    const plan = input.plan.endsWith("\n") ? input.plan : `${input.plan}\n`;
    await input.writeFile(`${folder}/PLAN.md`, plan);
  }
  if (input.outcome !== undefined) await input.writeFile(`${folder}/OUTCOME.md`, input.outcome.endsWith("\n") ? input.outcome : `${input.outcome}\n`);
  const reflexes = reflexesFileText(input.reflexes ?? []);
  // A retired rule must not keep firing from a stale file: with no lines left, a file that is there is rewritten with none.
  if (reflexes) await input.writeFile(`${folder}/REFLEXES.md`, reflexes);
  else if (input.reflexes !== undefined && await input.exists?.(`${folder}/REFLEXES.md`).catch(() => false)) await input.writeFile(`${folder}/REFLEXES.md`, "# Reflexes\n");
  const filecards = filecardsFileText(input.filecards ?? []);
  if (filecards) await input.writeFile(`${folder}/FILECARDS.md`, filecards);
  else if (input.filecards !== undefined && await input.exists?.(`${folder}/FILECARDS.md`).catch(() => false)) await input.writeFile(`${folder}/FILECARDS.md`, "# File notes\n");
  return { folder };
}
