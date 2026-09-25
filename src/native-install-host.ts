import type { ExperimentalHostRpcHandlers } from "@get-bb/plugin-sdk";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { z } from "zod";
import type { hostContract } from "./contracts";
import { bootstrapNative } from "./native-install-bootstrap";
import { transitionOwned } from "./native-install-owned";

const manifestSchema = z.object({
  schemaVersion: z.literal(1), home: z.string(), sourceSha: z.string().regex(/^[a-f0-9]{40}$/),
  state: z.enum(["prepared", "enabled", "disabled"]),
  files: z.array(z.object({ path: z.string(), payload: z.string(), mode: z.number().int(), link: z.string().optional(), hash: z.string() })),
  json: z.array(z.object({ path: z.string(), key: z.array(z.string()), value: z.unknown(), array: z.boolean(), existed: z.boolean(), parents: z.array(z.array(z.string())) })),
  blocks: z.array(z.object({ path: z.string(), text: z.string() })),
  preserved: z.array(z.string()), createdConfigs: z.array(z.string()), createdDirs: z.array(z.string()),
});

export async function nativeInstallOperation(input: { root: string; home: string; action: "install" | "enable" | "disable" | "remove" | "status"; signal?: AbortSignal }) {
  const { root, home, action, signal } = input;
  const lock = `${root}.lock`;
  await mkdir(root, { recursive: true });
  await mkdir(lock).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
    const pid = Number(await readFile(join(lock, "pid"), "utf8").catch(() => ""));
    let stale = false;
    if (Number.isInteger(pid) && pid > 0) try { process.kill(pid, 0); } catch (error) { stale = (error as NodeJS.ErrnoException).code === "ESRCH"; }
    if (!stale) throw new Error("Native installation is already being changed. Retry when it finishes.");
    await rm(lock, { recursive: true }); await mkdir(lock);
  });
  await writeFile(join(lock, "pid"), String(process.pid));
  try {
    const raw = await readFile(join(root, "manifest.json"), "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    let manifest = raw ? manifestSchema.parse(JSON.parse(raw)) : null;
    if (manifest && manifest.home !== home) throw new Error("Native installation belongs to a different home");
    signal?.throwIfAborted();
    if (action !== "status") {
      if (!manifest && (action === "install" || action === "enable")) manifest = await bootstrapNative({ root, home, signal });
      else if (manifest) await transitionOwned(root, manifest, action === "install" ? "enable" : action, signal);
      if (action === "remove") await rm(root, { recursive: true, force: true });
    }
    return { status: action === "remove" || !manifest ? "absent" as const : manifest.state, sourceSha: manifest?.sourceSha ?? null, ownedFiles: manifest?.files.length ?? 0, preservedFiles: manifest?.preserved.length ?? 0 };
  } finally { await rm(lock, { recursive: true, force: true }); }
}

export const nativeInstallHost: ExperimentalHostRpcHandlers<typeof hostContract>["nativeInstall"] = async (input, context) => {
  if (process.env.BB_HOST_ID && process.env.BB_HOST_ID !== input.requestedHostId) throw new Error("Native installation host mismatch");
  return nativeInstallOperation({ root: join(context.experimental_paths.dataDir, "native-install"), home: homedir(), action: input.action, signal: context.signal });
};
