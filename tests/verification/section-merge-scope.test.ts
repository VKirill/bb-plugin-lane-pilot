// OBS-2 (review591-section-repo-root-diagnosis): for a nested-section task the ownership scans
// (ownsBarrier ls-files, WORKSPACE_DIRT_SCRIPT `-- .`, gitOwnershipChangedPaths `--relative`)
// inspect only the section subfolder, but integrateWorktree runs `git status --porcelain` and
// `git add -A` over the whole repository — sibling dirt outside the section is staged, committed
// and merged into base. These tests pin the desired guard: integrateWorktree called with the
// SECTION dirs (base/bot, candidate/bot) and section-relative ownsPaths must refuse a sibling
// change with reason `outside_section_scope` before the base is mutated and before the candidate
// is autocommitted; the candidate keeps its bytes.
//
// Fixture: one seed repo cloned twice — `base` and `candidate` are independent clones (no
// `git worktree add`, no linked worktrees, no live directories). Git commands still resolve the
// repository toplevel from the section cwd, which is exactly the OBS-2 gap. Because the clones
// are independent object stores, `base/.git/objects/info/alternates` points at the candidate's
// objects so the merge can see the candidate's new commit — object visibility only, no
// worktree linkage.
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { integrateWorktree } from "../../src/rooms/worktree";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });

const SECTION_V1 = "section v1\n", SIBLING_V1 = "sibling v1\n";
const OUTSIDE_SCOPE = "outside_section_scope";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function sectionProject() {
  const root = await mkdtemp(join(tmpdir(), "lp-section-scope-"));
  roots.push(root);
  const origin = join(root, "origin");
  git(root, "init", "-q", "-b", "main", origin);
  await mkdir(join(origin, "bot"), { recursive: true });
  await mkdir(join(origin, "sibling"), { recursive: true });
  await writeFile(join(origin, "bot", "section.txt"), SECTION_V1);
  await writeFile(join(origin, "sibling", "notes.txt"), SIBLING_V1);
  git(origin, "add", "-A"); git(origin, "commit", "-qm", "base");
  const base = join(root, "base");
  const candidate = join(root, "candidate");
  git(root, "clone", "-q", origin, base);
  git(root, "clone", "-q", origin, candidate);
  git(candidate, "checkout", "-qb", "attempt/section");
  // Shared object visibility only: the base can read the candidate's new commits, nothing else.
  await mkdir(join(base, ".git", "objects", "info"), { recursive: true });
  await writeFile(join(base, ".git", "objects", "info", "alternates"), `${join(candidate, ".git", "objects")}\n`);
  return { root, base, candidate };
}

const integrate = (base: string, candidate: string) =>
  integrateWorktree({
    basePath: join(base, "bot"),
    worktreePath: join(candidate, "bot"),
    message: "attempt work",
    ownsPaths: ["**"],
    removeWorktree: false,
  });

describe("integrateWorktree keeps section merges inside the section (OBS-2)", () => {
  it("rejects an uncommitted sibling change before staging or autocommitting it", async () => {
    const { base, candidate } = await sectionProject();
    const baseBefore = git(base, "rev-parse", "HEAD").trim();
    const candidateBefore = git(candidate, "rev-parse", "HEAD").trim();
    await writeFile(join(candidate, "bot", "section.txt"), "section v2\n");
    await writeFile(join(candidate, "sibling", "notes.txt"), "sibling v2 — outside the section\n");
    const result = await integrate(base, candidate);
    expect(result.status).not.toBe("merged");
    expect(result.reason).toContain(OUTSIDE_SCOPE);
    expect(git(base, "rev-parse", "HEAD").trim()).toBe(baseBefore);
    expect(git(candidate, "rev-parse", "HEAD").trim()).toBe(candidateBefore);
    expect(await readFile(join(base, "bot", "section.txt"), "utf8")).toBe(SECTION_V1);
    expect(await readFile(join(base, "sibling", "notes.txt"), "utf8")).toBe(SIBLING_V1);
    expect(await readFile(join(candidate, "sibling", "notes.txt"), "utf8")).toBe("sibling v2 — outside the section\n");
    expect(await readFile(join(candidate, "bot", "section.txt"), "utf8")).toBe("section v2\n");
  });

  it("rejects a sibling change already committed on the candidate branch", async () => {
    const { base, candidate } = await sectionProject();
    const baseBefore = git(base, "rev-parse", "HEAD").trim();
    await writeFile(join(candidate, "bot", "section.txt"), "section v2\n");
    await writeFile(join(candidate, "sibling", "notes.txt"), "sibling v2 — committed outside the section\n");
    git(candidate, "add", "-A"); git(candidate, "commit", "-qm", "attempt work");
    const result = await integrate(base, candidate);
    expect(result.status).not.toBe("merged");
    expect(result.reason).toContain(OUTSIDE_SCOPE);
    expect(git(base, "rev-parse", "HEAD").trim()).toBe(baseBefore);
    expect(await readFile(join(base, "sibling", "notes.txt"), "utf8")).toBe(SIBLING_V1);
    expect(await readFile(join(candidate, "sibling", "notes.txt"), "utf8")).toBe("sibling v2 — committed outside the section\n");
  });

  it("control: a section-only change still integrates", async () => {
    const { base, candidate } = await sectionProject();
    await writeFile(join(candidate, "bot", "section.txt"), "section v2\n");
    const result = await integrate(base, candidate);
    expect(result.status).toBe("merged");
    expect(await readFile(join(base, "bot", "section.txt"), "utf8")).toBe("section v2\n");
    expect(await readFile(join(base, "sibling", "notes.txt"), "utf8")).toBe(SIBLING_V1);
    expect(await readFile(join(candidate, "bot", "section.txt"), "utf8")).toBe("section v2\n");
  });
  it("rejects a new untracked sibling file and preserves it for inspection",async()=>{
    const {base,candidate}=await sectionProject();
    const before=git(base,"rev-parse","HEAD").trim();
    await writeFile(join(candidate,"sibling/new.txt"),"untracked sibling\n");
    const result=await integrate(base,candidate);
    expect(result).toMatchObject({status:"failed",reason:expect.stringContaining(OUTSIDE_SCOPE)});
    expect(git(base,"rev-parse","HEAD").trim()).toBe(before);
    expect(await readFile(join(candidate,"sibling/new.txt"),"utf8")).toBe("untracked sibling\n");
  });

  it("keeps an explicitly repository-root integration able to merge sibling changes",async()=>{
    const {base,candidate}=await sectionProject();
    await writeFile(join(candidate,"sibling/notes.txt"),"root scope change\n");
    await writeFile(join(candidate,"bot/section.txt"),"section scope change\n");
    const result=await integrateWorktree({basePath:base,worktreePath:candidate,message:"root task",ownsPaths:["bot/section.txt","sibling/notes.txt"],removeWorktree:false});
    expect(result.status).toBe("merged");
    expect(await readFile(join(base,"sibling/notes.txt"),"utf8")).toBe("root scope change\n");
    expect(await readFile(join(base,"bot/section.txt"),"utf8")).toBe("section scope change\n");
  });

});
