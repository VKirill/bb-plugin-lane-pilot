import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readlink, rename, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser/lib/esm/main.js";

export type OwnedFile = { path: string; payload: string; mode: number; link?: string; hash: string };
export type OwnedJson = { path: string; key: string[]; value: unknown; array: boolean; existed: boolean; parents: string[][] };
export type OwnedBlock = { path: string; text: string };
export type NativeInstallManifest = {
  schemaVersion: 1; home: string; sourceSha: string; files: OwnedFile[]; json: OwnedJson[];
  blocks: OwnedBlock[]; preserved: string[]; createdConfigs: string[]; createdDirs: string[]; state: "prepared" | "enabled" | "disabled";
};

export const hashBytes = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");
const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export async function atomicText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(tmp, text, { mode: 0o600, flag: "wx" }); await rename(tmp, path); }
  finally { await rm(tmp, { force: true }); }
}

export async function safeTarget(home: string, name: string): Promise<string> {
  const target = resolve(home, name), rel = relative(home, target);
  if (isAbsolute(name) || rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Invalid managed install path");
  let parent = dirname(target);
  while (parent !== resolve(home)) {
    const info = await lstat(parent).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    if (info?.isSymbolicLink()) throw new Error(`Managed install parent is a symlink: ${parent}`);
    parent = dirname(parent);
  }
  return target;
}

async function fingerprint(path: string): Promise<string | null> {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  if (!info) return null;
  if (info.isSymbolicLink()) return hashBytes(`link:${await readlink(path)}`);
  if (!info.isFile()) throw new Error(`Managed target is not a file: ${path}`);
  return hashBytes(await readFile(path));
}

async function jsonText(path: string): Promise<{ text: string; value: Record<string, unknown> }> {
  if ((await lstat(path).catch(() => null))?.isSymbolicLink()) throw new Error(`Config is a symlink: ${path}`);
  const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return "{}\n"; throw error; });
  const errors: ParseError[] = [], value: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length || !value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid config: ${path}`);
  return { text, value: value as Record<string, unknown> };
}

function at(value: unknown, key: string[]): unknown {
  for (const part of key) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

export async function planJson(home: string, path: string, desired: Record<string, unknown>): Promise<OwnedJson[]> {
  const current = (await jsonText(await safeTarget(home, path))).value, edits: OwnedJson[] = [];
  function entry(key: string[], value: unknown, array: boolean): OwnedJson {
    return { path, key, value, array, existed: at(current, key) !== undefined, parents: key.slice(0, -1).map((_, i) => key.slice(0, i + 1)).filter((parent) => at(current, parent) === undefined) };
  }
  function visit(value: unknown, key: string[]): void {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [name, item] of Object.entries(value)) visit(item, [...key, name]);
    } else if (Array.isArray(value)) {
      const before = at(current, key);
      if (before !== undefined && !Array.isArray(before)) throw new Error(`Invalid array at ${path}:${key.join(".")}`);
      const added = value.filter((item) => !(before as unknown[] | undefined)?.some((old) => equal(old, item)));
      if (added.length) edits.push(entry(key, added, true));
    } else if (at(current, key) === undefined) edits.push(entry(key, value, false));
  }
  visit(desired, []);
  return edits;
}

export async function planFile(home: string, file: OwnedFile): Promise<boolean> {
  const current = await fingerprint(await safeTarget(home, file.path));
  return current === null;
}

export async function transitionOwned(root: string, manifest: NativeInstallManifest, action: "enable" | "disable" | "remove", signal?: AbortSignal): Promise<void> {
  const enabling = action === "enable";
  for (const file of manifest.files) {
    signal?.throwIfAborted();
    const current = await fingerprint(await safeTarget(manifest.home, file.path));
    if (current !== null && current !== file.hash) throw new Error(`Managed file changed; preserved: ${file.path}`);
  }
  if (enabling) {
    for (const name of [...manifest.files.map((file) => file.path), ...manifest.createdConfigs]) {
      let parent = dirname(await safeTarget(manifest.home, name));
      while (parent !== resolve(manifest.home)) {
        if (!await lstat(parent).catch(() => null)) {
          const relativePath = relative(manifest.home, parent);
          if (!manifest.createdDirs.includes(relativePath)) manifest.createdDirs.push(relativePath);
        }
        parent = dirname(parent);
      }
    }
    await atomicText(join(root, "manifest.json"), JSON.stringify(manifest));
  }
  for (const file of manifest.files) {
    signal?.throwIfAborted();
    const target = await safeTarget(manifest.home, file.path), current = await fingerprint(target);
    if (current !== null && current !== file.hash) throw new Error(`Managed file changed; preserved: ${file.path}`);
    if (enabling && current === null) {
      await mkdir(dirname(target), { recursive: true });
      if (file.link !== undefined) await symlink(file.link, target);
      else {
        const bytes = await readFile(await safeTarget(root, file.payload));
        if (hashBytes(bytes) !== file.hash) throw new Error(`Install payload changed: ${file.path}`);
        await writeFile(target, bytes, { flag: "wx", mode: file.mode });
        await chmod(target, file.mode);
      }
    } else if (!enabling && current !== null) await rm(target);
  }
  for (const edit of manifest.json) {
    signal?.throwIfAborted();
    const path = await safeTarget(manifest.home, edit.path), { text, value } = await jsonText(path), current = at(value, edit.key);
    let next: unknown;
    if (edit.array) {
      if (current !== undefined && !Array.isArray(current)) throw new Error(`Managed config changed: ${edit.path}`);
      const items = current as unknown[] | undefined ?? [], owned = edit.value as unknown[];
      next = enabling ? [...items, ...owned.filter((item) => !items.some((old) => equal(old, item)))] : items.filter((item) => !owned.some((old) => equal(old, item)));
      if ((next as unknown[]).length === 0 && !edit.existed) next = undefined;
    } else {
      if (current !== undefined && !equal(current, edit.value)) throw new Error(`Managed config changed; preserved: ${edit.path}:${edit.key.join(".")}`);
      next = enabling ? edit.value : undefined;
    }
    let updated = equal(current, next) ? text : applyEdits(text, modify(text, edit.key, next, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
    if (!enabling) for (const parent of [...edit.parents].reverse()) {
      const value = at(parse(updated), parent);
      if (value && typeof value === "object" && Object.keys(value).length === 0) updated = applyEdits(updated, modify(updated, parent, undefined, {}));
    }
    if (text !== updated) await atomicText(path, updated);
  }
  for (const block of manifest.blocks) {
    signal?.throwIfAborted();
    const path = await safeTarget(manifest.home, block.path);
    if ((await lstat(path).catch(() => null))?.isSymbolicLink()) throw new Error(`Config is a symlink: ${path}`);
    const current = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return ""; throw error; });
    const begin = "# lane-pilot:managed:start", end = "# lane-pilot:managed:end";
    const start = current.indexOf(begin), finish = current.indexOf(end);
    const expected = `${begin}\n${block.text.trim()}\n${end}\n`;
    if ((start < 0) !== (finish < 0) || (start >= 0 && current.slice(start, finish + end.length + 1) !== expected)) throw new Error(`Managed config block changed; preserved: ${block.path}`);
    if (enabling && start < 0) await atomicText(path, `${current}${current.endsWith("\n") || !current ? "" : "\n"}${expected}`);
    else if (!enabling && start >= 0) await atomicText(path, current.slice(0, start) + current.slice(finish + end.length + 1));
  }
  if (!enabling) {
    for (const name of manifest.createdConfigs) {
      const path = await safeTarget(manifest.home, name);
      const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return ""; throw error; });
      if (!text.trim() || (name.endsWith(".json") || name.endsWith(".jsonc")) && Object.keys(parse(text) ?? {}).length === 0) await rm(path, { force: true });
    }
    for (const name of [...manifest.createdDirs].sort((a, b) => b.length - a.length)) await rmdir(await safeTarget(manifest.home, name)).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error; });
  }
  manifest.state = enabling ? "enabled" : "disabled";
  await atomicText(join(root, "manifest.json"), JSON.stringify(manifest));
}
