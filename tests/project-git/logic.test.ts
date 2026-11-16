import { describe, expect, it } from "vitest";
import { SECRET_CONTENT_PATTERNS, isWithin, namesOperation, repoDescription, repoNameFor, sameRemote, verifyReadback } from "../../src/rooms/project-git";

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

  it("names the token families and leaves lockfile hashes alone", () => {
    const hit = (text: string) => SECRET_CONTENT_PATTERNS.some((source) => new RegExp(source).test(text));
    const samples = [
      ["-----BEGIN PGP", "PRIVATE KEY BLOCK-----"].join(" "), ["sk", "live", "a".repeat(24)].join("_"), `123456789:${"A".repeat(35)}`,
      `gh${"p"}_${"a".repeat(36)}`, `sk-${"b".repeat(24)}`, `AKIA${"C".repeat(16)}`,
    ];
    for (const sample of samples) expect(hit(sample), sample).toBe(true);
    expect(hit(`"integrity": "sha512-${"Ab+/".repeat(22)}=="`)).toBe(false);
  });
});
