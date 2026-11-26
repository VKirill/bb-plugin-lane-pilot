import type { Room } from "../../contracts";
import type { WorkflowEngineApi } from "../../platform/server";
import { leadMigrations } from "../migrations";
import { leadSettings } from "../settings";
import { registerLeadTickActions } from "./handlers/tick-actions";

export const room: Room<{ workflowEngine: WorkflowEngineApi["workflowEngine"]; workflowCatalog?: WorkflowEngineApi["workflowCatalog"] }> = {
  name: "lead",
  migrations: leadMigrations,
  settings: leadSettings,
  startup: (ctx, services) => { registerLeadTickActions(services.workflowEngine, ctx, services); },
};
