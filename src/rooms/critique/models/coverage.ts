export type CoverageFinding = {
  code:
    | "plan_path_unowned"
    | "owns_gap"
    | "coverage_scan_truncated"
    | "owns_overlap"
    | "verify_missing"
    | "verify_heavy"
    | "owns_empty"
    | "plan_missing"
    | "no_tasks"
    | "caller_unowned"
    | "task_placeholder"
    | "output_unowned"
    | "output_binary"
    | "verify_filter_ignored"
    | "depends_cycle"
    | "depends_self";
  path: string;
  severity: "error" | "warning" | "info";
  finding: string;
};

/** The direct callers GitNexus found for one symbol of an owned file: up to 5 as `file:symbol`, and how many there are in all. */
export type CoverageCallers = { file: string; symbol: string; callers: string[]; total: number };
export type CoverageScan = { status: "complete" | "truncated"; pathCount: number; findings: CoverageFinding[]; callers?: CoverageCallers[] };

export function covered(pattern: string, path: string): boolean {
  const a = pattern.replace(/\\/g, "/").replace(/^\.\//, "").split("/");
  const b = path.split("/");
  for (let i = 0; i < a.length; i++) {
    const part = a[i]!;
    if (part === "**") return i === a.length - 1;
    const value = b[i];
    if (value === undefined) return false;
    const escaped = part.split("*").map((chunk) => chunk.replace(/[.+^${}()|[\]\\]/g, "\\$&")).join(".*");
    if (!new RegExp(`^${escaped}$`).test(value)) return false;
  }
  return a.length === b.length;
}

/** Generated or index output and documentation: a file there that mentions an owned target is not a missing owner (hub 2026-11: index json, .nuxt/types, PROJECT.md, docs/** filled the critic's prompt). */
const GENERATED_DIR = /(^|\/)(\.gitnexus|\.nuxt|\.next|node_modules|dist|build|coverage|\.cache)\//;
const DOC_FILE = /\.(md|mdx)$|(^|\/)docs\//i;
export function noisyCoveragePath(path: string): boolean {
  const clean = path.replace(/\\/g, "/").replace(/^\.\//, "");
  return GENERATED_DIR.test(clean) || DOC_FILE.test(clean);
}

const BINARY = /\.(?:woff2?|ttf|otf|eot|png|jpe?g|gif|webp|avif|ico|pdf|zip|gz|mp3|mp4|mov|wasm)$/i;
/** Expected outputs a model cannot author (fonts, images, archives, media, wasm). */
export function binaryOutputs(outputs: readonly string[]): string[] {
  return outputs.filter((entry) => BINARY.test(entry.trim()));
}

/** `npm -w ws run test -- args` / `pnpm --filter ws test -- args`: the workspace and the script that receives a filter after «--». */
export function filteredScriptRun(command: string): { ws: string; script: string } | null {
  for (const part of command.split(/&&|;|\|\|/)) {
    const tokens = part.trim().split(/\s+/), manager = tokens[0], cut = tokens.indexOf("--");
    if ((manager !== "npm" && manager !== "pnpm") || cut < 0 || cut === tokens.length - 1) continue;
    const flag = manager === "npm" ? /^(?:-w|--workspace)$/ : /^(?:-F|--filter)$/, words: string[] = [];
    let ws = "";
    for (let i = 1; i < cut; i++) {
      const token = tokens[i]!, inline = /^(?:--workspace|--filter)=(.+)$/.exec(token);
      if (inline) ws = inline[1]!;
      else if (flag.test(token)) ws = tokens[++i] ?? "";
      else if (!token.startsWith("-")) words.push(token);
    }
    ws = ws.replace(/^["']|["']$/g, "");
    const verb = words[0], script = verb === "run" || verb === "run-script" ? words[1] : verb === "t" ? "test" : manager === "pnpm" || verb === "test" ? verb : undefined;
    if (ws && script) return { ws, script };
  }
  return null;
}

/** A script whose last command is `node --test`: npm appends the filter after «--», and that runner runs every file anyway. */
export function ignoresTrailingFilter(script: string): boolean {
  const last = script.split(/&&|;|\|\|/).pop()!.trim();
  return /(?:^|\s)(?:node|tsx)\s(?:\S+\s)*?--test(?:\s|$)/.test(last);
}

export function findTaskPlaceholderPaths(value: unknown): string[] {
  const found: string[] = [];
  let visited = 0;
  const walk = (item: unknown, path: string, depth: number): void => {
    if (found.length >= 8 || visited >= 256 || depth > 8) return;
    visited++;
    if (typeof item === "string") { if (item.includes("REPLACE_ME")) found.push(path || "<root>"); return; }
    if (Array.isArray(item)) { item.forEach((child, index) => walk(child, `${path}[${index}]`, depth + 1)); return; }
    if (item && typeof item === "object") for (const [key, child] of Object.entries(item)) walk(child, path ? `${path}.${key}` : key, depth + 1);
  };
  walk(value, "", 0);
  return found;
}

const GAP_CODES = new Set<CoverageFinding["code"]>(["owns_gap", "caller_unowned", "plan_path_unowned"]);
/** «Nobody owns X» is no gap when the task forbids X on purpose (never_touch): the critic got these as noise (audit 2026-11-08). */
export function dropIntendedGaps(findings: readonly CoverageFinding[], neverTouch: readonly string[]): CoverageFinding[] {
  return findings.filter((finding) => !(GAP_CODES.has(finding.code) && neverTouch.some((pattern) => covered(pattern, finding.path))));
}
/** A host that scans with older code may still list a generated or documentation file as an unowned referrer: drop those here. A plan's own mention (plan_path_unowned) stays. */
export function dropNoisyGaps(findings: readonly CoverageFinding[]): CoverageFinding[] {
  return findings.filter((finding) => !((finding.code === "owns_gap" || finding.code === "caller_unowned") && noisyCoveragePath(finding.path)));
}
