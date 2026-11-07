import { PAIR_ROLE_SPECS } from "@lane-pilot/models";

/** Roles whose provider, model, reasoning effort and service tier are chosen in the «Roles and models» table. */
const ROLE_PREFIXES = PAIR_ROLE_SPECS.map((spec) => spec.prefix);

const MODEL_KEY = new RegExp(`^(?:(?:${ROLE_PREFIXES.join("|")})\\.(?:provider|model|reasoning_effort|service_tier)|writer\\.fallback[1-3]\\.(?:provider|model|reasoning_effort)|council\\.[a-z]+\\.(?:provider|model|reasoning_effort)|browser_qa\\.(?:provider|model|reasoning_effort)|role_model\\.[a-z-]+)$`);

/** A setting that names who works a role: its provider, model, effort or tier, and the writer's fallback chain. Nothing else (no switches, folders, agents). */
export const isModelSettingKey = (key: string): boolean => MODEL_KEY.test(key);

/** Who a role's chat runs as: `main.agent`, `docs.agent` and the other `<role>.agent` rows. */
export const isAgentSettingKey = (key: string): boolean => /^[a-z_]+\.agent$/.test(key);

/** What «give every project the global models» takes back: a role's model rows and its agent. */
export const isRoleOverrideKey = (key: string): boolean => isModelSettingKey(key) || isAgentSettingKey(key);
