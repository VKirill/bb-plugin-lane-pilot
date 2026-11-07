export type GateWhen = "queue_drained" | "every_n";

export type IntegrationGateSettings = {
  /** The explicit command; null when empty (the gate is then detected) or `off`. */
  gateCommand: string | null;
  /** `integration.gate_command` is `off`: no gate for the project, detected or not. */
  gateOff: boolean;
  gateWhen: GateWhen;
  gateEvery: number;
};

export function parseIntegrationGateSettings(settings: Record<string, unknown>): IntegrationGateSettings {
  const rawCommand = typeof settings["integration.gate_command"] === "string" ? (settings["integration.gate_command"] as string).trim() : "";
  const gateOff = rawCommand.toLowerCase() === "off";
  const gateCommand = rawCommand && !gateOff ? rawCommand : null;
  const gateWhenRaw = settings["integration.gate_when"];
  const gateWhen: GateWhen = gateWhenRaw === "every_n" ? "every_n" : "queue_drained";
  const gateEveryRaw = Number(settings["integration.gate_every"]);
  const gateEvery = Number.isFinite(gateEveryRaw) && gateEveryRaw > 0 ? Math.floor(gateEveryRaw) : 5;
  return { gateCommand, gateOff, gateWhen, gateEvery };
}

export type ResolvedGate = { command:string; source:"setting" | "detected"; detail:string };

/** The integration-gate resolver, implemented by src/rooms/verification (createGateResolver) and handed through the services bag. */
export type VerificationGatePort = (input:{ runId:string; hostId:string; basePath?:string | null; gate:IntegrationGateSettings }) => Promise<ResolvedGate | null>;
