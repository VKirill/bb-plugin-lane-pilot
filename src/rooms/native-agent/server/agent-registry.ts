import {
  createAgentInputSchema,
  isCustomAgentId,
  isReservedAgentId,
  newCustomAgentRow,
  updatedCustomAgentRow,
  updateAgentInputSchema,
  type AgentFailure,
} from "../custom-agent";
import { clearSettingValue } from "../../storage";
import { createScheduleStore, taskOf } from "../../schedule";
import type { ServerCore } from "../../core/server";

type Registry = Pick<ServerCore, "db" | "ownedAgents" | "saveOwnedAgents" | "serializedKv">;
export type RegistryResult = { ok: true; id: string } | { ok: false; id: string; error: AgentFailure; detail?: string };

/**
 * Create, change and delete the owner's agents (`bb lane-pilot agents …`, the settings screen). Bundled agents are edited with
 * `save_agent_profile` and cannot be deleted; an owner's agent never takes a bundled id.
 */
export function agentRegistry(ctx: Registry) {
  const { db, ownedAgents, saveOwnedAgents, serializedKv } = ctx;
  const idOf = (input: unknown) => (input && typeof input === "object" && typeof (input as { id?: unknown }).id === "string" ? (input as { id: string }).id : "");

  async function create(input: unknown): Promise<RegistryResult> {
    const parsed = createAgentInputSchema.safeParse(input);
    if (!parsed.success) return { ok: false, id: idOf(input), error: "invalid_agent", detail: parsed.error.issues.map((issue) => `${issue.path.join(".") || "agent"}: ${issue.message}`).join("; ") };
    const agent = parsed.data;
    if (isReservedAgentId(agent.id)) return { ok: false, id: agent.id, error: "agent_id_reserved" };
    return serializedKv(async () => {
      const owned = await ownedAgents();
      if (owned[agent.id]) return { ok: false as const, id: agent.id, error: "agent_exists" as const };
      try {
        owned[agent.id] = newCustomAgentRow(agent, Date.now());
      } catch (cause) {
        return { ok: false as const, id: agent.id, error: "invalid_agent" as const, detail: cause instanceof Error ? cause.message : String(cause) };
      }
      await saveOwnedAgents(owned);
      return { ok: true as const, id: agent.id };
    });
  }

  async function update(input: unknown): Promise<RegistryResult> {
    const parsed = updateAgentInputSchema.safeParse(input);
    if (!parsed.success) return { ok: false, id: idOf(input), error: "invalid_agent", detail: parsed.error.issues.map((issue) => `${issue.path.join(".") || "agent"}: ${issue.message}`).join("; ") };
    const patch = parsed.data;
    if (!isCustomAgentId(patch.id)) return { ok: false, id: patch.id, error: "agent_not_custom" };
    return serializedKv(async () => {
      const owned = await ownedAgents();
      const row = owned[patch.id];
      if (!row) return { ok: false as const, id: patch.id, error: "agent_not_found" as const };
      try {
        owned[patch.id] = updatedCustomAgentRow(patch.id, row, patch, Date.now());
      } catch (cause) {
        return { ok: false as const, id: patch.id, error: "invalid_agent" as const, detail: cause instanceof Error ? cause.message : String(cause) };
      }
      await saveOwnedAgents(owned);
      return { ok: true as const, id: patch.id };
    });
  }

  async function remove(id: string): Promise<RegistryResult> {
    if (!isCustomAgentId(id)) return { ok: false, id, error: "agent_not_custom" };
    return serializedKv(async () => {
      const owned = await ownedAgents();
      if (!owned[id]) return { ok: false as const, id, error: "agent_not_found" as const };
      // A schedule that runs this agent would fail at its next run; the owner changes or removes it first.
      const schedules = createScheduleStore(db).list({ states: ["active"] }).filter((row) => row.kind === "agent" && (taskOf(row) as { agentId?: string }).agentId === id);
      if (schedules.length) return { ok: false as const, id, error: "agent_in_use" as const, detail: `active schedules run this agent: ${schedules.map((row) => `«${row.name}» (${row.id})`).join(", ")}; pause or delete them, or give them another agent, then delete it` };
      delete owned[id];
      await saveOwnedAgents(owned);
      // A project that had it as its main agent would fail to start a chat (incomplete_main_agent_profile): it goes back to the default agent.
      clearSettingValue(db, "main.agent", id);
      return { ok: true as const, id };
    });
  }

  return { create, update, remove };
}
export type AgentRegistry = ReturnType<typeof agentRegistry>;
