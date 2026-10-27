/** Roles whose provider, model, reasoning effort and service tier are chosen in the «Roles and models» table. */
const ROLE_PREFIXES = ["writer", "memory", "night_review", "docs", "project_life", "onboarding", "pm_read", "plan_critique", "code_critique", "specialist"];

const MODEL_KEY = new RegExp(`^(?:(?:${ROLE_PREFIXES.join("|")})\\.(?:provider|model|reasoning_effort|service_tier)|writer\\.fallback[1-3]\\.(?:provider|model|reasoning_effort)|council\\.[a-z]+\\.(?:provider|model|reasoning_effort)|browser_qa\\.(?:provider|model|reasoning_effort)|role_model\\.[a-z-]+)$`);

/** A setting that names who works a role: its provider, model, effort or tier, and the writer's fallback chain. Nothing else (no switches, folders, agents). */
export const isModelSettingKey = (key: string): boolean => MODEL_KEY.test(key);
