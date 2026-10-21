import { lstat, readFile, realpath } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { isAbsolute, resolve, sep } from "node:path";

// OpenCode v2 contract of Lane Stack's opencode-lane plugin (1.66+): a definition `{ id, setup }` whose setup registers the
// v2 hooks. The v1 hook names (event, chat.message, chat.params, tool.execute.after, messages.transform) and the Cursor ACP
// tool route of v1 lane-session are no longer checked: Lane Pilot's threads run on OpenCode v2 only.
export const REQUIRED_CAPABILITIES = [
  "opencode.plugin.default_export",
  "opencode.hook.event_subscribe",
  "opencode.hook.session_prompt",
  "opencode.hook.session_context",
  "opencode.hook.tool_execute_before",
  "opencode.hook.tool_execute_after",
  "opencode.hook.permission_evaluate",
  "opencode.telemetry.session_compacted",
  "opencode.sticky.contract_recovery",
  "opencode.sticky.dumped_tool_recovery",
  "execution_packet.line_windows",
] as const;

export type RequiredCapability = (typeof REQUIRED_CAPABILITIES)[number];
export type EngineCapability = RequiredCapability | (string & {});

/** What Lane Pilot does itself when the engine lacks it (read-first line windows: tasks/read-first.ts). */
export const ADAPTER_CAPABILITIES = [
  "execution_packet.line_windows",
] as const satisfies readonly RequiredCapability[];

const ADAPTABLE = new Set<string>(ADAPTER_CAPABILITIES);

export const IMPACTED_FUNCTIONS: Record<RequiredCapability, string> = {
  "opencode.plugin.default_export": "OpenCode v2 plugin module loading (a default { id, setup } definition)",
  "opencode.hook.event_subscribe": "OpenCode session lifecycle and compaction event telemetry",
  "opencode.hook.session_prompt": "OpenCode prompt state and sticky task contract",
  "opencode.hook.session_context": "OpenCode sticky task/evidence message recovery",
  "opencode.hook.tool_execute_before": "OpenCode lane writer guard",
  "opencode.hook.tool_execute_after": "OpenCode tool evidence, budget, and winnow result handling",
  "opencode.hook.permission_evaluate": "OpenCode lane agent rules and hub command guard",
  "opencode.telemetry.session_compacted": "OpenCode compacted-session telemetry and recovery",
  "opencode.sticky.contract_recovery": "OpenCode lane contract recovery after compaction",
  "opencode.sticky.dumped_tool_recovery": "OpenCode correction when a provider prints tool JSON instead of calling tools",
  "execution_packet.line_windows": "execution packet read_first line-window selection",
};

export type CapabilityAssessment = {
  compatible: boolean;
  capabilities: string[];
  adaptedCapabilities: RequiredCapability[];
  missingCapabilities: RequiredCapability[];
  diagnostics: Array<{ capability: RequiredCapability; impactedFunction: string; message: string }>;
};

export function assessEngineCapabilities(
  capabilities: Iterable<string>,
  options: { adapters?: Iterable<string> } = {},
): CapabilityAssessment {
  const found = new Set(capabilities);
  const adapters = new Set(options.adapters ?? ADAPTER_CAPABILITIES);
  const adaptedCapabilities: RequiredCapability[] = [];
  const missingCapabilities: RequiredCapability[] = [];

  for (const required of REQUIRED_CAPABILITIES) {
    if (found.has(required)) continue;
    if (ADAPTABLE.has(required) && adapters.has(required)) adaptedCapabilities.push(required);
    else missingCapabilities.push(required);
  }

  return {
    compatible: missingCapabilities.length === 0,
    capabilities: [...found].sort(),
    adaptedCapabilities,
    missingCapabilities,
    diagnostics: missingCapabilities.map((capability) => ({
      capability,
      impactedFunction: IMPACTED_FUNCTIONS[capability],
      message: `Missing required interface ${capability}; impacted function: ${IMPACTED_FUNCTIONS[capability]}.`,
    })),
  };
}

export type EngineDecision = "reuse" | "install" | "conflict";

export function decideEngine(
  assessment: CapabilityAssessment,
  state: { installed: boolean; modified?: boolean; owner?: "lane-pilot" | "user" | "upstream" | "unknown" },
): { decision: EngineDecision; compatible: boolean; writes: string[]; reason: string | null } {
  if (assessment.compatible && state.installed) {
    return { decision: "reuse", compatible: true, writes: [], reason: null };
  }
  if (state.installed && (state.modified || state.owner === "user" || state.owner === "unknown")) {
    return {
      decision: "conflict",
      compatible: false,
      writes: [],
      reason: assessment.diagnostics[0]?.message ?? "Existing user-owned engine is preserved.",
    };
  }
  return {
    decision: "install",
    compatible: assessment.compatible,
    writes: assessment.compatible ? [] : ["immutable-managed-engine"],
    reason: assessment.diagnostics[0]?.message ?? null,
  };
}

const WINDOW_RE = /L?~?(\d+)\s*[-–—]\s*L?~?(\d+)/gi;
const MAX_WINDOWS = 8;

export type LineWindow = { startLine: number; endLine: number };
export type PathWindows = { path: string; windows: LineWindow[] };

export function parseExecutionLineWindows(raw: string): PathWindows {
  const text = raw.trim();
  if (!text) return { path: "", windows: [] };
  // Line windows start after a separator («file.md:10-20», «file.md#L10-L20», «file.md 10-20»). Without one,
  // digits belong to the path: «.agents/plans/2026-10-02-cards.md» is a file, not «.agents/plans/» lines 2026-10.
  const start = /[:#\s]+(?=L?~?\d+\s*[-–—]\s*L?~?\d+)/i.exec(text);
  const path = start ? text.slice(0, start.index).trim() : text;
  const tail = start ? text.slice(start.index) : "";
  const windows: LineWindow[] = [];
  WINDOW_RE.lastIndex = 0;
  for (const match of tail.matchAll(WINDOW_RE)) {
    const startLine = Number(match[1]);
    const endLine = Number(match[2]);
    if (startLine < 1 || endLine < startLine) continue;
    windows.push({ startLine, endLine });
    if (windows.length === MAX_WINDOWS) break;
  }
  return { path: path.replace(/[,:;]+$/, ""), windows };
}

const MAX_SOURCE_BYTES = 512 * 1024;
const OPEN_CODE_ENTRY = "profiles/opencode/opencode-lane.ts";
const OPEN_CODE_INDEX = "profiles/opencode/opencode-lane/index.ts";
const OPEN_CODE_V2 = "profiles/opencode/opencode-lane/v2.ts";
const TELEMETRY_SOURCE = "profiles/opencode/opencode-lane/telemetry.ts";
const STICKY_SOURCE = "profiles/opencode/opencode-lane/sticky.ts";
/** The v2 registrations laneSetup must make: `ctx.<target>.<method>("<name>", …)` (`event.subscribe` takes no name). */
const HOOK_CAPABILITIES = [
  ["opencode.hook.event_subscribe", ["event", ".", "subscribe", "("]],
  ["opencode.hook.session_prompt", ["session", ".", "hook", "(", "prompt"]],
  ["opencode.hook.session_context", ["session", ".", "hook", "(", "context"]],
  ["opencode.hook.tool_execute_before", ["tool", ".", "hook", "(", "execute.before"]],
  ["opencode.hook.tool_execute_after", ["tool", ".", "hook", "(", "execute.after"]],
  ["opencode.hook.permission_evaluate", ["permission", ".", "hook", "(", "evaluate"]],
] as const satisfies ReadonlyArray<readonly [RequiredCapability, readonly string[]]>;

type ContractDiagnostic = { capability: RequiredCapability; path: string; detail: string };
type Token = { kind: "id" | "string" | "punct"; value: string };
type SourceRead = { text: string | null; error: string | null };

function sourceFailure(name: string): string {
  return `Executable interface was not verified: ${name}.`;
}

async function readBoundedSource(root: string, relative: string): Promise<SourceRead> {
  try {
    const absoluteRoot = await realpath(root);
    const path = resolve(absoluteRoot, relative);
    if (!path.startsWith(`${absoluteRoot}${sep}`) || isAbsolute(relative)) {
      return { text: null, error: "source path escaped the engine root" };
    }
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return { text: null, error: "source is not a regular file" };
    if (metadata.size > MAX_SOURCE_BYTES) return { text: null, error: `source exceeds ${MAX_SOURCE_BYTES} byte inspection limit` };
    const resolvedPath = await realpath(path);
    if (!resolvedPath.startsWith(`${absoluteRoot}${sep}`)) return { text: null, error: "source resolved outside the engine root" };
    const text = await readFile(path, "utf8");
    if (Buffer.byteLength(text, "utf8") > MAX_SOURCE_BYTES) return { text: null, error: `source exceeds ${MAX_SOURCE_BYTES} byte inspection limit` };
    return { text, error: null };
  } catch (error) {
    return { text: null, error: sourceFailure(error instanceof Error ? error.name : "read error") };
  }
}

function parseTypeScript(text: string): Token[] {
  let javascript: string;
  try {
    javascript = stripTypeScriptTypes(text, { mode: "strip" });
  } catch {
    throw new Error("TypeScript parse failed");
  }
  return tokenize(javascript);
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const push = (kind: Token["kind"], value: string) => tokens.push({ kind, value });
  while (i < source.length) {
    const char = source[i]!;
    if (/\s/.test(char)) { i += 1; continue; }
    if (char === "/" && source[i + 1] === "/") {
      i += 2;
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (char === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end < 0) throw new Error("unterminated comment");
      i = end + 2;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      const quote = char;
      let value = "";
      i += 1;
      let closed = false;
      while (i < source.length) {
        const next = source[i]!;
        if (next === "\\") {
          const escaped = source[i + 1];
          if (escaped === undefined) break;
          if (quote !== "`" && (escaped === quote || escaped === "\\")) value += escaped;
          else if (quote !== "`") value += `\\${escaped}`;
          i += 2;
          continue;
        }
        if (next === quote) { i += 1; closed = true; break; }
        if (quote !== "`" && (next === "\n" || next === "\r")) throw new Error("unterminated string");
        if (quote !== "`") value += next;
        i += 1;
      }
      if (!closed) throw new Error("unterminated string");
      push("string", quote === "`" ? "<template>" : value);
      continue;
    }
    if (/[A-Za-z_$]/.test(char)) {
      const start = i++;
      while (i < source.length && /[\w$]/.test(source[i]!)) i += 1;
      push("id", source.slice(start, i));
      continue;
    }
    if (/[0-9]/.test(char)) {
      const start = i++;
      while (i < source.length && /[\w.]/.test(source[i]!)) i += 1;
      push("punct", source.slice(start, i));
      continue;
    }
    if (char === "/" && canStartRegex(tokens[tokens.length - 1])) {
      i += 1;
      let inClass = false;
      let closed = false;
      while (i < source.length) {
        const next = source[i]!;
        if (next === "\\") { i += 2; continue; }
        if (next === "[") inClass = true;
        else if (next === "]") inClass = false;
        else if (next === "/" && !inClass) { i += 1; closed = true; break; }
        else if (next === "\n" || next === "\r") break;
        i += 1;
      }
      if (!closed) throw new Error("unterminated regular expression");
      while (i < source.length && /[A-Za-z]/.test(source[i]!)) i += 1;
      push("string", "<regex>");
      continue;
    }
    const punct = ["=>", "...", "===", "!==", "==", "!=", "?.", "++", "--", "&&", "||", "??", "<=", ">=", "**"].find((item) => source.startsWith(item, i));
    if (punct) { push("punct", punct); i += punct.length; continue; }
    push("punct", char);
    i += 1;
  }
  return tokens;
}

function canStartRegex(previous: Token | undefined): boolean {
  if (!previous) return true;
  if (previous.kind === "id") return ["return", "throw", "case", "delete", "typeof", "void", "instanceof", "in", "of", "yield", "await"].includes(previous.value);
  return ["=", "(", "[", "{", ":", ",", ";", "!", "?", "=>", "&&", "||", "??"].includes(previous.value);
}

function matching(tokens: Token[], start: number, open: string, close: string): number {
  if (tokens[start]?.value !== open) return -1;
  let depth = 0;
  for (let i = start; i < tokens.length; i += 1) {
    if (tokens[i]?.value === open) depth += 1;
    else if (tokens[i]?.value === close && --depth === 0) return i;
  }
  return -1;
}

function topLevelIndices(tokens: Token[]): number[] {
  const indices: number[] = [];
  let braces = 0;
  let parens = 0;
  let brackets = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    if (braces === 0 && parens === 0 && brackets === 0) indices.push(i);
    const value = tokens[i]!.value;
    if (value === "{") braces += 1;
    else if (value === "}") braces -= 1;
    else if (value === "(") parens += 1;
    else if (value === ")") parens -= 1;
    else if (value === "[") brackets += 1;
    else if (value === "]") brackets -= 1;
    if (braces < 0 || parens < 0 || brackets < 0) throw new Error("unbalanced module tokens");
  }
  if (braces !== 0 || parens !== 0 || brackets !== 0) throw new Error("unbalanced module tokens");
  return indices;
}

function topLevelHas(tokens: Token[], values: string[]): boolean {
  const indices = topLevelIndices(tokens);
  return indices.some((index) => values.every((value, offset) => tokens[index + offset]?.value === value));
}

function defaultReexportsExpectedModule(tokens: Token[]): boolean {
  return topLevelHas(tokens, ["export", "{", "default", "}", "from", "./opencode-lane/index.ts"]);
}

function callableArrowStart(tokens: Token[], start: number, end: number): number {
  for (let i = start; i < end; i += 1) {
    const value = tokens[i]!.value;
    if (value === "(") {
      const close = matching(tokens, i, "(", ")");
      if (close >= 0 && tokens[close + 1]?.value === "=>") return close + 1;
      if (close >= 0) { i = close; continue; }
    }
    if (tokens[i]?.kind === "id" && tokens[i + 1]?.value === "=>") return i + 1;
    if (value === "=>") return i;
    if (value === ";") break;
  }
  return -1;
}

function exportedFunction(tokens: Token[], name: string): { body: Token[]; callable: boolean } | null {
  for (const index of topLevelIndices(tokens)) {
    if (tokens[index]?.value !== "export") continue;
    let cursor = index + 1;
    if (tokens[cursor]?.value === "async") cursor += 1;
    if (tokens[cursor]?.value === "function" && tokens[cursor + 1]?.value === name) {
      const params = tokens.findIndex((token, at) => at > cursor + 1 && token.value === "(");
      const paramsEnd = params < 0 ? -1 : matching(tokens, params, "(", ")");
      const bodyStart = paramsEnd < 0 ? -1 : tokens.findIndex((token, at) => at > paramsEnd && token.value === "{");
      const bodyEnd = bodyStart < 0 ? -1 : matching(tokens, bodyStart, "{", "}");
      if (bodyStart >= 0 && bodyEnd > bodyStart) return { body: tokens.slice(bodyStart + 1, bodyEnd), callable: true };
      return { body: [], callable: false };
    }
    if (["const", "let", "var"].includes(tokens[cursor]?.value ?? "") && tokens[cursor + 1]?.value === name && tokens[cursor + 2]?.value === "=") {
      const end = tokens.findIndex((token, at) => at > cursor + 2 && token.value === ";");
      const rhsEnd = end < 0 ? tokens.length : end;
      const arrow = callableArrowStart(tokens, cursor + 3, rhsEnd);
      if (arrow >= 0) {
        const bodyStart = tokens[arrow + 1]?.value === "{" ? arrow + 1
          : tokens[arrow + 1]?.value === "(" && tokens[arrow + 2]?.value === "{" ? arrow + 2 : -1;
        const bodyEnd = bodyStart < 0 ? -1 : matching(tokens, bodyStart, "{", "}");
        const expressionObject = tokens[arrow + 1]?.value === "(" && tokens[arrow + 2]?.value === "{";
        return {
          body: bodyStart >= 0 && bodyEnd > bodyStart
            ? expressionObject ? tokens.slice(bodyStart, bodyEnd + 1) : tokens.slice(bodyStart + 1, bodyEnd)
            : [],
          callable: true,
        };
      }
      const functionIndex = tokens.findIndex((token, at) => at >= cursor + 3 && at < rhsEnd && token.value === "function");
      if (functionIndex >= 0) {
        const params = tokens.findIndex((token, at) => at > functionIndex && token.value === "(");
        const paramsEnd = params < 0 ? -1 : matching(tokens, params, "(", ")");
        const bodyStart = paramsEnd < 0 ? -1 : tokens.findIndex((token, at) => at > paramsEnd && at < rhsEnd && token.value === "{");
        const bodyEnd = bodyStart < 0 ? -1 : matching(tokens, bodyStart, "{", "}");
        return { body: bodyStart >= 0 && bodyEnd > bodyStart ? tokens.slice(bodyStart + 1, bodyEnd) : [], callable: bodyStart >= 0 };
      }
      return { body: [], callable: false };
    }
  }
  return null;
}

/** Where a top-level `const <name> = { … }` (exported or not) opens its object, or -1. */
function constObjectStart(tokens: Token[], name: string): number {
  for (const index of topLevelIndices(tokens)) {
    const cursor = tokens[index]?.value === "export" ? index + 1 : index;
    if (["const", "let", "var"].includes(tokens[cursor]?.value ?? "") && tokens[cursor + 1]?.value === name
      && tokens[cursor + 2]?.value === "=" && tokens[cursor + 3]?.value === "{") return cursor + 3;
  }
  return -1;
}

/** An object literal's keys and the first token of each value; `...Name` of a top-level const object adds its keys. */
function definitionKeys(tokens: Token[], objectStart: number, depth = 0): Map<string, Token | undefined> {
  const keys = new Map<string, Token | undefined>();
  const objectEnd = matching(tokens, objectStart, "{", "}");
  if (objectEnd < 0 || depth > 3) return keys;
  let cursor = objectStart + 1;
  while (cursor < objectEnd) {
    let nested = 0;
    let end = cursor;
    for (; end < objectEnd; end += 1) {
      const value = tokens[end]!.value;
      if (nested === 0 && value === ",") break;
      if (["{", "(", "["].includes(value)) nested += 1;
      else if (["}", ")", "]"].includes(value)) nested -= 1;
    }
    const first = tokens[cursor];
    if (first?.value === "..." && tokens[cursor + 1]?.kind === "id") {
      const spread = constObjectStart(tokens, tokens[cursor + 1]!.value);
      if (spread >= 0) for (const [key, value] of definitionKeys(tokens, spread, depth + 1)) keys.set(key, value);
    } else if (first && (first.kind === "id" || first.kind === "string")) {
      keys.set(first.value, tokens[cursor + 1]?.value === ":" ? tokens[cursor + 2] : first);
    }
    cursor = end + 1;
  }
  return keys;
}

/**
 * The name of the setup function an OpenCode v2 plugin module's default export names: `export default { id, setup, … }`
 * (or a const object of that shape, or one spread into it), null when the default is not such a definition.
 */
function defaultDefinitionSetup(tokens: Token[]): string | null {
  for (const index of topLevelIndices(tokens)) {
    if (tokens[index]?.value !== "export" || tokens[index + 1]?.value !== "default") continue;
    const value = tokens[index + 2];
    const start = value?.value === "{" ? index + 2 : value?.kind === "id" ? constObjectStart(tokens, value.value) : -1;
    if (start < 0) return null;
    const keys = definitionKeys(tokens, start);
    const setup = keys.get("setup");
    return keys.has("id") && setup?.kind === "id" ? setup.value : null;
  }
  return null;
}

/** Whether the module imports `name` from `from` at top level (`import { …, name, … } from "from"`). */
function importsFrom(tokens: Token[], name: string, from: string): boolean {
  return topLevelIndices(tokens).some((index) => {
    if (tokens[index]?.value !== "import" || tokens[index + 1]?.value !== "{") return false;
    const close = matching(tokens, index + 1, "{", "}");
    return close > 0 && tokens[close + 1]?.value === "from" && tokens[close + 2]?.value === from
      && tokens.slice(index + 2, close).some((token) => token.value === name);
  });
}

const hasSequence = (tokens: readonly Token[], values: readonly string[]): boolean =>
  tokens.some((_, index) => values.every((value, offset) => tokens[index + offset]?.value === value));

function callableValue(tokens: Token[], start: number, end: number): boolean {
  let cursor = start;
  if (tokens[cursor]?.value === "async") cursor += 1;
  if (tokens[cursor]?.value === "function") return tokens.slice(cursor + 1, end).some((token) => token.value === "{");
  if (tokens[cursor]?.value === "(") {
    const close = matching(tokens, cursor, "(", ")");
    if (close >= 0 && tokens[close + 1]?.value === "=>") return true;
    if (close >= 0 && tokens[close + 1]?.value === "{") return true;
  }
  if (tokens[cursor]?.kind === "id" && (tokens[cursor + 1]?.value === "=>" || tokens[cursor + 1]?.value === "(")) {
    if (tokens[cursor + 1]?.value === "=>") return true;
    const close = matching(tokens, cursor + 1, "(", ")");
    if (close >= 0 && tokens[close + 1]?.value === "{") return true;
  }
  return false;
}

function objectProperties(tokens: Token[], objectStart: number): Array<{ key: string; start: number; end: number }> {
  const objectEnd = matching(tokens, objectStart, "{", "}");
  if (objectEnd < 0) return [];
  const props: Array<{ key: string; start: number; end: number }> = [];
  let cursor = objectStart + 1;
  while (cursor < objectEnd) {
    let depth = 0;
    let end = cursor;
    for (; end < objectEnd; end += 1) {
      const value = tokens[end]!.value;
      if (depth === 0 && value === ",") break;
      if (["{", "(", "["].includes(value)) depth += 1;
      else if (["}", ")", "]"].includes(value)) depth -= 1;
    }
    if (end <= cursor) { cursor = end + 1; continue; }
    const keyToken = tokens[cursor]!;
    const key = keyToken.kind === "string" || keyToken.kind === "id" ? keyToken.value : "";
    let valueStart = -1;
    if (tokens[cursor + 1]?.value === ":") valueStart = cursor + 2;
    else if (tokens[cursor + 1]?.value === "(") valueStart = cursor + 1;
    props.push({ key, start: valueStart, end });
    cursor = end + 1;
  }
  return props;
}

function returnedObject(tokens: Token[]): { tokens: Token[]; start: number } | null {
  if (tokens[0]?.value === "{") return { tokens, start: 0 };
  if (tokens[0]?.value === "(" && tokens[1]?.value === "{") return { tokens, start: 1 };
  let braces = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i]?.value === "return" && braces === 0 && tokens[i + 1]?.value === "{") return { tokens, start: i + 1 };
    if (tokens[i]?.value === "{" ) braces += 1;
    else if (tokens[i]?.value === "}") braces -= 1;
  }
  return null;
}

function telemetryEventIsCallable(tokens: Token[], telemetryFunction: { body: Token[] }): boolean {
  const object = returnedObject(telemetryFunction.body);
  if (!object) return false;
  const event = objectProperties(object.tokens, object.start).find((property) => property.key === "event");
  if (!event) return false;
  if (event.start >= 0 && callableValue(object.tokens, event.start, event.end)) return true;
  const hasShorthand = event.start < 0 && object.tokens[event.end - 1]?.value === "event";
  if (!hasShorthand) return false;
  let braces = 0;
  for (let i = 0; i < telemetryFunction.body.length; i += 1) {
    if (telemetryFunction.body[i]?.value === "async" && telemetryFunction.body[i + 1]?.value === "function" && telemetryFunction.body[i + 2]?.value === "event"
      || telemetryFunction.body[i]?.value === "function" && telemetryFunction.body[i + 1]?.value === "event") {
      const params = telemetryFunction.body.findIndex((token, at) => at > i + 1 && token.value === "(");
      const paramsEnd = params < 0 ? -1 : matching(telemetryFunction.body, params, "(", ")");
      const bodyStart = paramsEnd < 0 ? -1 : telemetryFunction.body.findIndex((token, at) => at > paramsEnd && token.value === "{");
      const bodyEnd = bodyStart < 0 ? -1 : matching(telemetryFunction.body, bodyStart, "{", "}");
      if (bodyEnd > bodyStart) {
        const body = telemetryFunction.body.slice(bodyStart + 1, bodyEnd);
        return body.some((token) => token.kind === "string" && token.value === "session.compacted")
          && body.some((token) => token.value === "emit");
      }
    }
    if (telemetryFunction.body[i]?.value === "{") braces += 1;
    else if (telemetryFunction.body[i]?.value === "}") braces -= 1;
  }
  return false;
}

function directExportedCallable(tokens: Token[], name: string): boolean {
  return exportedFunction(tokens, name)?.callable === true;
}

function diagnostic(capability: RequiredCapability, path: string, detail: string): ContractDiagnostic {
  return { capability, path, detail: `Required executable interface ${capability} was not verified in ${path}; impacted function: ${IMPACTED_FUNCTIONS[capability]}. ${detail}` };
}

export type DetailedCapabilityInspection = { capabilities: string[]; diagnostics: ContractDiagnostic[] };

export async function inspectEngineCapabilitiesDetailed(root: string): Promise<DetailedCapabilityInspection> {
  const found: string[] = [];
  const diagnostics: ContractDiagnostic[] = [];
  const entry = await readBoundedSource(root, OPEN_CODE_ENTRY);
  const index = await readBoundedSource(root, OPEN_CODE_INDEX);
  let entryTokens: Token[] | null = null;
  let indexTokens: Token[] | null = null;
  const parseSource = (source: SourceRead, relative: string, capabilities: RequiredCapability[]): Token[] | null => {
    if (!source.text) {
      for (const capability of capabilities) diagnostics.push(diagnostic(capability, relative, source.error ?? "source file is unavailable"));
      return null;
    }
    try { return parseTypeScript(source.text); }
    catch (error) {
      const reason = error instanceof Error ? error.message : "unknown parser error";
      for (const capability of capabilities) diagnostics.push(diagnostic(capability, relative, reason));
      return null;
    }
  };
  entryTokens = parseSource(entry, OPEN_CODE_ENTRY, ["opencode.plugin.default_export"]);
  indexTokens = parseSource(index, OPEN_CODE_INDEX, ["opencode.plugin.default_export", ...HOOK_CAPABILITIES.map(([capability]) => capability)]);
  const setupName = indexTokens ? defaultDefinitionSetup(indexTokens) : null;
  // The setup lives in v2.ts (Lane Stack 1.66): a local function of index.ts is accepted too.
  const setupFromV2 = Boolean(setupName && indexTokens && importsFrom(indexTokens, setupName, "./v2.ts"));
  if (entryTokens && defaultReexportsExpectedModule(entryTokens) && setupName) found.push("opencode.plugin.default_export");
  else if (entryTokens && indexTokens) diagnostics.push(diagnostic("opencode.plugin.default_export", OPEN_CODE_ENTRY, "Expected a default re-export of ./opencode-lane/index.ts whose default export is an OpenCode v2 definition { id, setup }."));

  const hookPath = setupFromV2 ? OPEN_CODE_V2 : OPEN_CODE_INDEX;
  const hookTokens = setupFromV2
    ? parseSource(await readBoundedSource(root, OPEN_CODE_V2), OPEN_CODE_V2, HOOK_CAPABILITIES.map(([capability]) => capability))
    : indexTokens;
  const setup = hookTokens && setupName ? exportedFunction(hookTokens, setupName) : null;
  if (hookTokens) {
    for (const [capability, sequence] of HOOK_CAPABILITIES) {
      if (setup?.callable && hasSequence(setup.body, sequence)) found.push(capability);
      else diagnostics.push(diagnostic(capability, hookPath, `The v2 setup ${setupName ?? "(none)"} does not register ${sequence.filter((part) => ![".", "("].includes(part)).join(" ")}.`));
    }
  }

  const telemetrySource = await readBoundedSource(root, TELEMETRY_SOURCE);
  let telemetryTokens: Token[] | null = null;
  try {
    if (!telemetrySource.text) throw new Error(telemetrySource.error ?? "source file is unavailable");
    telemetryTokens = parseTypeScript(telemetrySource.text);
  } catch (error) {
    diagnostics.push(diagnostic("opencode.telemetry.session_compacted", TELEMETRY_SOURCE, error instanceof Error ? error.message : "TypeScript parse failed"));
  }
  const telemetry = telemetryTokens ? exportedFunction(telemetryTokens, "createTelemetry") : null;
  if (telemetry?.callable && telemetryEventIsCallable(telemetryTokens!, telemetry)) found.push("opencode.telemetry.session_compacted");
  else if (telemetryTokens) diagnostics.push(diagnostic("opencode.telemetry.session_compacted", TELEMETRY_SOURCE, "Expected exported createTelemetry() to return a callable event handler that processes session.compacted and emits telemetry."));

  const stickySource = await readBoundedSource(root, STICKY_SOURCE);
  let stickyTokens: Token[] | null = null;
  try {
    if (!stickySource.text) throw new Error(stickySource.error ?? "source file is unavailable");
    stickyTokens = parseTypeScript(stickySource.text);
  } catch (error) {
    for (const capability of ["opencode.sticky.contract_recovery", "opencode.sticky.dumped_tool_recovery"] as const) {
      diagnostics.push(diagnostic(capability, STICKY_SOURCE, error instanceof Error ? error.message : "TypeScript parse failed"));
    }
  }
  if (stickyTokens) {
    for (const [capability, name] of [["opencode.sticky.contract_recovery", "ensureStickyMessages"], ["opencode.sticky.dumped_tool_recovery", "dumpedToolNote"]] as const) {
      if (directExportedCallable(stickyTokens, name)) found.push(capability);
      else diagnostics.push(diagnostic(capability, STICKY_SOURCE, `Expected exported callable ${name}(...).`));
    }
  }

  for (const { capability, file, pattern } of [
    { capability: "execution_packet.line_windows" as const, file: "bin/execution_packet.py", pattern: /^\s*_WINDOW_RE\s*=|^\s*def\s+.*line_window/m },
  ]) {
    const source = await readBoundedSource(root, file);
    if (source.text && pattern.test(source.text)) found.push(capability);
    else diagnostics.push(diagnostic(capability, file, source.error ?? "Required executable route declaration was not found."));
  }

  return { capabilities: [...new Set(found)].sort(), diagnostics };
}

export async function inspectEngineCapabilities(root: string): Promise<string[]> {
  return (await inspectEngineCapabilitiesDetailed(root)).capabilities;
}
