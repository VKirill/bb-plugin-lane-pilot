import type { PluginCliContext, PluginCliResult } from "@get-bb/plugin-sdk";
import { CARD_KINDS, type CardKind } from "@lane-pilot/contracts";
import { isNotFound, orMiss } from "@lane-pilot/kit";
import type { ServerCore } from "../../../contracts/server";
import { getCard, listCards, setCard, verifyCard } from "../services/cards";

export const CARD_USAGE = [
  "bb lane-pilot card set <kind> <key> --text \"<...>\" [--ref <path>] [--project <id>|--global] [--ttl-days N]",
  "bb lane-pilot card get (<id> | <kind> <key>) [--project <id>|--global]",
  "bb lane-pilot card list [--project <id>|--global] [--kind <kind>] [--include-global]",
  "bb lane-pilot card verify <id> [--by <who>] [--ttl-days N]",
].join("\n");

function parseArgs(argv: readonly string[]): {
  positional: string[];
  values: Map<string, string>;
  booleans: Set<string>;
} {
  const positional: string[] = [];
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  const VALUE_FLAGS = new Set(["--file", "--text", "--project", "--ttl-days", "--kind", "--by", "--ref"]);
  const BOOL_FLAGS = new Set(["--global", "--include-global", "--json"]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (BOOL_FLAGS.has(arg)) {
      booleans.add(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (arg.startsWith("--") && eq > 2) {
      const name = arg.slice(0, eq);
      if (!VALUE_FLAGS.has(name)) throw new Error(`unknown flag ${name}\n${CARD_USAGE}`);
      values.set(name, arg.slice(eq + 1));
      continue;
    }
    if (VALUE_FLAGS.has(arg)) {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} requires a value\n${CARD_USAGE}`);
      values.set(arg, next);
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`unknown flag ${arg}\n${CARD_USAGE}`);
    positional.push(arg);
  }
  return { positional, values, booleans };
}

async function resolveProjectScope(
  ctx: ServerCore,
  invocation: PluginCliContext | undefined,
  explicitProject: string | undefined,
  isGlobal: boolean,
): Promise<{ projectId: string | null } | { error: string }> {
  if (isGlobal) return { projectId: null };
  if (invocation?.threadId) {
    const caller = (await orMiss(
      ctx.bb.sdk.threads.get({ threadId: invocation.threadId }),
      null,
      isNotFound,
    )) as { projectId?: unknown } | null;
    const own = typeof caller?.projectId === "string" ? caller.projectId : null;
    if (!own) return { error: "no project: pass --project <id> or --global" };
    if (explicitProject && explicitProject !== own) {
      return { error: `refused: card from a thread reaches only that thread's own project (${own}), not ${explicitProject}` };
    }
    return { projectId: own };
  }
  if (!explicitProject) return { error: "no project: pass --project <id> or --global outside a BB thread" };
  return { projectId: explicitProject };
}

function parseTtlDays(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error("--ttl-days must be a positive number");
  return n;
}

export async function runCardsCli(
  ctx: ServerCore,
  args: readonly string[],
  invocation?: PluginCliContext,
): Promise<PluginCliResult> {
  try {
    const [sub, ...rest] = args;
    if (!sub) return { exitCode: 1, stderr: CARD_USAGE };
    const parsed = parseArgs(rest);
    const isGlobal = parsed.booleans.has("--global");
    const explicitProject = parsed.values.get("--project");

    if (sub === "set") {
      const [kind, key] = parsed.positional;
      if (!kind || !key || parsed.positional.length !== 2) {
        return { exitCode: 1, stderr: `usage: ${CARD_USAGE.split("\n")[0]}` };
      }
      // The hub server never reads a project path (remote-git-detect.test.ts); the caller's shell reads the file.
      if (parsed.values.has("--file")) {
        return { exitCode: 1, stderr: "--file is not supported: pass the text inline, e.g. --text \"$(cat <path>)\" --ref <path>" };
      }
      const text = parsed.values.get("--text");
      if (text === undefined) return { exitCode: 1, stderr: "pass --text \"<...>\"" };
      const filePath = parsed.values.get("--ref");
      const scope = await resolveProjectScope(ctx, invocation, explicitProject, isGlobal);
      if ("error" in scope) return { exitCode: 1, stderr: scope.error };
      const content = text;
      const ttlDays = parseTtlDays(parsed.values.get("--ttl-days"));
      const card = setCard(ctx, {
        projectId: scope.projectId,
        kind: kind as CardKind,
        key,
        content,
        source: filePath !== undefined
          ? { kind: "file", ref: filePath }
          : { kind: "owner", ref: invocation?.threadId ? `thread:${invocation.threadId}` : "cli" },
        ttlDays,
      });
      return { exitCode: 0, stdout: `${JSON.stringify(card, null, 2)}\n` };
    }

    if (sub === "get") {
      if (parsed.positional.length === 1) {
        const card = getCard(ctx, { cardId: parsed.positional[0]! });
        if (!card) return { exitCode: 1, stderr: `card not found: ${parsed.positional[0]}` };
        return { exitCode: 0, stdout: `${JSON.stringify(card, null, 2)}\n` };
      }
      if (parsed.positional.length === 2) {
        const [kind, key] = parsed.positional;
        const scope = await resolveProjectScope(ctx, invocation, explicitProject, isGlobal);
        if ("error" in scope) return { exitCode: 1, stderr: scope.error };
        const card = getCard(ctx, { projectId: scope.projectId, kind: kind as CardKind, key: key! });
        if (!card) return { exitCode: 1, stderr: `card not found: ${kind}:${key}` };
        return { exitCode: 0, stdout: `${JSON.stringify(card, null, 2)}\n` };
      }
      return { exitCode: 1, stderr: `usage: ${CARD_USAGE.split("\n")[1]}` };
    }

    if (sub === "list") {
      const scope = await resolveProjectScope(ctx, invocation, explicitProject, isGlobal);
      if ("error" in scope) return { exitCode: 1, stderr: scope.error };
      const kind = parsed.values.get("--kind");
      if (kind && !(CARD_KINDS as readonly string[]).includes(kind)) {
        return { exitCode: 1, stderr: `card refused: unknown kind ${kind}` };
      }
      const cards = listCards(ctx, {
        projectId: scope.projectId,
        kind: kind as CardKind | undefined,
        includeGlobal: parsed.booleans.has("--include-global"),
      });
      return { exitCode: 0, stdout: `${JSON.stringify({ cards }, null, 2)}\n` };
    }

    if (sub === "verify") {
      const [cardId] = parsed.positional;
      if (!cardId || parsed.positional.length !== 1) {
        return { exitCode: 1, stderr: `usage: ${CARD_USAGE.split("\n")[3]}` };
      }
      if (invocation?.threadId && parsed.values.get("--by") === "owner") {
        return { exitCode: 1, stderr: "refused: --by owner from a thread is not allowed; run from a terminal" };
      }
      const by = parsed.values.get("--by") ?? (invocation?.threadId ? `thread:${invocation.threadId}` : "owner");
      const ttlDays = parseTtlDays(parsed.values.get("--ttl-days"));
      const card = verifyCard(ctx, {
        cardId,
        by,
        ref: parsed.values.get("--ref"),
        ttlDays,
      });
      return { exitCode: 0, stdout: `${JSON.stringify(card, null, 2)}\n` };
    }

    return { exitCode: 1, stderr: CARD_USAGE };
  } catch (cause) {
    return { exitCode: 1, stderr: cause instanceof Error ? cause.message : String(cause) };
  }
}
