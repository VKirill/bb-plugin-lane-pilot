import { git } from "./git-core";
import { workspaceGitLayout } from "./worktree-lifecycle";

/** A section may read its containing repository, but merging its branch must never carry sibling edits with it. */
export async function sectionMergeViolation(input:{basePath:string;worktreePath:string;committedOnly?:boolean;ownsPaths?:string[]}):Promise<string|null> {
  // Machine-owned committed packages (docs/reverts) already select their own commit scope.
  if(input.committedOnly&&input.ownsPaths===undefined) return null;
  const layout=await workspaceGitLayout(input.worktreePath);
  if(!layout.ok) return `outside_section_scope: cannot verify checkout: ${layout.reason}`;
  if(!layout.nested) return null;
  const base=await git(input.basePath,["rev-parse","--verify","HEAD"]);
  if(!base.ok) return `outside_section_scope: cannot verify base: ${base.reason}`;
  const queries=[
    ["diff","--name-only","--no-relative","--no-renames","-z",`${base.stdout.trim()}...HEAD`],
    ...(!input.committedOnly?[["diff","--name-only","--no-relative","--no-renames","-z","HEAD"],["ls-files","--others","--exclude-standard","-z"]]:[]),
  ];
  for(const args of queries) {
    const result=await git(layout.repoTop,args);
    if(!result.ok) return `outside_section_scope: cannot inspect repository changes: ${result.reason}`;
    const outside=result.stdout.split("\0").filter((path)=>path&&!path.startsWith(`${layout.prefix}/`));
    if(outside.length) return `outside_section_scope: changes outside ${layout.prefix}/: ${outside.slice(0,10).join(", ")}`;
  }
  return null;
}
