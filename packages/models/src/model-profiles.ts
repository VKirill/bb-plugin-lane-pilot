/**
 * The writers the plugin knows by name: the key a `writer.models_off` entry may use, the provider and model, the label and the cost tier.
 * A model outside the list works too (it is matched by `provider/model` or by the bare model id).
 */
import type { ModelTier } from "./model-tiers";

export type WriterProfile = {
  /** The key a `writer.models_off` entry may name. */
  key: string;
  providerId: string;
  model: string;
  label: string;
  tier: ModelTier;
};

export const WRITER_PROFILES: readonly WriterProfile[] = [
  { key: "composer", providerId: "acp-cursor", model: "composer-2.5", label: "Composer 2.5 (Cursor)", tier: "standard" },
  { key: "grok", providerId: "acp-cursor", model: "grok-4.6", label: "Grok 4.6 (Cursor)", tier: "standard" },
  { key: "gemini-flash", providerId: "opencode2", model: "router9/ag/gemini-3.8-flash-high", label: "Gemini 3.8 Flash high (9router)", tier: "standard" },
  { key: "gpt-astra", providerId: "codex", model: "gpt-6-astra", label: "GPT-6 Astra (Codex)", tier: "strong" },
  { key: "gpt-sol", providerId: "codex", model: "gpt-6.1-sol", label: "GPT-6.1 Sol (Codex)", tier: "strong" },
  { key: "gpt-terra", providerId: "codex", model: "gpt-6.1-terra", label: "GPT-6.1 Terra (Codex)", tier: "standard" },
  { key: "gpt-luna", providerId: "codex", model: "gpt-6-luna", label: "GPT-6 Luna (Codex)", tier: "light" },
  { key: "sonnet", providerId: "claude-code", model: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", tier: "standard" },
  { key: "fable", providerId: "claude-code", model: "claude-fable-5-1", label: "Claude Fable 5.1", tier: "strong" },
  { key: "opus", providerId: "claude-code", model: "claude-opus-5-5", label: "Claude Opus 5.5", tier: "strong" },
  { key: "swe2", providerId: "devin", model: "swe-2-high", label: "SWE-2 (Devin)", tier: "strong" },
  { key: "glm-flash", providerId: "opencode2", model: "zai-coding-plan/glm-5.3-flash", label: "GLM-5.3 Flash (Z.AI)", tier: "light" },
  { key: "zcode-flash", providerId: "zcode", model: "glm-5.3-flash-free", label: "ZCode · GLM-5.3-Flash · Free", tier: "standard" },
  { key: "haiku", providerId: "claude-code", model: "claude-haiku-5-5", label: "Claude Haiku 5.5", tier: "light" },
  { key: "minimax-flash", providerId: "opencode2", model: "openlux/MiniMax-M3.1-Flash", label: "MiniMax M3.1 Flash", tier: "light" },
  { key: "gemini-pro", providerId: "opencode2", model: "openrouter/~google/gemini-pro-latest", label: "Gemini Pro", tier: "strong" },
  { key: "gemini-argon", providerId: "acp-antigravity", model: "gemini-4-argon", label: "Gemini 4 Argon", tier: "strong" },
];

/**
 * The entry of `writer.models_off` that switches this provider/model off, or null: an entry is a profile key, `provider/model`, or
 * the bare model id, so the toggle works for a model that has no profile too. It is read at launch (SMA «Worker toggle»): the writer
 * chain skips a switched-off member while it stays configured.
 */
export function writerSwitchedOff(settings: Record<string, unknown>, providerId: string, model: string): string | null {
  const off = Array.isArray(settings["writer.models_off"]) ? (settings["writer.models_off"] as unknown[]).map(String) : [];
  if (!off.length) return null;
  const key = WRITER_PROFILES.find((row) => row.providerId === providerId && row.model === model)?.key;
  return off.find((entry) => entry === key || entry === `${providerId}/${model}` || entry === model) ?? null;
}
