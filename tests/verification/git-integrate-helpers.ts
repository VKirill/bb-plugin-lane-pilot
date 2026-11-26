import { createGitRepo, git } from "../helpers/git-repo";

export { git };

export async function repo() {
  const { base, worktree } = createGitRepo({
    prefix: "lp-integrate-",
    subdir: "main",
    files: { "server.ts": "line1\nline2\nline3\n" },
  });
  return { base, worktree: async (name: string) => worktree(name) };
}
