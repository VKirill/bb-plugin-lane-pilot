import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawnAsync } from "@lane-pilot/kit";
import type { TaskV2 } from "../contracts";
import type { FileChange, PlantInput } from "./types";

/**
 * The drill's candidates: two small accepted tasks in a throw-away repository. Plain node modules and `node --test`, so the checks run anywhere
 * Lane Pilot does, in a second, with nothing installed. Between them they give every defect class a place to be planted.
 */
const BASE: Record<string, string> = {
  "README.md": "drill fixture\n",
  ".gitignore": "node_modules/\n",
  "src/limits.mjs": "export const LIMIT = 3;\n",
};

const CLAMP = `import { LIMIT } from "./limits.mjs";

export function clampIndex(index, size) {
  if (index < 0) return 0;
  if (index >= size) return size - 1;
  return index;
}

export function parseCount(text) {
  const value = Number(text);
  if (Number.isNaN(value)) {
    throw new Error("not a number: " + text);
  }
  return value;
}

export function label(count) {
  const many = count > LIMIT;
  return many ? "many" : "few";
}
`;

const CLAMP_TEST = `import test from "node:test";
import assert from "node:assert/strict";
import { clampIndex, label } from "../src/clamp.mjs";

test("clampIndex keeps the index inside the list", () => {
  assert.equal(clampIndex(-2, 5), 0);
  assert.equal(clampIndex(5, 5), 4);
  assert.equal(clampIndex(2, 5), 2);
});

test("label says many above the limit", () => {
  assert.equal(label(4), "many");
  assert.equal(label(3), "few");
});
`;

const PAD = `export function padLeft(text, width) {
  let out = String(text);
  while (out.length < width) out = " " + out;
  return out;
}
`;

const MONEY = `import { padLeft } from "./pad.mjs";

export function formatCents(cents) {
  const whole = Math.floor(cents / 100);
  const rest = cents % 100;
  return whole + "." + padLeft(rest, 2).replace(" ", "0");
}
`;

const MONEY_TEST = `import test from "node:test";
import assert from "node:assert/strict";
import { formatCents } from "../src/money.mjs";
import { padLeft } from "../src/pad.mjs";

test("formatCents writes dollars and cents", () => {
  assert.equal(formatCents(1234), "12.34");
  assert.equal(formatCents(1205), "12.05");
});

test("padLeft pads to the width", () => {
  assert.equal(padLeft("7", 3), "  7");
  assert.equal(padLeft("abc", 2), "abc");
  assert.equal(padLeft("", 1), " ");
});
`;

function contract(repo: string, id: string, title: string, acceptance: string[], files: string[], tests: string[], checks: string[]): TaskV2 {
  return {
    schema_version: 2, id, title, display_title: title, kind: "feature", area: `feature:${id}`, risk: "medium", lane: "writer", project_cwd: repo,
    read_first: [], interfaces: [], invariants: [], out_of_scope: [], expected_outputs: files, owns_paths: [...files, ...tests], never_touch: [], depends_on: [],
    objective: title, acceptance, verify: "tests",
    verification: checks.map((command) => ({ command, cwd: repo })),
  };
}

const added = (path: string, after: string): FileChange => ({ path, before: null, after });

export type Fixture = { repo: string; baseSha: string; candidates: PlantInput[] };

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await spawnAsync("git", ["-c", "user.name=drill", "-c", "user.email=drill@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, timeout: 30_000 });
  if (result.error || result.status !== 0) throw new Error(`git ${args[0]} failed: ${(result.error?.message ?? result.stderr).trim().slice(0, 200)}`);
  return result.stdout.trim();
}

/** Writes the fixture repository under `root` (one commit: the base) and returns the candidates that were «accepted» on top of it. */
export async function buildFixture(root: string): Promise<Fixture> {
  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  for (const [path, text] of Object.entries(BASE)) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), text);
  }
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-qm", "base");
  const baseSha = await git(repo, "rev-parse", "HEAD");
  const importCheck = (file: string) => `node -e "import('./${file}').then(() => process.exit(0))"`;
  const candidates: PlantInput[] = [
    {
      taskId: "drill-clamp", source: "drill fixture",
      contract: contract(repo, "drill-clamp", "Index clamp and counts", ["clampIndex keeps an index inside the list", "label says many above the limit"], ["src/clamp.mjs"], ["test/clamp.test.mjs"],
        ["node --test test/clamp.test.mjs", importCheck("src/clamp.mjs")]),
      changes: [added("src/clamp.mjs", CLAMP), added("test/clamp.test.mjs", CLAMP_TEST)],
    },
    {
      taskId: "drill-money", source: "drill fixture",
      contract: contract(repo, "drill-money", "Money formatting", ["padLeft pads to a width", "formatCents writes dollars and cents", "cents below ten keep a leading zero"], ["src/pad.mjs", "src/money.mjs"], ["test/money.test.mjs"],
        ["node --test test/money.test.mjs", importCheck("src/money.mjs")]),
      changes: [added("src/pad.mjs", PAD), added("src/money.mjs", MONEY), added("test/money.test.mjs", MONEY_TEST)],
    },
  ];
  return { repo, baseSha, candidates };
}
