import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

const coordination = vi.hoisted(() => ({ arm: false, arrived: 0, release: () => {} }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  coordination.release = release;
  return {
    ...real,
    rename: async (from: Parameters<typeof real.rename>[0], to: Parameters<typeof real.rename>[1]) => {
      if (!coordination.arm) return real.rename(from, to);
      coordination.arrived += 1;
      if (coordination.arrived === 2) release();
      // A correct lock admits one rename. Waiting forever for a second deadlocks it. (2026-10-29 audit A-026)
      await Promise.race([gate, new Promise((resolve) => setTimeout(resolve, 200))]);
      return real.rename(from, to);
    },
  };
});

import { compareAndSwapText } from "../src/rooms/native-install/cas";

it("A-026 only one concurrent CAS on the same original config can succeed", async () => {
  const folder = await mkdtemp(join(tmpdir(), "audit-cas-"));
  const path = join(folder, "config.json");
  const initial = "original";
  await writeFile(path, initial);
  const sha = createHash("sha256").update(initial).digest("hex");
  coordination.arm = true;
  try {
    const results = await Promise.all([
      compareAndSwapText(path, sha, "writer-one"),
      compareAndSwapText(path, sha, "writer-two"),
    ]);
    const final = await readFile(path, "utf8");
    const ok = results.filter((result) => result.status === "ok");
    expect(ok.length, JSON.stringify({ results, final })).toBe(1);
    expect(results.filter((result) => result.status === "conflict").length).toBe(1);
    expect(ok[0]?.afterSha256).toBe(createHash("sha256").update(final).digest("hex"));
    expect(ok[0]?.changed).toBe(true);
  } finally {
    coordination.arm = false;
    await rm(folder, { recursive: true, force: true });
  }
});

it("A-026 a dead lock file does not block the next writer", async () => {
  const folder = await mkdtemp(join(tmpdir(), "audit-cas-stale-"));
  const path = join(folder, "config.json");
  const initial = "original";
  await writeFile(path, initial);
  const sha = createHash("sha256").update(initial).digest("hex");
  const lock = join(folder, ".config.json.lane-pilot-cas.lock");
  await writeFile(lock, "2147483646 0\n");
  const old = new Date(Date.now() - 60_000);
  await utimes(lock, old, old);
  try {
    const result = await compareAndSwapText(path, sha, "recovered");
    expect(result.status, result.reason ?? "").toBe("ok");
    expect(await readFile(path, "utf8")).toBe("recovered");
  } finally { await rm(folder, { recursive: true, force: true }); }
});
