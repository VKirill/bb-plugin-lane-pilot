import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { integrateWorktree, syncWorktree } from "../../src/verification/git-integrate";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });

async function repo() {
  const base = join(await mkdtemp(join(tmpdir(), "lp-sync-")), "main");
  execFileSync("git", ["init", "-q", "-b", "main", base]);
  await writeFile(join(base, "page.vue"), "hero\nhow\nfaq\n");
  git(base, "add", "-A"); git(base, "commit", "-qm", "base");
  const worktree = (name: string) => {
    const path = join(base, "..", name);
    git(base, "worktree", "add", "-q", "-b", `bb/${name}`, path, "main");
    return path;
  };
  return { base, worktree };
}

it("brings a merged writer's worktree up to main, including other writers' work", async () => {
  const { base, worktree } = await repo();
  const a = worktree("a"), b = worktree("b");
  await writeFile(join(a, "page.vue"), "hero from a\nhow\nfaq\n");
  expect((await integrateWorktree({ basePath: base, worktreePath: a, message: "a" })).status).toBe("merged");
  await writeFile(join(b, "other.ts"), "export {};\n");
  expect((await integrateWorktree({ basePath: base, worktreePath: b, message: "b" })).status).toBe("merged");
  const synced = await syncWorktree({ basePath: base, worktreePath: a });
  expect(synced.status).toBe("synced");
  expect(synced.head).toBe(git(base, "rev-parse", "HEAD").trim());
  expect(await readFile(join(a, "other.ts"), "utf8")).toBe("export {};\n");
  expect((await syncWorktree({ basePath: base, worktreePath: a })).status).toBe("up-to-date");
});

it("merges main into a worktree that has its own commit", async () => {
  const { base, worktree } = await repo();
  const a = worktree("a");
  await writeFile(join(a, "mine.ts"), "1\n"); git(a, "add", "-A"); git(a, "commit", "-qm", "mine");
  await writeFile(join(base, "theirs.ts"), "2\n"); git(base, "add", "-A"); git(base, "commit", "-qm", "theirs");
  expect((await syncWorktree({ basePath: base, worktreePath: a })).status).toBe("synced");
  expect(await readFile(join(a, "theirs.ts"), "utf8")).toBe("2\n");
});

it("undoes a conflicting sync and names the files, leaving the worktree as it was", async () => {
  const { base, worktree } = await repo();
  const a = worktree("a");
  await writeFile(join(a, "page.vue"), "hero A\nhow\nfaq\n"); git(a, "add", "-A"); git(a, "commit", "-qm", "a");
  await writeFile(join(base, "page.vue"), "hero MAIN\nhow\nfaq\n"); git(base, "add", "-A"); git(base, "commit", "-qm", "main");
  const head = git(a, "rev-parse", "HEAD").trim();
  const synced = await syncWorktree({ basePath: base, worktreePath: a });
  expect(synced.status).toBe("conflict");
  expect(synced.reason).toContain("page.vue");
  expect(git(a, "rev-parse", "HEAD").trim()).toBe(head);
  expect(git(a, "status", "--porcelain")).toBe("");
});

it("refuses a worktree with uncommitted edits", async () => {
  const { base, worktree } = await repo();
  const a = worktree("a");
  await writeFile(join(a, "page.vue"), "half done\n");
  const synced = await syncWorktree({ basePath: base, worktreePath: a });
  expect(synced.status).toBe("dirty");
  expect(await readFile(join(a, "page.vue"), "utf8")).toBe("half done\n");
});
