/**
 * The machine facts of the host a check runs on, for `diskFree`'s optional `machine` answer (see machine-pressure.ts for what they
 * are for). Runs in the host worker. Node's `os.freemem()` on macOS counts only never-used pages and reads about 0 % on a healthy
 * Mac, so there the available memory is free + inactive + speculative pages from `vm_stat`; a number that cannot be read is null.
 */

import { execFile } from "node:child_process";
import { cpus, freemem, loadavg, platform, totalmem } from "node:os";
import { promisify } from "node:util";

export type HostMachineFacts = { load1: number | null; cpuCount: number | null; memFreeBytes: number | null; memTotalBytes: number | null };

/** Bytes a new program can get on macOS, from `vm_stat` text; null when the page size or the counters are missing. */
export function darwinAvailableBytes(vmStat: string): number | null {
  const pageSize = Number(/page size of (\d+) bytes/.exec(vmStat)?.[1]);
  const pages = (name: string) => Number(new RegExp(`^Pages ${name}:\\s+(\\d+)`, "m").exec(vmStat)?.[1]);
  const counted = [pages("free"), pages("inactive"), pages("speculative")];
  return pageSize > 0 && counted.every(Number.isFinite) ? pageSize * counted.reduce((sum, count) => sum + count, 0) : null;
}

export async function readMachineFacts(): Promise<HostMachineFacts> {
  let memFreeBytes: number | null = freemem();
  if (platform() === "darwin") {
    memFreeBytes = await promisify(execFile)("vm_stat", [], { timeout: 2000, encoding: "utf8" }).then(({ stdout }) => darwinAvailableBytes(stdout), () => null);
  }
  return { load1: platform() === "win32" ? null : loadavg()[0] ?? null, cpuCount: cpus().length || null, memFreeBytes, memTotalBytes: totalmem() || null };
}
