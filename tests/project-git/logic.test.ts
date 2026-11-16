import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { SECRET_TOKEN_PATTERNS, secretShaped } from "../../src/rooms/tasks";
import { isWithin, pythonSecretSources, namesOperation, repoDescription, repoNameFor, sameRemote, verifyReadback } from "../../src/rooms/project-git";

const row = { id: 5, full_name: "Octo/App", private: true, visibility: "private", owner: { login: "Octo" }, clone_url: "https://github.com/Octo/App.git" };

describe("project git rules", () => {
  it("verifies the exact repository, its privacy and its recorded id", () => {
    expect(verifyReadback(row, { owner: "octo", name: "app" }).ok).toBe(true);
    expect(verifyReadback({ ...row, private: false, visibility: "public" }, { owner: "octo", name: "app" })).toMatchObject({ ok: false, reason: "the repository is not private" });
    expect(verifyReadback({ ...row, full_name: "octo/app2" }, { owner: "octo", name: "app" }).ok).toBe(false);
    expect(verifyReadback(row, { owner: "octo", name: "app", id: 6 }).ok).toBe(false);
    expect(verifyReadback(null, { owner: "octo", name: "app" }).ok).toBe(false);
  });

  it("names, compares and nests the way the host sees it", () => {
    expect(repoNameFor("/home/u/My Site (new)/")).toBe("My-Site-new");
    expect(repoNameFor("/")).toBeNull();
    expect(sameRemote("git@github.com:Octo/App.git", "https://github.com/octo/app")).toBe(true);
    expect(sameRemote("https://x@github.com/octo/app.git", "https://github.com/octo/other.git")).toBe(false);
    expect(isWithin("/a/b/c", "/a/b")).toBe(true);
    expect(isWithin("/a/bc", "/a/b")).toBe(false);
  });

  it("names an uncertain repository only by its operation id", () => {
    expect(namesOperation({ description: repoDescription("op-1") }, "op-1")).toBe(true);
    expect(namesOperation({ description: repoDescription("op-1") }, "op-2")).toBe(false);
    expect(namesOperation({ description: "Private repository made by Lane Pilot" }, "op-1")).toBe(false);
    expect(namesOperation(null, "op-1")).toBe(false);
  });

  it("scans files with the one shared list of credential families, read the same way by Python re", () => {
    const scan = pythonSecretSources(SECRET_TOKEN_PATTERNS);
    expect(scan.ok).toBe(true);
    const samples = [
      ["-----BEGIN", "RSA PRIVATE KEY-----"].join(" "), ["-----BEGIN PGP", "PRIVATE KEY BLOCK-----"].join(" "), ["sk", "live", "a".repeat(24)].join("_"),
      `123456789:${"A".repeat(35)}`, `gh${"p"}_${"a".repeat(36)}`, `github_pat_${"a".repeat(45)}`, `sk-${"b".repeat(24)}`, `AKIA${"C".repeat(16)}`,
      `xox${"b"}-${"1".repeat(12)}`, `AIza${"d".repeat(35)}`,
      `"integrity": "sha512-${"Ab+/".repeat(22)}=="`, "const x = 12345678;", "sk-short", "plain words",
    ];
    const js = samples.map((text) => SECRET_TOKEN_PATTERNS.map(({ pattern }) => pattern.test(text)));
    const py = spawnSync("python3", ["-I", "-c", "import json, re, sys\nd = json.load(sys.stdin)\nprint(json.dumps([[bool(re.search(p.encode(), t.encode())) for p in d['p']] for t in d['t']]))"],
      { input: JSON.stringify({ p: scan.ok ? scan.sources : [], t: samples }), encoding: "utf8" });
    expect(JSON.parse(py.stdout)).toEqual(js);
    expect(js.slice(0, 10).every((row) => row.some(Boolean))).toBe(true);
    expect(js.slice(10).every((row) => !row.some(Boolean))).toBe(true);
  });

  it("refuses to translate a pattern Python would read differently instead of dropping it", () => {
    expect(pythonSecretSources([{ name: "case-blind", pattern: /token/i }])).toMatchObject({ ok: false, reason: expect.stringContaining("case-blind") });
    expect(pythonSecretSources([{ name: "lookbehind", pattern: /(?<=key=)\w+/ }])).toMatchObject({ ok: false, reason: expect.stringContaining("lookbehind") });
    expect(pythonSecretSources([{ name: "unicode", pattern: new RegExp(String.raw`\p{L}`) }]).ok).toBe(false);
    expect(pythonSecretSources([]).ok).toBe(false);
  });

  it("keeps the answer rail: every old shape and the base64 guess still refuse an answer", () => {
    for (const text of [`sk-${"a".repeat(16)}`, `ghs_${"a".repeat(20)}`, `xoxp-${"1".repeat(10)}`, `AKIA${"B".repeat(16)}`, ["-----BEGIN", "PRIVATE KEY-----"].join(" "), "A".repeat(40), `1234567890:${"a".repeat(30)}`]) {
      expect(secretShaped(text), text).toBe(true);
    }
    expect(secretShaped(["sk", "live", "a".repeat(24)].join("_"))).toBe(true);
    expect(secretShaped("use the staging key from Env Catalog")).toBe(false);
  });
});
