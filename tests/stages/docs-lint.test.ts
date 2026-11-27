import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { claimIdentifiers, expandCitationLists, pageCitations, parseFrontmatter } from "../../src/rooms/docs/models";
import { commitDocs } from "../../src/rooms/docs/git-docs";

it("commits only the docs paths it is given", async () => {
  const root = await mkdtemp(join(tmpdir(), "lane-docs-commit-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
  try {
    git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
    await writeFile(join(root, "a.ts"), "1"); git("add", "."); git("commit", "-qm", "base");
    await mkdir(join(root, "docs")); await writeFile(join(root, "docs/a.md"), "# a\n"); await writeFile(join(root, "a.ts"), "2");
    // A project's pre-commit hook that builds code fails in a docs worktree without dependencies: the docs commit does not run it.
    await mkdir(join(root, ".git/hooks"), { recursive: true }); await writeFile(join(root, ".git/hooks/pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const result = await commitDocs({ projectCwd: root, paths: ["docs/a.md"], message: "docs: test" });
    expect(result.status).toBe("committed");
    expect(git("show", "--name-only", "--format=", "HEAD").trim()).toBe("docs/a.md");
    expect(git("status", "--porcelain").trim()).toBe("M a.ts");
    expect(await readFile(join(root, "a.ts"), "utf8")).toBe("2");
    expect((await commitDocs({ projectCwd: root, paths: ["docs/a.md"], message: "docs: again" })).status).toBe("nothing");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("reads a list of ranges after one file", () => {
  expect(expandCitationLists("dim 0-0.9 (`schema.ts:19-25,125-143`)")).toBe("dim 0-0.9 (`schema.ts:19-25, schema.ts:125-143`)");
  expect(pageCitations("A (a.ts:1-2, 7).").map((c) => `${c.start}-${c.end}`)).toEqual(["1-2", "7-7"]);
});

it("does not take a host and port for a file citation", () => {
  expect(pageCitations("Listens on 0.0.0.0:3000 (src/server.ts:12).")).toEqual([{ file:"src/server.ts", start:12, end:12 }]);
});

// treba, 2026-10-17: docs/components/tracking-attribution.md as the docs agent left it after the repair round. Its lists
// sit at the key's own indent, which YAML allows; the lint read them as empty and failed the pass three times that night.
const TREBA_TRACKING = `---
title: Tracking and order attribution
type: component
created: 2026-09-11
updated: 2026-10-17
status: active
confidence: high
tags:
- tracking
- attribution
sources:
- server/utils/attribution.ts
- server/utils/sync-orders.ts
---
# Tracking and order attribution

## How it works

Visits are matched to orders (server/utils/attribution.ts:10-20), synced orders carry the click ids (server/utils/sync-orders.ts:5)
and the tracker posts them (public/t.js:1-3).
`;

it("reads frontmatter lists written at the key's own indent", () => {
  expect(parseFrontmatter(TREBA_TRACKING)?.data).toMatchObject({ tags:["tracking", "attribution"], sources:["server/utils/attribution.ts", "server/utils/sync-orders.ts"] });
});

it("reads Expo Router paths: a (group) folder and a +api file", () => {
  // Murdoku 2026-10-21: `mobile/src/app/(tabs)/_layout.tsx:21-48` was read as `/_layout.tsx` and
  // `mobile/src/app/api/ask+api.ts:9-18` as `api.ts`, both «does not exist»; the agent's repair cited the five
  // `(tabs)/*.tsx` route files instead and failed the unit with 10 such findings.
  const body = "Tabs (`mobile/src/app/(tabs)/_layout.tsx:21-47`), home (mobile/src/app/(tabs)/index.tsx:5-8), ask (`mobile/src/app/api/ask+api.ts:9-18`), not found (src/app/+not-found.tsx:3).";
  expect(pageCitations(body)).toEqual([
    { file:"mobile/src/app/(tabs)/_layout.tsx", start:21, end:47 },
    { file:"mobile/src/app/(tabs)/index.tsx", start:5, end:8 },
    { file:"mobile/src/app/api/ask+api.ts", start:9, end:18 },
    { file:"src/app/+not-found.tsx", start:3, end:3 },
  ]);
  expect(expandCitationLists("(`mobile/src/app/(tabs)/index.tsx:5-8,12`)")).toBe("(`mobile/src/app/(tabs)/index.tsx:5-8, mobile/src/app/(tabs)/index.tsx:12`)");
  // A citation in parentheses keeps the parenthesis out of its path.
  expect(pageCitations("Order (src/a.ts:1) and (src/b.ts:2-3).").map((c) => c.file)).toEqual(["src/a.ts", "src/b.ts"]);
});

it("does not infer identifiers from bare product names but keeps explicit type names", () => {
  expect(claimIdentifiers("OpenCode TypeScript camelCase TASK_LIMIT `ModelCatalog`"))
    .toEqual(["ModelCatalog", "camelCase", "TASK_LIMIT"]);
});

it("does not infer code identifiers from protocol acronyms", () => {
  expect(claimIdentifiers("POST HTTPS JSON UUID LIMIT TASK_LIMIT `LIMIT` camelCase"))
    .toEqual(["LIMIT", "TASK_LIMIT", "camelCase"]);
});
