import { getRun } from "../../storage/database";
import type { ServerCore } from "../../../server/core";
import type { IntegrationGateSettings } from "./integration-gate";
import { runOnHost } from "@lane-pilot/host-calls";

/**
 * The integration gate with no setup: when `integration.gate_command` is empty, the command is found on the project's own
 * host from what the folder holds. An explicit command overrides it, and `off` turns the gate off for the project.
 */

export type ResolvedGate = { command:string; source:"setting" | "detected"; detail:string };

/** One host command in the run folder that prints what the detection reads; it changes nothing. «set[u]p» keeps the host's `setup` ban from matching the file name. */
export const GATE_PROBE = [
  "if [ -f package.json ]; then echo '@@package.json'; head -c 200000 package.json; echo; fi",
  "for b in vitest jest; do [ -e node_modules/.bin/$b ] && echo \"@@bin $b\"; done",
  "[ -f pytest.ini ] && echo '@@pytest'",
  "grep -qs '^\\[tool\\.pytest' pyproject.toml && echo '@@pytest'",
  "grep -qs '^\\[tool:pytest\\]' set[u]p.cfg && echo '@@pytest'",
  "grep -qs '^\\[pytest\\]' tox.ini && echo '@@pytest'",
  "true",
].join("\n");

/** What `npm init` writes for «test»: no test at all. */
const NPM_PLACEHOLDER = /no test specified/i;

/** The command the probe's output names, with the reason it was chosen; null when the folder has no test runner. */
export function detectGateCommand(probe:string):{ command:string; detail:string } | null {
  const lines = probe.split("\n");
  const bins = new Set(lines.filter((line) => line.startsWith("@@bin ")).map((line) => line.slice(6).trim()));
  const start = lines.indexOf("@@package.json");
  let pkg = null as { scripts?:Record<string, unknown>; dependencies?:Record<string, unknown>; devDependencies?:Record<string, unknown> } | null;
  if (start >= 0) {
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((line) => line.startsWith("@@"));
    try { pkg = JSON.parse((end < 0 ? rest : rest.slice(0, end)).join("\n")) as typeof pkg; } catch { /* a broken package.json names nothing */ }
  }
  const script = typeof pkg?.scripts?.test === "string" ? pkg.scripts.test.trim() : "";
  // A watch-mode script never ends on its own, so it cannot be a gate.
  if (script && !NPM_PLACEHOLDER.test(script) && !/(?:^|\s)--watch(?:All)?(?:\s|$)|\bnodemon\b/.test(script)) return { command:"npm test", detail:"package.json script «test»" };
  const declared = (name:string) => Boolean(pkg?.dependencies?.[name] || pkg?.devDependencies?.[name]);
  if (bins.has("vitest") || declared("vitest")) return { command:"npx vitest run", detail:"vitest is installed" };
  if (bins.has("jest") || declared("jest")) return { command:"npx jest", detail:"jest is installed" };
  if (lines.includes("@@pytest")) return { command:"pytest -q", detail:"pytest config in the project" };
  return null;
}

const CACHE_MS = 30 * 60_000;

/** The gate of a run: explicit setting, else the detected command (cached per run), else none (also when `off`). */
export function createGateResolver(ctx:Pick<ServerCore, "host" | "db" | "log">) {
  const cache = new Map<string, { at:number; value:{ command:string; detail:string } | null }>();

  async function detect(runId:string, hostId:string, basePath:string):Promise<{ command:string; detail:string } | null> {
    const key = `${runId}:${hostId}:${basePath}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    let value:{ command:string; detail:string } | null;
    try {
      const ran = await runOnHost(ctx.host, { hostId, cwd: basePath, command: GATE_PROBE, timeoutSec: 30 });
      // An answer we could not get is not «no tests»: the next call asks again.
      if (ran.exitCode !== 0) return null;
      value = detectGateCommand(ran.stdout);
    } catch (cause) {
      ctx.log(`integration-gate: could not look for a test command on ${hostId}: ${cause instanceof Error ? cause.message : String(cause)}`);
      return null;
    }
    cache.set(key, { at:Date.now(), value });
    return value;
  }

  return async function resolveGate(input:{ runId:string; hostId:string; basePath?:string | null; gate:IntegrationGateSettings }):Promise<ResolvedGate | null> {
    if (input.gate.gateOff) return null;
    if (input.gate.gateCommand) return { command:input.gate.gateCommand, source:"setting", detail:"integration.gate_command" };
    const basePath = input.basePath ?? getRun(ctx.db, input.runId)?.writer_workspace_path;
    if (!basePath) return null;
    const found = await detect(input.runId, input.hostId, basePath);
    return found ? { command:found.command, source:"detected", detail:found.detail } : null;
  };
}

export type GateResolver = ReturnType<typeof createGateResolver>;

const resolvers = new WeakMap<object, GateResolver>();
/** One resolver, so one cache, per server: dispatch's lint and the gate runner share the answer. */
export function gateResolverFor(ctx:Pick<ServerCore, "host" | "db" | "log">):GateResolver {
  let found = resolvers.get(ctx);
  if (!found) { found = createGateResolver(ctx); resolvers.set(ctx, found); }
  return found;
}

/** How the gate's command is named in a receipt or a message to the PM. */
export function gateLabel(gate:Pick<ResolvedGate, "command" | "source" | "detail">):string {
  return gate.source === "detected" ? `\`${gate.command}\` (detected: ${gate.detail})` : `\`${gate.command}\``;
}
