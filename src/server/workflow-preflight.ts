import { checkRequires, effectiveRequires } from "../workflow/preflight";
import type { PreflightResult, RequirePorts } from "../workflow/preflight";
import type { Workflow } from "../workflow/schema";
import type { ArchitectDeps } from "./workflow-architect";
import type { ServerCore } from "./core";
import { runOnHost } from "@lane-pilot/host-calls";

type Place = { hostId: string; path: string };
const quote = (text: string) => `'${text.replace(/'/g, "'\\''")}'`;

/**
 * The shell that answers, for each group of commands, whether any of them exists: a name is looked up on the PATH, a path (`/…`,
 * `~/…`) is tested for the execute bit. One line `index:yes|no` per group.
 */
export function commandsScript(groups: string[][]): string {
  const lines = groups.map((group, index) => `has ${group.map(quote).join(" ")} && echo ${index}:yes || echo ${index}:no`);
  return ["has() { for c in \"$@\"; do case \"$c\" in \"~/\"*) c=\"$HOME/${c#\\~/}\";; esac; case \"$c\" in /*) [ -x \"$c\" ] && return 0;; *) command -v \"$c\" >/dev/null 2>&1 && return 0;; esac; done; return 1; }", ...lines].join("\n");
}

export function parseCommandAnswers(stdout: string, count: number): boolean[] {
  const answers = new Map<number, boolean>();
  for (const line of stdout.split("\n")) { const found = line.trim().match(/^(\d+):(yes|no)$/); if (found) answers.set(Number(found[1]), found[2] === "yes"); }
  return Array.from({ length: count }, (_unused, index) => answers.get(index) ?? false);
}

/**
 * The check before a live run, wired to this plugin's world: the skills, plugins, MCP servers and Env Catalog names the architect
 * already lists, and commands and social logins asked on the machine the run works on (the PM chat's checkout, or the project's
 * own folder when no chat starts the run) through the host's `runCommand`.
 */
export function createWorkflowPreflight(ctx: ServerCore, deps: Pick<ArchitectDeps, "capabilityPorts" | "projectPlace" | "projectPlaceOf">) {
  const { host } = ctx;

  async function placeFor(input: { projectId: string; threadId?: string | null | undefined }): Promise<Place | null> {
    if (input.threadId) { const place = await deps.projectPlace(input.threadId).catch(() => null); if (place) return place; }
    return (await deps.projectPlaceOf?.(input.projectId).catch(() => null)) ?? null;
  }

  async function ask(place: Place, command: string): Promise<string | null> {
    try {
      const ran = await runOnHost(host, { hostId: place.hostId, cwd: place.path, command, timeoutSec: 30, timeoutMs: 45_000 });
      return ran.stdout;
    } catch { return null; }
  }

  return {
    async check(workflow: Workflow, input: { projectId: string; threadId?: string | null | undefined }): Promise<PreflightResult> {
      const capabilities = deps.capabilityPorts({ projectId: input.projectId, threadId: input.threadId ?? "" });
      const place = await placeFor(input);
      const ports: RequirePorts = {
        ...(capabilities.skills ? { skills: async () => (await capabilities.skills!()).map((row) => row.name) } : {}),
        ...(capabilities.plugins ? { plugins: async () => (await capabilities.plugins!()).map((row) => row.id) } : {}),
        ...(capabilities.mcpServers ? { mcpServers: async () => (await capabilities.mcpServers!()).map((row) => row.name) } : {}),
        ...(capabilities.secrets ? { secrets: () => capabilities.secrets!() } : {}),
        ...(place ? {
          commands: async (groups) => {
            const out = await ask(place, commandsScript(groups));
            return out === null ? null : parseCommandAnswers(out, groups.length);
          },
          socialStatus: async () => {
            const out = await ask(place, "command -v social-cookies >/dev/null 2>&1 && social-cookies status 2>&1 || echo __no_social_cookies__");
            return out === null || out.includes("__no_social_cookies__") ? null : out;
          },
        } : {}),
      };
      return await checkRequires(effectiveRequires(workflow), ports);
    },
  };
}
export type WorkflowPreflight = ReturnType<typeof createWorkflowPreflight>;
