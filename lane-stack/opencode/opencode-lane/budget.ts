import { createHash } from "node:crypto"

export type ToolAttempt = {
  tool: string
  cmd: string
  fp: string
  n: number
  chars: number
  tail: string
}

// (2026-10-29 audit A-015) window sent onward. Full tool output stays out.
export const RECENT_MAX_ENTRIES = 24
export const RECENT_MAX_BYTES = 12_000
const TAIL_CHARS = 480

const seen = new Map<string, Map<string, number>>()
const recent = new Map<string, ToolAttempt[]>()
const pathRepeats = new Map<string, Map<string, number>>()

function stable(value: unknown): string {
  if (value === undefined) return "undefined"
  if (typeof value === "string") return JSON.stringify(value)
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`)
    .join(",")}}`
}

function valueLength(value: unknown): number {
  return typeof value === "string" ? value.length : value == null ? 0 : stable(value).length
}

function fingerprintArgs(tool: string, args: unknown): unknown {
  const name = tool.toLowerCase()
  if (name !== "bash" && name !== "shell") return args
  if (!args || typeof args !== "object" || Array.isArray(args)) return args
  const transport = new Set(["toolCallId", "requestId", "conversationId"])
  return Object.fromEntries(Object.entries(args as Record<string, unknown>).filter(([key]) => !transport.has(key)))
}

export function argKey(tool: string, args: unknown): string {
  const normalized = fingerprintArgs(tool, args)
  const a = normalized && typeof normalized === "object" ? normalized as Record<string, unknown> : {}
  const path = [a.path, a.filePath, a.file].find((v) => typeof v === "string") as string | undefined
  const cmd = [a.command, a.cmd].find((v) => typeof v === "string") as string | undefined
  const pattern = [a.pattern, a.query].find((v) => typeof v === "string") as string | undefined
  return `${stable(normalized)}|${[tool.toLowerCase(), path ?? "", cmd ?? "", pattern ?? ""].join("|")}`
}

export function toolFingerprint(tool: string, args: unknown, output: unknown): string {
  return createHash("sha256")
    .update(argKey(tool, args))
    .update("\0")
    .update(String(valueLength(output)))
    .update("\0")
    .update(stable(output))
    .digest("hex")
    .slice(0, 16)
}

export function recentAttempts(sessionID: string): ToolAttempt[] {
  return recent.get(sessionID) || []
}

function boundedTail(text: string, fp: string): string {
  if (text.length <= TAIL_CHARS) return text
  const mark = ` […${text.length} fp ${fp}…] `
  const room = TAIL_CHARS - mark.length
  if (room < 40) return `${text.slice(0, TAIL_CHARS - fp.length - 1)} ${fp}`
  const head = Math.floor(room * 0.55)
  const end = room - head
  return text.slice(0, head) + mark + text.slice(text.length - end)
}

function trimRecent(list: ToolAttempt[]): ToolAttempt[] {
  let kept = list.slice(-RECENT_MAX_ENTRIES)
  let bytes = kept.reduce((sum, row) => sum + row.tail.length, 0)
  while (kept.length > 1 && bytes > RECENT_MAX_BYTES) {
    bytes -= kept[0]!.tail.length
    kept = kept.slice(1)
  }
  if (kept.length === 1 && kept[0]!.tail.length > RECENT_MAX_BYTES) {
    kept = [{ ...kept[0]!, tail: kept[0]!.tail.slice(0, RECENT_MAX_BYTES) }]
  }
  return kept
}

function toolPath(args: unknown): string {
  if (!args || typeof args !== "object" || Array.isArray(args)) return ""
  const a = args as Record<string, unknown>
  const path = [a.path, a.filePath, a.file].find((v) => typeof v === "string") as string | undefined
  return path ?? ""
}

function isEditTool(tool: string): boolean {
  return /(?:^|[_:.\/-])(write|edit|patch|apply_patch)(?:$|[_:.\/-])/.test(tool.toLowerCase())
}

export function recordTool(
  sessionID: string,
  tool: string,
  args: unknown,
  output: unknown,
): { n: number; chars: number; fp: string } {
  const fp = toolFingerprint(tool, args, output)
  const bag = seen.get(sessionID) || new Map<string, number>()
  seen.set(sessionID, bag)
  let n = (bag.get(fp) || 0) + 1
  bag.set(fp, n)
  const name = tool.toLowerCase()
  if (isEditTool(name)) {
    const key = `${name}|${toolPath(args)}`
    const paths = pathRepeats.get(sessionID) || new Map<string, number>()
    pathRepeats.set(sessionID, paths)
    n = (paths.get(key) || 0) + 1
    paths.set(key, n)
  }
  const list = recent.get(sessionID) || []
  const full = typeof output === "string" ? output : stable(output)
  list.push({ tool: name, cmd: argKey(tool, args), fp, n, chars: valueLength(output), tail: boundedTail(full, fp) })
  recent.set(sessionID, trimRecent(list))
  return { n, chars: valueLength(output), fp }
}

const CLASS_SWEEP = "Name the class of this failure, then sweep every similar place offline in one pass (read/grep, no reruns), fix the whole class, and run once to confirm."

export function repeatHint(tool: string, n: number, failed = false): string {
  const name = tool.toLowerCase()
  if (failed && n === 2 && !isEditTool(name)) {
    return `[opencode-lane class] The same ${name} call failed the same way twice. Do not run it a third time: change the angle. ${CLASS_SWEEP}`
  }
  if (n < 3) return ""
  if (name === "read" || name === "grep") {
    return `[opencode-lane budget] Identical ${name} content has already been returned ${n} times. Reuse the earlier result and take the next task step. If you cannot proceed, report the concrete blocker instead of rereading it.`
  }
  if (name === "write" || name === "edit") {
    return `[opencode-lane budget] ${name} on the same path ${n} times. Existing files need edit (old_string/new_string), never whole-file write. If the file shrank, emit LANE_REPORT STATUS: partial — do not git checkout and rewrite.`
  }
  return `[opencode-lane budget] same ${name} result ${n} times. Change the hypothesis before retrying. ${CLASS_SWEEP}`
}
