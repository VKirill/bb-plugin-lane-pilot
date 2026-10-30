// Slim OpenCode v2 plugin for sessions Lane Pilot starts (agent id `lane-*`).
// The shared service's env is not the thread's, so hooks never read LANE_TASK_FILE, LANE_PROMPT_FILE or LANE_STACK_ROOT.
// A plain OpenCode session (any other agent) is left alone.
import { recordTool, repeatHint } from "./budget.ts"
import { guardTool, projectHasSkill } from "./guard.ts"
import { agentDenies, hubShellDenial, isLaneAgent, type PermissionRule } from "./hub-guard.ts"

const RULES_TTL_MS = 30_000

type Ctx = any
type ResultContent = string | { type?: string; text?: string }[] | undefined
type ToolResult = { content?: ResultContent; metadata?: Record<string, unknown> }

function resultText(content: ResultContent): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.map((part) => (part?.type === "text" && typeof part.text === "string" ? part.text : "")).join("")
}

function appendResultNote(result: ToolResult, note: string): void {
  if (Array.isArray(result.content)) result.content = [...result.content, { type: "text", text: `\n${note}` }]
  else result.content = `${resultText(result.content)}\n${note}`
}

export async function laneSetup(ctx: Ctx): Promise<() => void> {
  const sessions = new Map<string, { directory: string }>()
  const rules = new Map<string, { at: number; list: PermissionRule[] }>()

  const refreshSession = async (sessionID: string): Promise<{ directory: string }> => {
    const raw = await ctx.session.get({ sessionID })
    const info = raw?.data ?? raw
    const known = { directory: String(info?.location?.directory || process.cwd()) }
    sessions.set(sessionID, known)
    return known
  }

  const agentRules = async (agentID: string): Promise<PermissionRule[]> => {
    const hit = rules.get(agentID)
    if (hit && Date.now() - hit.at < RULES_TTL_MS) return hit.list
    const raw = await ctx.agent.get({ agentID })
    const agent = raw?.data ?? raw
    const list = Array.isArray(agent?.permissions) ? (agent.permissions as PermissionRule[]) : []
    rules.set(agentID, { at: Date.now(), list })
    return list
  }

  await ctx.tool.hook("execute.before", async (e: { tool: string; sessionID: string; agent: string; input: unknown }) => {
    if (!isLaneAgent(e.agent)) return
    const session = sessions.get(e.sessionID) ?? (await refreshSession(e.sessionID))
    const msg = guardTool(e.tool, e.input, session.directory)
    if (msg) throw new Error(msg)
  })

  await ctx.tool.hook(
    "execute.after",
    async (e: { tool: string; sessionID: string; agent: string; input: unknown; status: string; result?: ToolResult; error?: { message?: string } }) => {
      if (!isLaneAgent(e.agent)) return
      const failed = e.status === "error"
      const result: ToolResult = failed ? {} : (e.result as ToolResult)
      const output = failed ? String(e.error?.message ?? "") : resultText(result?.content)
      const { n } = recordTool(e.sessionID, e.tool, e.input, output)
      const hint = repeatHint(e.tool, n, failed)
      if (hint && !failed) appendResultNote(result, hint)
    },
  )

  await ctx.permission.hook(
    "evaluate",
    async (e: { sessionID: string; agent?: string; action: string; resources: string[]; effect: string; message?: string }) => {
      if (!e.agent || !isLaneAgent(e.agent) || e.effect === "deny") return
      const deny = (message: string): void => {
        e.effect = "deny"
        e.message = message
      }
      if (e.action === "skill") {
        const session = sessions.get(e.sessionID) ?? (await refreshSession(e.sessionID))
        if (e.resources.every((skill) => projectHasSkill(session.directory, skill.toLowerCase()))) return
      }
      if (agentDenies(await agentRules(e.agent), e.action, e.resources)) {
        return deny(`[opencode-lane guard] ${e.action} is denied for ${e.agent} by its agent file.`)
      }
      if (e.action !== "shell") return
      for (const command of e.resources) {
        const message = hubShellDenial(command)
        if (message) return deny(message)
      }
    },
  )

  return () => {}
}
