import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isFsAbsent, isNotFound, readTextOrNull, sha256FileOrNull } from "../src/index";

// The shapes the plugin really sees (Grok R8 re-review): PluginRpcCallError carries code "not_found" or,
// for a server code it does not know, code "unknown_error" + serverCode "<entity>_not_found"; a BbHttpError
// arrives as code "<entity>_not_found" with message "HTTP 404: …". A 500 or transport failure is not absence.
describe("isNotFound", () => {
  it("accepts every real SDK not-found shape", () => {
    expect(isNotFound(Object.assign(new Error("nope"), { code: "not_found" }))).toBe(true);
    expect(isNotFound(Object.assign(new Error("HTTP 404: thread not found"), { code: "unknown_error", serverCode: "thread_not_found", status: 404 }))).toBe(true);
    expect(isNotFound(Object.assign(new Error("HTTP 404: project not found"), { code: "project_not_found" }))).toBe(true);
    expect(isNotFound(Object.assign(new Error("HTTP 404: environment not found"), { code: "environment_not_found", status: 404 }))).toBe(true);
    expect(isNotFound(new Error("HTTP 404: Thread not found"))).toBe(true);
    expect(isNotFound(Object.assign(new Error("gone"), { status: 404 }))).toBe(true);
    expect(isNotFound(Object.assign(new Error("gone"), { statusCode: "404" }))).toBe(true);
  });
  it("rejects failures that are not absence", () => {
    expect(isNotFound(new Error("HTTP 500: store on fire"))).toBe(false);
    expect(isNotFound(Object.assign(new Error("boom"), { code: "transport_error" }))).toBe(false);
    expect(isNotFound(Object.assign(new Error("boom"), { code: "unknown_error", serverCode: "internal_error", status: 500 }))).toBe(false);
    expect(isNotFound(new Error("socket hangup"))).toBe(false);
    expect(isNotFound("HTTP 404: string cause")).toBe(false);
    expect(isNotFound(null)).toBe(false);
  });
});

describe("isFsAbsent", () => {
  it("treats ENOENT and ENOTDIR as absence, nothing else", () => {
    expect(isFsAbsent(Object.assign(new Error("no"), { code: "ENOENT" }))).toBe(true);
    expect(isFsAbsent(Object.assign(new Error("no"), { code: "ENOTDIR" }))).toBe(true);
    expect(isFsAbsent(Object.assign(new Error("no"), { code: "EACCES" }))).toBe(false);
    expect(isFsAbsent(new Error("plain"))).toBe(false);
  });
});

describe("readTextOrNull / sha256FileOrNull", () => {
  it("return null for a missing path and for ENOTDIR, and propagate other errors", async () => {
    const dir = mkdtempSync(join(tmpdir(), "miss-"));
    try {
      const fileAsDir = join(dir, "file");
      writeFileSync(fileAsDir, "x");
      expect(await readTextOrNull(join(fileAsDir, "child"))).toBeNull(); // ENOTDIR: "file" is not a directory
      expect(await readTextOrNull(join(dir, "missing"))).toBeNull();
      expect(await sha256FileOrNull(join(fileAsDir, "child"))).toBeNull();
      mkdirSync(join(dir, "real-dir"));
      await expect(readTextOrNull(join(dir, "real-dir"))).rejects.toThrow(); // EISDIR is not absence
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
