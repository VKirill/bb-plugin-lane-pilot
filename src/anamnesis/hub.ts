import { z } from "zod";
import { responseSchemas, type AnamnesisRequest, type OpName, type ResponseOf } from "./ops";
import type { AnamnesisRpcRequest } from "./contract";

/**
 * The hub side of anamnesis: finds the owner's machine and talks to the store there. It keeps no records. Everything it needs from
 * the plugin is passed in (`HubDeps`), so the wiring in `server.ts` is small and the rest can be tested with plain fakes.
 */
export type HostInfo = { id: string; name: string; connected: boolean };

export type HubDeps = {
  /** One request to the host method `anamnesis` on that machine; returns the host's `response`. */
  hostCall(hostId: string, request: AnamnesisRequest, timeoutMs: number): Promise<unknown>;
  listHosts(): Promise<HostInfo[]>;
  kv: { get<T>(key: string): Promise<T | null | undefined>; set(key: string, value: never): Promise<unknown> };
};

export const CONFIG_KEY = "anamnesis:config";
export const configSchema = z.object({
  /** The machine that holds the store: the owner's Mac mini. */
  hostId: z.string().min(1).optional(),
  /** Git author emails or names that are the owner's own commits (A3). */
  authors: z.array(z.string().min(1).max(200)).max(20).optional(),
  /** Folders searched for the owner's repositories and project journals (A3). */
  roots: z.array(z.string().startsWith("/")).max(20).optional(),
  /** The most message fragments one Jev pass may send (a ceiling on cost, F-5); the pass default is `DEFAULT_MAX_CLASSIFY` in load.ts. */
  maxClassify: z.number().int().min(1).max(2000).optional(),
}).strict();
export type AnamnesisConfig = z.infer<typeof configSchema>;

const CALL_TIMEOUT_MS = 60_000;

export function createHub(deps: HubDeps) {
  async function config(): Promise<AnamnesisConfig> {
    const stored = configSchema.safeParse(await deps.kv.get(CONFIG_KEY));
    return stored.success ? stored.data : {};
  }

  async function setConfig(patch: Partial<AnamnesisConfig>): Promise<AnamnesisConfig> {
    const next = configSchema.parse({ ...(await config()), ...patch });
    await deps.kv.set(CONFIG_KEY, next as never);
    return next;
  }

  /** The configured machine, else the one connected machine called «mini». Never a guess among several. */
  async function resolveHost(): Promise<string> {
    const configured = (await config()).hostId;
    if (configured) return configured;
    const minis = (await deps.listHosts()).filter((host) => host.connected && /\bmini\b/i.test(host.name));
    if (minis.length === 1) return minis[0]!.id;
    throw new Error(minis.length ? "More than one connected machine looks like the Mac mini; set one with: bb lane-pilot anamnesis host <host-id>"
      : "No connected Mac mini found; set the machine with: bb lane-pilot anamnesis host <host-id>");
  }

  async function ask<O extends OpName>(request: Extract<AnamnesisRequest, { op: O }>, timeoutMs = CALL_TIMEOUT_MS): Promise<ResponseOf<O>> {
    const hostId = await resolveHost();
    const raw = await deps.hostCall(hostId, request, timeoutMs);
    return responseSchemas[request.op as OpName].parse(raw) as ResponseOf<O>;
  }

  /** The RPC: a store request goes to the host, `host` reads or sets the configured machine. */
  async function dispatch(request: AnamnesisRpcRequest): Promise<unknown> {
    if (request.op === "host") {
      if (request.hostId) await setConfig({ hostId: request.hostId });
      return { hostId: await resolveHost(), config: await config() };
    }
    return await ask(request as Extract<AnamnesisRequest, { op: OpName }>);
  }

  return { config, setConfig, resolveHost, ask, dispatch };
}
export type Hub = ReturnType<typeof createHub>;
