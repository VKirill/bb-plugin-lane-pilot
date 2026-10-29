import { lstat, mkdir, readdir, readFile, rename } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser/lib/esm/main.js";
import { compareAndSwapText, readTextState, withCasLock } from "./cas";

const PLUGIN_ID = "codex-lane@claude-lane-stack";
const HOOKS_SUFFIX = ".agents/hooks/";
const STATUSLINE_SUFFIX = ".agents/bin/lane-statusline";
const NAMED_BINS = new Set(["lane-memory", "run-controller", "lane-ctl", "lane-statusline"]);
const UNTOUCHED = [".agents/skills", ".agents/state", ".agents/memory"];

export type LeftoverReport = {
  apply: boolean;
  changed: boolean;
  settings: string[];
  codex: string[];
  moved: string[];
  backupDir: string | null;
};

function commandPointsAt(command: string, home: string, suffix: string): boolean {
  const forms = [join(home, suffix), `~/${suffix}`, `$HOME/${suffix}`, `\${HOME}/${suffix}`];
  return forms.some((form) => {
    let from = 0;
    while (from < command.length) {
      const at = command.indexOf(form, from);
      if (at < 0) return false;
      const after = command[at + form.length];
      if (suffix.endsWith("/") || !after || /[\s'"`;|&]/.test(after)) return true;
      from = at + form.length;
    }
    return false;
  });
}

function hookCommand(item: unknown): string | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const command = (item as { command?: unknown }).command;
  return typeof command === "string" ? command : null;
}

function stripHookGroups(groups: unknown[], home: string, removed: string[]): unknown[] {
  const kept = [];
  for (const group of groups) {
    if (!group || typeof group !== "object" || Array.isArray(group)) { kept.push(group); continue; }
    const row = group as Record<string, unknown>;
    const own = hookCommand(row);
    if (own && commandPointsAt(own, home, HOOKS_SUFFIX)) { removed.push(own); continue; }
    if (!Array.isArray(row.hooks)) { kept.push(group); continue; }
    const nested = row.hooks.filter((item) => {
      const command = hookCommand(item);
      if (command && commandPointsAt(command, home, HOOKS_SUFFIX)) { removed.push(command); return false; }
      return true;
    });
    if (nested.length === 0) continue;
    kept.push({ ...row, hooks: nested });
  }
  return kept;
}

/** Drops hook commands under ~/.agents/hooks/ and a statusLine that runs lane-statusline. Other entries stay. */
export function stripClaudeLaneSettings(text: string, home: string): { text: string; removed: string[] } {
  const errors: ParseError[] = [];
  const parsed = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length || !parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { text, removed: [] };
  const root = parsed as Record<string, unknown>;
  const removed: string[] = [];
  const options = { formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" as const } };
  let next = text;
  if (root.hooks && typeof root.hooks === "object" && !Array.isArray(root.hooks)) {
    const hooks: Record<string, unknown> = {};
    for (const [event, groups] of Object.entries(root.hooks as Record<string, unknown>)) {
      if (!Array.isArray(groups)) { hooks[event] = groups; continue; }
      const kept = stripHookGroups(groups, home, removed);
      if (kept.length) hooks[event] = kept;
    }
    if (removed.length) next = applyEdits(next, modify(next, ["hooks"], Object.keys(hooks).length ? hooks : undefined, options));
  }
  const status = root.statusLine;
  const statusCommand = typeof status === "string" ? status : hookCommand(status) ?? "";
  if (statusCommand && commandPointsAt(statusCommand, home, STATUSLINE_SUFFIX)) {
    removed.push(statusCommand);
    next = applyEdits(next, modify(next, ["statusLine"], undefined, options));
  }
  return { text: next, removed };
}

/** Drops the codex-lane plugin table and its hooks.state entries. Other plugins stay. */
export function stripCodexLaneConfig(text: string): { text: string; removed: string[] } {
  const removed: string[] = [];
  const out: string[] = [];
  let skipping = false;
  for (const line of text.split("\n")) {
    const header = /^\[+([^\]\n]+)\]+\s*$/.exec(line.trim());
    if (header) {
      skipping = header[1].includes(PLUGIN_ID);
      if (skipping) { removed.push(line.trim()); continue; }
    }
    if (skipping) { if (line.trim()) removed.push(line.trim()); continue; }
    if (line.includes(PLUGIN_ID)) { removed.push(line.trim()); continue; }
    out.push(line);
  }
  if (removed.length === 0) return { text, removed };
  let next = out.join("\n");
  if (text.endsWith("\n") && !next.endsWith("\n")) next += "\n";
  if (!text.endsWith("\n") && next.endsWith("\n")) next = next.slice(0, -1);
  return { text: next, removed };
}

function isLaneBin(name: string): boolean {
  return NAMED_BINS.has(name) || name.startsWith("lane-");
}

function assertUntouched(home: string, path: string): void {
  const rel = relative(home, path);
  if (rel.startsWith("..") || UNTOUCHED.some((item) => rel === item || rel.startsWith(`${item}${sep}`))) {
    throw new Error(`refusing to touch ${rel}`);
  }
}

async function present(path: string): Promise<boolean> {
  return lstat(path).then(() => true, () => false);
}

async function plannedMoves(home: string): Promise<string[]> {
  const paths: string[] = [];
  const hooks = join(home, ".agents/hooks");
  if (await present(hooks)) paths.push(hooks);
  const bin = join(home, ".agents/bin");
  const entries = await readdir(bin).catch(() => [] as string[]);
  for (const name of entries) if (isLaneBin(name)) paths.push(join(bin, name));
  const checkout = join(home, ".local/share/claude-lane-stack-installed");
  if (await present(checkout)) paths.push(checkout);
  for (const path of paths) assertUntouched(home, path);
  return paths;
}

async function writeText(path: string, next: string): Promise<void> {
  const before = await readTextState(path);
  if (before.text === null || before.text === next) return;
  const wrote = await compareAndSwapText(path, before.sha256, next);
  if (wrote.status !== "ok") throw new Error(wrote.reason ?? `CAS ${wrote.status}: ${path}`);
}

/**
 * One-time cleanup of Claude Lane files on this home.
 * Dry-run unless apply is set. Moves leftovers aside; never deletes them. (2026-10-29)
 */
export async function removeClaudeLaneLeftovers(input: { home: string; apply?: boolean }): Promise<LeftoverReport> {
  const { home } = input;
  const apply = input.apply === true;
  const settingsPath = join(home, ".claude/settings.json");
  const codexPath = join(home, ".codex/config.toml");
  const settingsRaw = await readFile(settingsPath, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  const codexRaw = await readFile(codexPath, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  const settings = settingsRaw === null ? { text: "", removed: [] as string[] } : stripClaudeLaneSettings(settingsRaw, home);
  const codex = codexRaw === null ? { text: "", removed: [] as string[] } : stripCodexLaneConfig(codexRaw);
  const settingsChanged = settingsRaw !== null && settings.text !== settingsRaw;
  const codexChanged = codexRaw !== null && codex.text !== codexRaw;
  const moves = await plannedMoves(home);
  const changed = settingsChanged || codexChanged || moves.length > 0;
  if (!apply) return { apply: false, changed, settings: settings.removed, codex: codex.removed, moved: moves, backupDir: null };
  if (settingsChanged) await writeText(settingsPath, settings.text);
  if (codexChanged) await writeText(codexPath, codex.text);
  let backupDir: string | null = null;
  const moved: string[] = [];
  if (moves.length) {
    backupDir = join(home, ".lane-pilot/claude-lane-leftovers", new Date().toISOString().replace(/[:.]/g, "-"));
    await mkdir(backupDir, { recursive: true });
    for (const source of moves) {
      assertUntouched(home, source);
      const dest = join(backupDir, relative(home, source).replaceAll("/", "__"));
      await withCasLock(source, async () => {
        if (!await present(source)) return;
        await rename(source, dest);
        moved.push(source);
      });
    }
  }
  return { apply: true, changed: settingsChanged || codexChanged || moved.length > 0, settings: settings.removed, codex: codex.removed, moved, backupDir: moved.length ? backupDir : null };
}
