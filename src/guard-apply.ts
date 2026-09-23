import { cp, lstat, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { applyEdits, findNodeAtLocation, modify, parse, parseTree, type ParseError } from "jsonc-parser/lib/esm/main.js";
import { defaultGuardSource } from "./paths";
import { hashPath } from "./hash";
import { compareAndSwapText, readTextState } from "./coexistence/cas";

export type GuardAppliedFile = { path: string; sha256Before: string | null; sha256After: string };

const GUARD_RELATIVE_PATH = ".agents/lane-pilot/pm/guard_shell.py";

export function ownedPmGuardPath(homeDir: string): string {
  return join(homeDir, GUARD_RELATIVE_PATH);
}

async function hashOrNull(path: string): Promise<string | null> {
  try { return (await hashPath(path)).sha256; }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function copyOwnedFile(source: string, destination: string): Promise<GuardAppliedFile | null> {
  const sourceInfo = await lstat(source);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new Error(`guard source is not a regular file: ${source}`);
  const sourceHash = (await hashPath(source)).sha256;
  if (!sourceHash) throw new Error(`guard source could not be hashed: ${source}`);
  const existing = await hashOrNull(destination);
  if (existing !== null) {
    const destinationInfo = await lstat(destination);
    if (!destinationInfo.isFile() || destinationInfo.isSymbolicLink() || existing !== sourceHash) {
      throw new Error(`Lane Pilot-owned guard target has diverged and was preserved: ${destination}`);
    }
    return null;
  }

  await mkdir(dirname(destination), { recursive: true });
  try {
    await cp(source, destination, { errorOnExist: true, force: false });
  } catch (error) {
    if (await hashOrNull(destination) === sourceHash) return null;
    throw error;
  }
  return { path: destination, sha256Before: null, sha256After: sourceHash };
}

function commandFor(path: string): string {
  return `python3 '${path.replaceAll("'", "'\\''")}'`;
}

function existingPreToolUseCommand(parsed: unknown, command: string): boolean {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const hooks = (parsed as Record<string, unknown>).hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return false;
  const entries = (hooks as Record<string, unknown>).PreToolUse;
  if (!Array.isArray(entries)) return false;
  return entries.some((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const nested = (entry as Record<string, unknown>).hooks;
    return Array.isArray(nested) && nested.some((item) =>
      item && typeof item === "object" && !Array.isArray(item)
      && (item as Record<string, unknown>).command === command,
    );
  });
}

function addPreToolUseGuard(raw: string, command: string): string {
  const errors: ParseError[] = [];
  const tree = parseTree(raw, errors, { allowTrailingComma: true, disallowComments: false });
  if (!tree || errors.length > 0 || tree.type !== "object") throw new Error("Claude workspace settings are not valid JSONC object; preserving them");
  const hooksNode = findNodeAtLocation(tree, ["hooks"]);
  if (hooksNode && hooksNode.type !== "object") throw new Error("Claude workspace hooks are not an object; preserving settings");
  const preToolUseNode = findNodeAtLocation(tree, ["hooks", "PreToolUse"]);
  if (preToolUseNode && preToolUseNode.type !== "array") throw new Error("Claude PreToolUse hooks are not an array; preserving settings");
  const parsed = parse(raw, [], { allowTrailingComma: true, disallowComments: false });
  if (existingPreToolUseCommand(parsed, command)) return raw;

  const entry = { matcher: "*", hooks: [{ type: "command", command }] };
  const edits = preToolUseNode
    ? modify(raw, ["hooks", "PreToolUse", -1], entry, {
      isArrayInsertion: true,
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
    })
    : modify(raw, ["hooks", "PreToolUse"], [entry], {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
    });
  return applyEdits(raw, edits);
}

async function addGuardToWorkspaceSettings(path: string, guardPath: string): Promise<GuardAppliedFile | null> {
  const before = await readTextState(path);
  const raw = before.text ?? "{}\n";
  const next = addPreToolUseGuard(raw, commandFor(guardPath));
  if (next === raw) return null;
  const write = await compareAndSwapText(path, before.sha256, next);
  if (write.status !== "ok") throw new Error(write.reason ?? `Claude workspace settings CAS ${write.status}: ${path}`);
  if (!write.changed || !write.afterSha256) return null;
  return { path, sha256Before: write.beforeSha256, sha256After: write.afterSha256 };
}

export async function applyInstalledGuard(input: {
  homeDir: string;
  guardSourcePath?: string;
  moduleUrl?: string;
  pmWorkspacePath?: string;
}): Promise<{ guardPath: string; settingsPath: string | null; filesChanged: GuardAppliedFile[] }> {
  const source = input.guardSourcePath
    ?? (input.moduleUrl ? defaultGuardSource(input.moduleUrl) : "");
  if (!source) throw new Error("guard source path is required");
  const guardPath = ownedPmGuardPath(input.homeDir);
  const filesChanged: GuardAppliedFile[] = [];
  const guardChange = await copyOwnedFile(source, guardPath);
  if (guardChange) filesChanged.push(guardChange);

  const libSource = join(dirname(source), "lib_payload.py");
  const libDest = join(dirname(guardPath), "lib_payload.py");
  try {
    const payloadChange = await copyOwnedFile(libSource, libDest);
    if (payloadChange) filesChanged.push(payloadChange);
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }

  let settingsPath: string | null = null;
  if (input.pmWorkspacePath) {
    settingsPath = join(input.pmWorkspacePath, ".claude/settings.json");
    const settingsChange = await addGuardToWorkspaceSettings(settingsPath, guardPath);
    if (settingsChange) filesChanged.push(settingsChange);
  }
  return { guardPath, settingsPath, filesChanged };
}

export async function isOwnedPmGuardApplied(input: {
  homeDir: string;
  guardSourcePath?: string;
  moduleUrl?: string;
  pmWorkspacePath: string;
}): Promise<boolean> {
  const source = input.guardSourcePath
    ?? (input.moduleUrl ? defaultGuardSource(input.moduleUrl) : "");
  if (!source) return false;
  const guardPath = ownedPmGuardPath(input.homeDir);
  const [sourceHash, installedHash] = await Promise.all([hashOrNull(source), hashOrNull(guardPath)]);
  if (!sourceHash || installedHash !== sourceHash) return false;
  const settingsPath = join(input.pmWorkspacePath, ".claude/settings.json");
  const settings = await readTextState(settingsPath);
  if (!settings.text) return false;
  const errors: ParseError[] = [];
  const parsed = parse(settings.text, errors, { allowTrailingComma: true, disallowComments: false });
  return errors.length === 0 && existingPreToolUseCommand(parsed, commandFor(guardPath));
}
