import { describe, expect, it } from "vitest";
import { isWithin, repoNameFor, sameRemote, verifyReadback } from "../../src/rooms/project-git";

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
});
