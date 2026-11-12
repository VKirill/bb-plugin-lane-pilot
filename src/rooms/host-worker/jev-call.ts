import { homedir } from "node:os";
import { join } from "node:path";
import { readTextOrNull } from "@lane-pilot/kit";
import { JEV_PROVIDERS, jevProviderOfHostCall, type JevProvider } from "@lane-pilot/jev/provider";

/** The key and endpoint of the two host calls that still ask System One (the plan effort and the council); the docs pipeline no longer does. */
export type JevCallAuth = { key: string; provider: JevProvider };
export type JevCallSource = { jevApiKey?: string; jevProvider?: string };

async function machineJevKey(): Promise<string> {
  const fromEnv = (process.env.TYPESAFE_API_KEY || process.env.JEV_API_KEY || "").trim();
  if (fromEnv) return fromEnv;
  const text = await readTextOrNull(join(homedir(), "secrets", "typesafe.env")) ?? "";
  for (const line of text.split("\n")) {
    const match = /^\s*(TYPESAFE_API_KEY|JEV_API_KEY)\s*=\s*(.+?)\s*$/.exec(line);
    if (match) return match[2]!.replace(/^['"]|['"]$/g, "");
  }
  return "";
}

/**
 * Key and endpoint for this call only. A catalog key on the input never leaves that call.
 * A call without one uses this machine's TypeSafe key, or no key. (2026-10-29 audit A-030)
 */
export async function jevCallFor(input?: JevCallSource): Promise<JevCallAuth | null> {
  const key = input?.jevApiKey?.trim();
  if (key) return { key, provider: jevProviderOfHostCall(input?.jevProvider) };
  const machine = await machineJevKey();
  return machine ? { key: machine, provider: JEV_PROVIDERS.typesafe } : null;
}

export async function jevApiKey(): Promise<string> {
  return (await jevCallFor())?.key ?? "";
}

