import { lstat, readFile, realpath } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { isAbsolute, resolve, sep } from "node:path";

export const REQUIRED_CAPABILITIES = [
  "opencode.plugin.default_export",
  "opencode.hook.event",
  "opencode.hook.chat_message",
  "opencode.hook.chat_params",
  "opencode.hook.tool_execute_after",
  "opencode.hook.messages_transform",
  "opencode.telemetry.session_compacted",
  "opencode.sticky.contract_recovery",
  "opencode.sticky.dumped_tool_recovery",
  "opencode.native_tool_route",
  "execution_packet.line_windows",
] as const;

export type RequiredCapability = (typeof REQUIRED_CAPABILITIES)[number];
export type EngineCapability = RequiredCapability | (string & {});

export const ADAPTER_CAPABILITIES = [
  "opencode.sticky.dumped_tool_recovery",
  "opencode.native_tool_route",
  "execution_packet.line_windows",
] as const satisfies readonly RequiredCapability[];

const ADAPTABLE = new Set<string>(ADAPTER_CAPABILITIES);

export const IMPACTED_FUNCTIONS: Record<RequiredCapability, string> = {
  "opencode.plugin.default_export": "OpenCode plugin module loading",
  "opencode.hook.event": "OpenCode session lifecycle and compaction event handling",
  "opencode.hook.chat_message": "OpenCode prompt routing and sticky task context",
  "opencode.hook.chat_params": "OpenCode model/parameter routing",
  "opencode.hook.tool_execute_after": "OpenCode tool evidence, budget, and winnow result handling",
  "opencode.hook.messages_transform": "OpenCode sticky task/evidence message recovery",
  "opencode.telemetry.session_compacted": "OpenCode compacted-session telemetry and recovery",
  "opencode.sticky.contract_recovery": "OpenCode lane contract recovery after compaction",
  "opencode.sticky.dumped_tool_recovery": "OpenCode correction when a provider prints tool JSON instead of calling tools",
  "opencode.native_tool_route": "OpenCode native read/edit/write/bash tool routing",
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
  WINDOW_RE.lastIndex = 0;
  const first = WINDOW_RE.exec(text);
  const path = first ? text.slice(0, first.index).trim() : text;
  const tail = text.slice(first?.index ?? text.length);
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

export function opencodeNativeToolEnvironment(): Record<string, string> {
  return {
    CURSOR_ACP_FORWARD_TOOL_CALLS: "false",
    CURSOR_ACP_TOOL_LOOP_MODE: "opencode",
    CURSOR_ACP_MCP_BRIDGE: "false",
  };
}

const DUMPED_TOOL_NAME = /"name"\s*:\s*"(?:bash|shell|read|edit|write|grep|glob|str_replace|Shell|Read|Write|Grep|Glob)"/i;
const DEAD_CURSOR_ROUTE = /Cursor tools.{0,40}unavail|MCP-сервер(?:ы)? не подключен/i;

export function dumpedOpenCodeToolRecovery(text: string): string {
  if (!text || (!DUMPED_TOOL_NAME.test(text) && !DEAD_CURSOR_ROUTE.test(text))) return "";
  return "[opencode-lane tools] JSON-in-chat is ignored. Call OpenCode read/edit/write/bash/grep. Cursor/MCP ACP tools do not exist here. If done or blocked, emit LANE_REPORT now.";
}

export function adaptOpenCodePluginHooks(plugin: unknown, adapters: readonly string[]): unknown {
  if (!plugin || typeof plugin !== "object") return plugin;
  const hooks = { ...(plugin as Record<string, unknown>) };
  if (!adapters.includes("opencode.sticky.dumped_tool_recovery")) return hooks;
  const key = "experimental.chat.messages.transform";
  const original = hooks[key];
  if (typeof original !== "function") return hooks;
  hooks[key] = async function (this: unknown, ...args: unknown[]): Promise<unknown> {
    const result = await original.apply(this, args);
    const output = args[1] && typeof args[1] === "object" ? args[1] as { messages?: unknown[] } : null;
    const messages = output?.messages;
    if (!messages) return result;
    const texts: string[] = [];
    for (const message of messages) {
      if (!message || typeof message !== "object") continue;
      const item = message as { info?: { role?: string }; parts?: Array<{ type?: string; text?: string }> };
      if (item.info?.role !== "assistant") continue;
      for (const part of item.parts ?? []) if (part.type === "text" && typeof part.text === "string") texts.push(part.text);
    }
    const body = texts.join("\n");
    const hasToolJson = /"name"\s*:\s*"(?:bash|shell|read|edit|write|grep|glob|str_replace|Shell|Read|Write|Grep|Glob)"/i.test(body)
      || /Cursor tools.{0,40}unavail|MCP-сервер(?:ы)? не подключен/i.test(body);
    const notePrefix = "[opencode-lane tools]";
    for (const message of messages) {
      if (!message || typeof message !== "object") continue;
      const item = message as { parts?: Array<{ synthetic?: boolean; text?: string }> };
      item.parts = (item.parts ?? []).filter((part) => !(part.synthetic && part.text?.startsWith(notePrefix)));
    }
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index] as { parts?: unknown[] } | undefined;
      if (message && message.parts?.length === 0) messages.splice(index, 1);
    }
    if (hasToolJson) {
      messages.push({
        info: { role: "user" },
        parts: [{
          type: "text",
          text: `${notePrefix} JSON-in-chat is ignored. Call OpenCode read/edit/write/bash/grep. Cursor/MCP ACP tools do not exist here. If done or blocked, emit LANE_REPORT now.`,
          synthetic: true,
        }],
      });
    }
    return result;
  };
  return hooks;
}

const MAX_SOURCE_BYTES = 512 * 1024;
const OPEN_CODE_ENTRY = "profiles/opencode/opencode-lane.ts";
const OPEN_CODE_INDEX = "profiles/opencode/opencode-lane/index.ts";
const TELEMETRY_SOURCE = "profiles/opencode/opencode-lane/telemetry.ts";
const STICKY_SOURCE = "profiles/opencode/opencode-lane/sticky.ts";
const HOOK_CAPABILITIES = [
  ["opencode.hook.event", "event"],
  ["opencode.hook.chat_message", "chat.message"],
  ["opencode.hook.chat_params", "chat.params"],
  ["opencode.hook.tool_execute_after", "tool.execute.after"],
  ["opencode.hook.messages_transform", "experimental.chat.messages.transform"],
] as const satisfies ReadonlyArray<readonly [RequiredCapability, string]>;

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

function defaultExportIsCallable(tokens: Token[]): boolean {
  for (const index of topLevelIndices(tokens)) {
    if (tokens[index]?.value !== "export" || tokens[index + 1]?.value !== "default") continue;
    let cursor = index + 2;
    if (tokens[cursor]?.value === "async") cursor += 1;
    if (tokens[cursor]?.value === "function") {
      const params = tokens.findIndex((token, at) => at > cursor && token.value === "(");
      const paramsEnd = params < 0 ? -1 : matching(tokens, params, "(", ")");
      const bodyStart = paramsEnd < 0 ? -1 : tokens.findIndex((token, at) => at > paramsEnd && token.value === "{");
      return bodyStart >= 0 && matching(tokens, bodyStart, "{", "}") > bodyStart;
    }
    if (tokens[cursor]?.kind === "id") {
      const declaration = exportedFunction(tokens, tokens[cursor]!.value);
      return declaration?.callable === true;
    }
    if (tokens[cursor]?.value === "(") return tokens.slice(cursor).some((token) => token.value === "=>");
  }
  return false;
}

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
  const defaultContract = Boolean(entryTokens && indexTokens && defaultReexportsExpectedModule(entryTokens) && defaultExportIsCallable(indexTokens));
  if (defaultContract) found.push("opencode.plugin.default_export");
  else if (entryTokens && indexTokens) diagnostics.push(diagnostic("opencode.plugin.default_export", OPEN_CODE_ENTRY, "Expected a default re-export of ./opencode-lane/index.ts whose module has a callable default export."));

  if (indexTokens) {
    const callablePlugin = defaultExportIsCallable(indexTokens);
    let properties: Array<{ key: string; start: number; end: number }> = [];
    let propertiesTokens = indexTokens;
    if (callablePlugin) {
      const exported = exportedFunction(indexTokens, "OpenCodeLanePlugin");
      const body = exported?.body ?? [];
      const object = returnedObject(body);
      if (object) {
        properties = objectProperties(object.tokens, object.start);
        propertiesTokens = object.tokens;
      }
      else {
        const defaultIndex = topLevelIndices(indexTokens).find((at) => indexTokens[at]?.value === "export" && indexTokens[at + 1]?.value === "default");
        if (defaultIndex !== undefined && indexTokens[defaultIndex + 2]?.value === "function") {
          const bodyStart = indexTokens.findIndex((token, at) => at > defaultIndex + 2 && token.value === "{");
          const bodyEnd = bodyStart < 0 ? -1 : matching(indexTokens, bodyStart, "{", "}");
          const objectFromFunction = bodyEnd > bodyStart ? returnedObject(indexTokens.slice(bodyStart + 1, bodyEnd)) : null;
          if (objectFromFunction) {
            properties = objectProperties(objectFromFunction.tokens, objectFromFunction.start);
            propertiesTokens = objectFromFunction.tokens;
          }
        }
      }
    }
    for (const [capability, hook] of HOOK_CAPABILITIES) {
      const property = properties.find((item) => item.key === hook);
      const method = property && property.start < 0 && property.end > 0
        && (propertiesTokens[property.end - 1]?.value === "}" || propertiesTokens[property.end - 1]?.value === ")");
      const callable = Boolean(property && (property.start >= 0
        ? callableValue(propertiesTokens, property.start, property.end)
        : method));
      if (callable) found.push(capability);
      else if (index.text) diagnostics.push(diagnostic(capability, OPEN_CODE_INDEX, `Hook ${hook} is absent, indirect, or not a direct callable function value.`));
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
    { capability: "opencode.native_tool_route" as const, file: "bin/lane-session", pattern: /^export\s+CURSOR_ACP_FORWARD_TOOL_CALLS=(?:"false"|'false'|false)\s*$/m },
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
