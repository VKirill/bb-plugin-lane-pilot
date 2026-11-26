/**
 * Regenerate the house-words baseline after a clean-up: UPDATE_BASELINES=1 npx vitest run tests/contract-fields-read.test.ts tests/guard-tools.test.ts
 * (it rewrites tests/fixtures/house-words-baseline.json and tests/fixtures/unread-fields-baseline.json; review the diff before you commit it).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addedLineLeaks, countHouseWordHits, freshHouseWordHits, houseWordHits, internalIds, isGeneratedFile, leakFindings, parityGaps, sourceWordHits, type HouseWordBaseline } from "../src/rooms/guard-tools/guard-tools";
import { NATIVE_LP_BRIDGE_PM_TOOLS } from "../src/rooms/native-agent/models/bridge-tools";
import { PM_CORE_TOOLS, PM_FAMILY_TOOLS } from "../src/rooms/platform/models/pm-tool-families";

const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => { const path = join(dir, name); return statSync(path).isDirectory() ? (name === "node_modules" ? [] : walk(path)) : [path]; });

describe("guard tools", () => {
  it("leak scanner: no secret-shaped string in the sources and docs that ship", () => {
    // leakFindings is the same scan lp-ship's publishable runs: a planted secret fails both.
    expect(leakFindings(".")).toEqual([]);
  });

  it("internal ids forbidden in the texts a person reads", async () => {
    const i18n = await import("../packages/i18n/src/i18n");
    const catalogs = Object.values(i18n).filter((value) => value && typeof value === "object" && !Array.isArray(value)) as Array<Record<string, unknown>>;
    const strings = Object.fromEntries(catalogs.flatMap((catalog) => Object.entries(catalog).filter(([, value]) => typeof value === "string")) as Array<[string, string]>);
    expect(internalIds(strings)).toEqual([]);
  });

  it("leak scanner: no house word, old brand or colour literal in the texts a person reads and the comments around them", async () => {
    const i18n = await import("../packages/i18n/src/i18n");
    const catalogs = Object.values(i18n).filter((value) => value && typeof value === "object" && !Array.isArray(value)) as Array<Record<string, unknown>>;
    const strings = Object.fromEntries(catalogs.flatMap((catalog) => Object.entries(catalog).filter(([, value]) => typeof value === "string")) as Array<[string, string]>);
    expect(houseWordHits(strings)).toEqual([]);
    // Comments and tests: today's hits are baselined by file + matched text + how many times (not by line, which another branch moves);
    // a NEW occurrence outside the baseline turns the suite red. Shrink the baseline as the old texts are cleaned.
    const file = join("tests/fixtures/house-words-baseline.json");
    const files = [...walk("src"), ...walk("docs"), ...walk("tests")].filter((path) => /\.(ts|tsx|md|json)$/.test(path) && !path.includes("guard-tools") && !path.includes("house-words-baseline") && !isGeneratedFile(path));
    const found = countHouseWordHits(files.flatMap((path) => sourceWordHits(path, readFileSync(path, "utf8"))));
    if (process.env.UPDATE_BASELINES === "1") writeFileSync(file, `${JSON.stringify(found, null, 2)}\n`);
    expect(freshHouseWordHits(found, JSON.parse(readFileSync(file, "utf8")) as HouseWordBaseline)).toEqual([]);
  });

  it("permission rules parity: the PM's tools are the same in a BB session and in the folded terminal list", () => {
    expect(parityGaps(NATIVE_LP_BRIDGE_PM_TOOLS.filter((tool) => tool !== "lane_pilot_tool_search"), [...PM_CORE_TOOLS, ...PM_FAMILY_TOOLS])).toEqual({ onlySession: [], onlyTerminal: [] });
  });

  it("addedLineLeaks catches a secret added in one commit and removed in a later one, and fails publishable", () => {
    const repo = mkdtempSync(join(tmpdir(), "lp-leakscan-"));
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
        cwd: repo,
        encoding: "utf8",
      }).trim();
    const secretValue = "sk-" + "testSecretValue1234567890";
    const shipEnv = {
      ...process.env,
      LP_SHIP_ROOT: repo,
      PATH: `${join(process.cwd(), "node_modules/.bin")}:${process.env.PATH ?? ""}`,
    };
    const runPublishable = () =>
      spawnSync("npx", ["tsx", join(process.cwd(), "scripts/lp-ship.ts"), "publishable"], {
        cwd: process.cwd(),
        env: shipEnv,
        encoding: "utf8",
      });
    try {
      git("init", "-q", "-b", "main");
      mkdirSync(join(repo, "src"), { recursive: true });
      mkdirSync(join(repo, "scripts"), { recursive: true });
      writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "tmp", version: "0.1.1" }));
      writeFileSync(join(repo, "CHANGELOG.md"), "# Changelog\n\n## 0.1.1\n\n- test\n");
      writeFileSync(join(repo, "LICENSE"), "MIT\n");
      writeFileSync(join(repo, "scripts/generate-atlas.ts"), "process.exit(0);\n");
      writeFileSync(join(repo, "src/app.ts"), "export const ok = 1;\n");
      git("add", "-A");
      git("commit", "-qm", "base");
      const baseSha = git("rev-parse", "HEAD");
      git("update-ref", "refs/remotes/origin/main", baseSha);

      // Clean range passes both addedLineLeaks and publishable.
      writeFileSync(join(repo, "src/app.ts"), "export const ok = 1;\nexport const clean = 2;\n");
      git("add", "src/app.ts");
      git("commit", "-qm", "clean change");
      const cleanLogs: string[] = [];
      expect(addedLineLeaks("origin/main..HEAD", git, (m) => cleanLogs.push(m))).toEqual([]);
      expect(cleanLogs).toEqual(["INFO ship.leakscan range=origin/main..HEAD commits=1 lines=1 hits=0"]);
      const cleanShip = runPublishable();
      expect(cleanShip.status).toBe(0);
      expect(cleanShip.stdout).toContain("INFO ship.leakscan range=origin/main..HEAD commits=1 lines=1 hits=0");

      // Commit adds a secret-shaped string, then a later commit removes it.
      writeFileSync(join(repo, "src/app.ts"), `export const ok = 1;\nexport const key = "${secretValue}";\n`);
      git("add", "src/app.ts");
      git("commit", "-qm", "add secret");
      const leakSha = git("rev-parse", "HEAD");

      writeFileSync(join(repo, "src/app.ts"), "export const ok = 1;\n");
      git("add", "src/app.ts");
      git("commit", "-qm", "remove secret");

      // Working tree scan misses it, range scan catches it without echoing the secret.
      expect(leakFindings(repo)).toEqual([]);
      const hitLogs: string[] = [];
      const hits = addedLineLeaks("origin/main..HEAD", git, (m) => hitLogs.push(m));
      expect(hits).toEqual([`${leakSha} src/app.ts:2`]);
      expect(hits.join("\n")).not.toContain(secretValue);
      expect(hitLogs).toEqual(["INFO ship.leakscan range=origin/main..HEAD commits=3 lines=2 hits=1"]);

      // lp-ship publishable fails and names the commit and path:line without leaking the value.
      const ship = runPublishable();
      expect(ship.status).toBe(1);
      expect(ship.stdout).toContain("INFO ship.leakscan range=origin/main..HEAD commits=3 lines=2 hits=1");
      expect(ship.stdout).toContain(`leak scan: ${leakSha} src/app.ts:2`);
      expect(ship.stdout).not.toContain(secretValue);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
