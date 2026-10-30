import { existsSync, statSync } from "node:fs"
import { join, resolve } from "node:path"

const GIT_RESTORE = new Set(["checkout", "restore", "reset", "switch"])
// The lane controller commits and merges; no lane agent does (the lane-writer agent file denies the same commands).
const GIT_SHIP = new Set(["commit", "push", "merge"])
const SHELL_WRAPPERS = new Set(["sudo", "command", "time", "nohup", "nice", "env"])
const SHELLS = new Set(["sh", "bash", "dash", "zsh", "ksh"])
const GIT_FLAG_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"])
// Skills and MCP servers are open to every Lane Pilot thread (owner, 2026-10-30): the guard keeps writers from git mistakes,
// it does not decide which tools a task may use (a browser task was refused browser-automation).

function toolPath(args: unknown): string {
  if (!args || typeof args !== "object" || Array.isArray(args)) return ""
  const a = args as Record<string, unknown>
  const path = [a.path, a.filePath, a.file].find((v) => typeof v === "string") as string | undefined
  return (path ?? "").trim()
}

function commandSegments(command: string): string[] {
  const parts: string[] = []
  let current = ""
  let quote: "'" | '"' | null = null
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    if (quote) {
      current += ch
      if (ch === quote && command[i - 1] !== "\\") quote = null
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      current += ch
      continue
    }
    const next = command[i + 1]
    if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
      parts.push(current)
      current = ""
      i++
      continue
    }
    if (ch === "|" || ch === ";" || ch === "\n") {
      parts.push(current)
      current = ""
      continue
    }
    current += ch
  }
  parts.push(current)
  return parts
}

function commandWords(segment: string): string[] {
  const words: string[] = []
  let current = ""
  let quote: "'" | '"' | null = null
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      if (current) words.push(current)
      current = ""
      continue
    }
    current += ch
  }
  if (current) words.push(current)
  return words
}

function basename(word: string): string {
  const slash = Math.max(word.lastIndexOf("/"), word.lastIndexOf("\\"))
  return slash >= 0 ? word.slice(slash + 1) : word
}

function skipWrappers(words: string[]): number {
  let i = 0
  while (i < words.length) {
    const word = words[i]!
    if (word === "env") {
      i++
      while (i < words.length && words[i]!.includes("=") && !words[i]!.startsWith("-")) i++
      continue
    }
    if (word.includes("=") && !word.startsWith("-") && !word.startsWith("/")) {
      i++
      continue
    }
    if (SHELL_WRAPPERS.has(word)) {
      i++
      while (i < words.length && words[i]!.startsWith("-")) i++
      continue
    }
    break
  }
  return i
}

function gitSubcommand(words: string[], index: number): string {
  while (index < words.length) {
    const word = words[index]!
    if (!word.startsWith("-")) return word
    index += GIT_FLAG_WITH_VALUE.has(word) ? 2 : 1
  }
  return ""
}

function shellScript(words: string[], index: number): string | null {
  while (index < words.length) {
    const word = words[index]!
    if (word === "-c" || /^-[a-zA-Z]*c[a-zA-Z]*$/.test(word)) return words[index + 1] ?? null
    if (!word.startsWith("-")) return null
    index++
  }
  return null
}

// Quoted text is data. `git commit` is blocked only when git is the program being run.
// (2026-10-29 audit A-033) every `&&` `;` `||` `|` segment is checked, and a `sh`/`bash -c` script is split the same way.
// The first verb used to win, so `git status && git push` looked like `status`.
function gitVerbs(command: string): string[] {
  const verbs: string[] = []
  for (const segment of commandSegments(command)) verbs.push(...gitVerbsInWords(commandWords(segment)))
  return verbs
}

function gitVerbsInWords(words: string[]): string[] {
  const index = skipWrappers(words)
  const program = basename(words[index] ?? "")
  if (program === "git") {
    const verb = gitSubcommand(words, index + 1)
    return verb ? [verb] : []
  }
  if (SHELLS.has(program)) {
    const script = shellScript(words, index + 1)
    if (script) return gitVerbs(script)
  }
  return []
}

function toolCommand(args: unknown): string {
  if (typeof args === "string") return args
  if (!args || typeof args !== "object" || Array.isArray(args)) return ""
  const a = args as Record<string, unknown>
  const cmd = [a.command, a.cmd].find((v) => typeof v === "string") as string | undefined
  return cmd ?? ""
}

export function projectHasSkill(cwd: string, name: string): boolean {
  let cur = cwd
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(cur, ".opencode", "skills", name, "SKILL.md"))) return true
    if (existsSync(join(cur, ".git"))) break
    const parent = resolve(cur, "..")
    if (parent === cur) break
    cur = parent
  }
  return false
}

export function guardTool(tool: string, args: unknown, cwd = process.cwd()): string {
  const name = tool.toLowerCase()
  if (name === "write" || name === "write_file" || name === "oc_write") {
    const path = toolPath(args)
    if (!path) return ""
    const abs = resolve(cwd, path)
    try {
      if (existsSync(abs) && statSync(abs).isFile()) {
        return (
          "[opencode-lane guard] write blocked: file exists. Use edit " +
          "(old_string/new_string). If the file shrank, emit LANE_REPORT " +
          "STATUS: partial — do not git checkout."
        )
      }
    } catch {
      return ""
    }
  }
  if (name === "bash" || name === "shell") {
    const verbs = gitVerbs(toolCommand(args))
    if (verbs.some((verb) => GIT_RESTORE.has(verb))) {
      return (
        "[opencode-lane guard] git checkout/restore/reset/switch blocked. " +
        "Emit LANE_REPORT STATUS: partial instead of restoring a truncated write."
      )
    }
    if (verbs.some((verb) => GIT_SHIP.has(verb))) {
      return "[opencode-lane guard] git commit/push/merge blocked: the controller commits and merges. Emit LANE_REPORT instead."
    }
  }
  return ""
}
