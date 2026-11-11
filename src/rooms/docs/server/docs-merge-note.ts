

/**
 * The log line of a docs merge, or null when it merged. A conflict while landing an earlier pass's leftover worktree is
 * the expected end of that leftover: main got the same pages meanwhile (treba-sites, 2026-10-07: the owner committed
 * docs a crashed pass had left in the checkout), the leftover is dropped and this pass writes the pages again from main.
 */
export function docsMergeNote(basePath:string,result:{status:string;reason?:string|null;conflicts:string[]},leftover=false):{level:"info"|"warn";message:string}|null {
  if(result.status!=="conflict"&&result.status!=="failed") return null;
  const files=result.conflicts.length?` (${result.conflicts.join(", ")})`:"";
  if(leftover&&result.status==="conflict") return {level:"info",message:`Lane Pilot earlier docs pass for ${basePath} dropped: main changed the same pages${files}; this pass writes them again from main`};
  return {level:"warn",message:`Lane Pilot docs merge into ${basePath} ${result.status}: ${result.reason ?? ""}${files}`};
}
