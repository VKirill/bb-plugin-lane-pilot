import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCommandOnHost } from "../src/rooms/writer/cli-run";
import { openDatabase } from "../src/rooms/plugin-db";
import { createLiveFolder } from "../src/rooms/writer/server/services/live-folder";
import { liveBackupReadCommand, parseLiveBackupRead } from "../src/rooms/writer/server/services/live-backup-read";

const roots: string[] = [];
const realHome = process.env.HOME;

function temp(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), `lane-pilot-${prefix}-`));
  roots.push(root);
  return root;
}

function put(root: string, path: string, content: string): void {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), content);
}

/** Same fake host as live-folder.test.ts: real folders, HOME is a temp folder so backups never touch the real one. */
function env() {
  const home = temp("home");
  process.env.HOME = home;
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  const host = {
    call: async (method: string, input: { requestedHostId: string; command: string; cwd: string; timeoutSec?: number }) => {
      if (method !== "runCommand") throw new Error(`unexpected host call ${method}`);
      return runCommandOnHost(input);
    },
  };
  const live = createLiveFolder({ bb, db, host } as never);
  return { home, live, backups: join(home, ".lane-pilot", "live-backups") };
}

/** Runs the reader on the folder with the ambient HOME the last env() installed. */
async function readBackup(
  folder: string,
  id: string,
  path: string,
  opts: { maxBytes?: number; maxAgeSeconds?: number } = {},
) {
  const ran = await runCommandOnHost({ requestedHostId: "h", cwd: folder, command: liveBackupReadCommand({ id, path, ...opts }) });
  return parseLiveBackupRead(ran);
}

/** A folder with a real backup of two of its files, made by the production backup command. */
async function backedUp() {
  const e = env();
  const folder = temp("work");
  put(folder, "src/a.ts", "a-old\n");
  put(folder, "src/b.ts", "b-old\n");
  put(folder, "docs/readme.md", "docs-old\n");
  const saved = await e.live.backupLiveFolder({ hostId: "h", folder, backupId: "lpattempt_one", files: ["src/a.ts", "src/b.ts"] });
  if (!saved.ok) throw new Error(saved.reason);
  return { ...e, folder };
}

beforeEach(() => { process.env.HOME = realHome; });
afterEach(() => {
  process.env.HOME = realHome;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("live backup read", () => {
  it("returns the backed-up bytes, not the current file", async () => {
    const { folder } = await backedUp();
    put(folder, "src/a.ts", "a-new-by-the-writer\n");
    expect(await readBackup(folder, "lpattempt_one", "src/a.ts")).toEqual({ state: "bytes", content: "a-old\n" });
  });

  it("reads an unchanged file the same way", async () => {
    const { folder } = await backedUp();
    expect(await readBackup(folder, "lpattempt_one", "src/b.ts")).toEqual({ state: "bytes", content: "b-old\n" });
  });

  it("answers unknown/not_in_backup for any path the selective backup does not list — absence is not proof of new", async () => {
    const { folder } = await backedUp();
    put(folder, "src/created.ts", "created\n");
    // Writer-created after the backup AND pre-existing but never owned: files.txt cannot tell them apart.
    expect(await readBackup(folder, "lpattempt_one", "src/created.ts")).toEqual({ state: "unknown", reason: "not_in_backup" });
    expect(await readBackup(folder, "lpattempt_one", "docs/readme.md")).toEqual({ state: "unknown", reason: "not_in_backup" });
  });

  it("rejects noncanonical path aliases instead of matching or proving anything", async () => {
    const { folder } = await backedUp();
    for (const alias of ["./src/a.ts", "src//a.ts", "src/./a.ts", "src/a.ts/", "", ".", ".."]) {
      expect(await readBackup(folder, "lpattempt_one", alias)).toEqual({ state: "unknown", reason: "unsafe_path" });
    }
  });

  it("answers unknown/no_backup when the backup directory is absent", async () => {
    const { folder } = await backedUp();
    expect(await readBackup(folder, "lpattempt_missing", "src/a.ts")).toEqual({ state: "unknown", reason: "no_backup" });
  });

  it("answers unknown/partial_backup when the manifest never got written", async () => {
    const { folder, backups } = await backedUp();
    rmSync(join(backups, "lpattempt_one", "manifest.json"));
    expect(await readBackup(folder, "lpattempt_one", "src/a.ts")).toEqual({ state: "unknown", reason: "partial_backup" });
  });

  it("answers unknown/backup_of_another_folder from a different cwd", async () => {
    await backedUp();
    const other = temp("other");
    expect(await readBackup(other, "lpattempt_one", "src/a.ts")).toEqual({ state: "unknown", reason: "backup_of_another_folder" });
  });

  it("answers unknown/expired for a backup older than the keep time", async () => {
    const { folder, backups } = await backedUp();
    const manifest = join(backups, "lpattempt_one", "manifest.json");
    const saved = JSON.parse(readFileSync(manifest, "utf8")) as { created_at: number };
    saved.created_at = Date.now() / 1000 - 8 * 86_400;
    writeFileSync(manifest, JSON.stringify(saved));
    expect(await readBackup(folder, "lpattempt_one", "src/a.ts")).toEqual({ state: "unknown", reason: "expired" });
  });

  it("answers unknown/symlink for a backed-up symlink row instead of following it", async () => {
    const e = env();
    const folder = temp("work");
    put(folder, "src/real.ts", "r\n");
    symlinkSync("real.ts", join(folder, "src", "link.ts"));
    const saved = await e.live.backupLiveFolder({ hostId: "h", folder, backupId: "lpattempt_link", files: ["src/real.ts", "src/link.ts"] });
    if (!saved.ok) throw new Error(saved.reason);
    expect(await readBackup(folder, "lpattempt_link", "src/link.ts")).toEqual({ state: "unknown", reason: "symlink" });
    expect(await readBackup(folder, "lpattempt_link", "src/real.ts")).toEqual({ state: "bytes", content: "r\n" });
  });

  it("answers unknown/unsafe_backup for symlinked backup roots and metadata", async () => {
    const { folder, backups } = await backedUp();
    const bdir = join(backups, "lpattempt_one");
    const listingText = readFileSync(join(bdir, "files.txt"), "utf8");
    const manifestText = readFileSync(join(bdir, "manifest.json"), "utf8");
    const foreign = temp("foreign");
    put(foreign, "files.txt", listingText);
    put(foreign, "manifest.json", manifestText);
    // files.txt as a symlink to an identical foreign copy.
    rmSync(join(bdir, "files.txt"));
    symlinkSync(join(foreign, "files.txt"), join(bdir, "files.txt"));
    expect(await readBackup(folder, "lpattempt_one", "src/a.ts")).toEqual({ state: "unknown", reason: "unsafe_backup" });
    // manifest.json as a symlink.
    rmSync(join(bdir, "files.txt"));
    writeFileSync(join(bdir, "files.txt"), listingText);
    rmSync(join(bdir, "manifest.json"));
    symlinkSync(join(foreign, "manifest.json"), join(bdir, "manifest.json"));
    expect(await readBackup(folder, "lpattempt_one", "src/a.ts")).toEqual({ state: "unknown", reason: "unsafe_backup" });
    // The whole files root as a symlink to a foreign tree with the same layout.
    rmSync(join(bdir, "manifest.json"));
    writeFileSync(join(bdir, "manifest.json"), manifestText);
    const foreignFiles = temp("foreign-files");
    put(foreignFiles, "src/a.ts", "foreign-bytes\n");
    rmSync(join(bdir, "files"), { recursive: true });
    symlinkSync(foreignFiles, join(bdir, "files"));
    expect(await readBackup(folder, "lpattempt_one", "src/a.ts")).toEqual({ state: "unknown", reason: "unsafe_backup" });
  });

  it("answers unknown/unsafe_backup when a content path escapes through a symlinked parent", async () => {
    const { folder, backups } = await backedUp();
    const outside = temp("outside");
    put(outside, "a.ts", "foreign-bytes\n");
    const bdir = join(backups, "lpattempt_one");
    // files/src becomes a symlink to the foreign directory: files/src/a.ts is a regular file outside the backup.
    rmSync(join(bdir, "files", "src"), { recursive: true });
    symlinkSync(outside, join(bdir, "files", "src"));
    expect(await readBackup(folder, "lpattempt_one", "src/a.ts")).toEqual({ state: "unknown", reason: "unsafe_backup" });
  });

  it("rejects a corrupt or ambiguous index instead of trusting a first match", async () => {
    const { folder, backups } = await backedUp();
    const listing = join(backups, "lpattempt_one", "files.txt");
    const original = readFileSync(listing, "utf8");
    for (const suffix of ["garbage\n", "null\n", '{"l":null}\n', '{"p":"src//a.ts","l":null}\n', '{"p":"src/a.ts","l":null}\n']) {
      writeFileSync(listing, original + suffix);
      const expected = suffix === '{"p":"src/a.ts","l":null}\n' ? "duplicate_index" : "invalid_index";
      expect(await readBackup(folder, "lpattempt_one", "src/a.ts")).toEqual({ state: "unknown", reason: expected });
    }
    writeFileSync(listing, original);
    expect(await readBackup(folder, "lpattempt_one", "src/a.ts")).toEqual({ state: "bytes", content: "a-old\n" });
    // An emptied index cannot prove anything either: absence stays unknown, never a false "new".
    writeFileSync(listing, "");
    expect(await readBackup(folder, "lpattempt_one", "src/a.ts")).toEqual({ state: "unknown", reason: "not_in_backup" });
  });

  it("answers unknown/too_large above the byte bound and unknown/unsafe_path for escaping paths", async () => {
    const { folder } = await backedUp();
    const outside = temp("outside");
    put(outside, "secret.txt", "s\n");
    const absolute = join(outside, "secret.txt");
    expect(await readBackup(folder, "lpattempt_one", "src/a.ts", { maxBytes: 5 })).toEqual({ state: "unknown", reason: "too_large" });
    expect(await readBackup(folder, "lpattempt_one", "../a.txt")).toEqual({ state: "unknown", reason: "unsafe_path" });
    expect(await readBackup(folder, "lpattempt_one", absolute)).toEqual({ state: "unknown", reason: "unsafe_path" });
  });

  it("answers unknown/unreadable when the backed-up file cannot be opened", async () => {
    const { folder, backups } = await backedUp();
    chmodSync(join(backups, "lpattempt_one", "files", "src", "a.ts"), 0);
    expect(await readBackup(folder, "lpattempt_one", "src/a.ts")).toEqual({ state: "unknown", reason: "unreadable" });
  });

  it("refuses backup ids that could leave the backup folder, including dot and dotdot", async () => {
    const { folder } = await backedUp();
    for (const id of ["../escape", ".", ".."]) {
      const ran = await runCommandOnHost({ requestedHostId: "h", cwd: folder, command: liveBackupReadCommand({ id, path: "src/a.ts" }) });
      expect(parseLiveBackupRead(ran).state).toBe("unknown");
    }
  });
});

describe("parseLiveBackupRead", () => {
  const packed = (text: string) => `z:${deflateSync(Buffer.from(text, "utf8")).toString("base64")}`;
  const answer = (body: unknown) => ({ exitCode: 0, stdout: JSON.stringify(body), stderr: "" });

  it("collapses transport and answer failures to unknown", () => {
    expect(parseLiveBackupRead({ exitCode: 1, stdout: "", stderr: "boom" })).toEqual({ state: "unknown", reason: "command_failed:boom" });
    expect(parseLiveBackupRead({ exitCode: 0, stdout: "not json", stderr: "" })).toEqual({ state: "unknown", reason: "invalid_answer" });
    expect(parseLiveBackupRead(answer({ state: "bogus" }))).toEqual({ state: "unknown", reason: "invalid_answer" });
    expect(parseLiveBackupRead(answer({ state: "unknown" }))).toEqual({ state: "unknown", reason: "invalid_answer" });
    expect(parseLiveBackupRead(answer({ state: "proven_new" }))).toEqual({ state: "unknown", reason: "invalid_answer" });
    expect(parseLiveBackupRead(answer({ state: "unknown", reason: "not_in_backup" }))).toEqual({ state: "unknown", reason: "not_in_backup" });
    // An over-limit serialized answer is refused by size before JSON.parse, even when it is valid JSON.
    const oversized = answer({ state: "unknown", reason: "x".repeat(9000) });
    expect(oversized.stdout.length).toBeGreaterThan(8464);
    expect(parseLiveBackupRead(oversized, 10)).toEqual({ state: "unknown", reason: "too_large" });
    expect(parseLiveBackupRead(answer({ state: "unknown", reason: "no_backup" }), 10)).toEqual({ state: "unknown", reason: "no_backup" });
  });

  it("decodes valid bytes, honors the requested bound, and rejects oversized payloads", () => {
    expect(parseLiveBackupRead(answer({ state: "bytes", content: packed("hello\n") }))).toEqual({ state: "bytes", content: "hello\n" });
    expect(parseLiveBackupRead(answer({ state: "bytes", content: packed("x".repeat(10)) }), 10)).toEqual({ state: "bytes", content: "x".repeat(10) });
    const over = parseLiveBackupRead(answer({ state: "bytes", content: packed("x".repeat(100)) }), 10);
    expect(over.state).toBe("unknown");
    // A wire blob far beyond what the cap can produce is refused before decoding.
    expect(parseLiveBackupRead(answer({ state: "bytes", content: `z:${"A".repeat(20000)}` }), 10)).toEqual({ state: "unknown", reason: "too_large" });
    expect(parseLiveBackupRead(answer({ state: "bytes", content: "z:not-base64!!!" }))).toEqual({ state: "unknown", reason: "invalid_answer" });
  });
});
