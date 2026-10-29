/**
 * The writers' anamnesis: what each coding model is good and bad at, from public benchmarks, reviews and developers' reports
 * (October 2026; the sources are listed per model). The writer pick (`writer.model`, a Jev judgment) reads `summary` and chooses the
 * model for each task; `available: false` keeps a model out of the pick with the reason in `note`. The owner's words of 2026-10-25:
 * pick the model for the task, not only the effort; Gemini Pro is weak, Argon and MiniMax are not in the subscriptions.
 */
import type { ModelTier } from "./model-tiers";

export type WriterProfile = {
  /** The key the pick answers with and the settings name. */
  key: string;
  providerId: string;
  model: string;
  reasoning: string;
  label: string;
  tier: ModelTier;
  available: boolean;
  /** For the pick: strengths, weaknesses and the tasks it fits, in a few sentences. */
  summary: string;
  note?: string;
  sources: string[];
};

export const WRITER_PROFILES: readonly WriterProfile[] = [
  {
    key: "composer", providerId: "acp-cursor", model: "composer-2.5", reasoning: "medium", label: "Composer 2.5 (Cursor)", tier: "standard", available: true,
    summary: "Cursor's own coding model (on Kimi K2.5): near the frontier on multi-language repository fixes (SWE-Bench Multilingual 79.8%, Terminal-Bench 2.0 69%) at about a tenth of Opus's cost per task, and fast. Fits everyday multi-file features, fixes and refactors in mainstream stacks (TypeScript, Vue/React, Node, Python). Behind the top models on the hardest design and architecture problems and on long autonomous terminal work; most of its strong numbers are Cursor's own.",
    sources: ["https://www.datacamp.com/blog/composer-2-5", "https://chatforest.com/reviews/cursor-composer-2-5-coding-model-review/", "https://www.techtimes.com/articles/316917/20260520/cursor-composer-25-matches-claude-opus-47-coding-benchmarks-one-tenth-cost.htm"],
  },
  {
    key: "grok", providerId: "acp-cursor", model: "grok-4.6", reasoning: "medium", label: "Grok 4.6 (Cursor)", tier: "standard", available: true,
    summary: "xAI's coding model through the Cursor subscription: on our hub it was accepted on 90% of its tasks (Composer 91%, GPT-6 Luna 63%, 2026-10-13..27), and practitioners use it to implement a written plan, noting it does not degrade on long tasks. Fits routine features and fixes that follow a clear plan, multi-file changes in mainstream stacks, and long well-specified implementation runs; it spends a provider other than Claude and Codex. Not for open-ended design, architecture or review; Grok 4.7 doubled the output tokens and tested worse, so the pick stays on 4.6.",
    sources: ["https://t.me/ai_chat_cutcode/26401", "https://t.me/ai_chat_cutcode/26985", "https://daily.dev/posts/grok-4-7-fully-tested-this-is-actually-sad-worst-than-glm-5-3-flash--zu0g0lmcu"],
  },
  {
    key: "gemini-flash", providerId: "opencode2", model: "router9/ag/gemini-3.8-flash-high", reasoning: "medium", label: "Gemini 3.8 Flash high (9router)", tier: "standard", available: true,
    summary: "Google's fast, cheap model: DeepSWE about 74% (level with Claude Opus 5), SWE-Bench Pro 61.6%; Gemini Flash models are close to Opus on Roblox Luau code generation (OpenGameEval) and are recommended there for fast prototyping. Fits quick, well-described tasks, Roblox Luau scripts, UI tweaks and prototypes where speed matters. Its quality depends strongly on the harness; weaker on the hardest long-horizon agent tasks and dense extraction.",
    sources: ["https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-3-8-flash", "https://www.mindstudio.ai/blog/gemini-3-8-flash-harness-demos", "https://bloxbot.ai/guide/best-ai-models-roblox-development"],
  },
  {
    key: "gpt-astra", providerId: "codex", model: "gpt-6-astra", reasoning: "high", label: "GPT-6 Astra (Codex)", tier: "strong", available: true,
    summary: "OpenAI's top model ($10/$50 per million): leads Terminal-Bench Science (68.1%), but GPT-6.1 Sol matches it on DeepSWE at a fifth of the cost and an independent test found a tie in accuracy with Sol faster (7 vs 10 minutes a run). Fits only the most demanding scientific or research-heavy coding where Sol already failed. Slow and heavy on the subscription's limits: not for ordinary features or fixes.",
    sources: ["https://thenewstack.io/gpt-6-1-sol-vs-gpt-6-astra/?p=22839578", "https://propakistani.pk/2026/09/30/gpt-6-1-sol-brings-astra-level-performance-at-5x-lower-cost/"],
  },
  {
    key: "gpt-sol", providerId: "codex", model: "gpt-6.1-sol", reasoning: "high", label: "GPT-6.1 Sol (Codex)", tier: "strong", available: true,
    summary: "OpenAI's strong coding model: DeepSWE 75.2% at high effort, near GPT-6 Astra at a fifth of the price; reviewers praise polished front ends and it leads terminal-heavy agent work. Fits hard bugs, algorithmic and backend logic, tricky integrations, terminal and build work, and polished UI. Verbose (writes much more code than needed); costs more per task than Luna or Composer.",
    sources: ["https://www.vellum.ai/blog/gpt-6-1-sol-benchmarks-explained", "https://www.sonarsource.com/blog/openai-gpt-6-1-sol-evaluation/", "https://www.layer3labs.io/guides/gpt-6-1-sol-for-coding"],
  },
  {
    key: "gpt-terra", providerId: "codex", model: "gpt-6.1-terra", reasoning: "medium", label: "GPT-6.1 Terra (Codex)", tier: "standard", available: true,
    summary: "OpenAI's mid model (released 2026-10-26), $1/$5 per million: Artificial Analysis Coding Agent Index 48 (Sol 54, Luna 31), Terminal-Bench 4.0 50.3% at max effort (vendor figure), about three times faster than Sol per OpenAI; low and medium effort are its cost-efficient settings, guesses on 38% of unknown facts (AA-Omniscience). Fits well-specified features and fixes of moderate size, terminal and build work, UI changes it can check on screen, data analysis and high-volume agent steps where Sol is too dear and Luna too weak. Not for the hardest debugging, architecture or deep research: OpenAI itself points those to Sol or Astra.",
    sources: ["https://artificialanalysis.ai/articles/gpt-6-1-terra-pushes-the-cost-efficiency-frontier", "https://siliconangle.com/2026/10/26/openai-launches-gpt-6-1-terra-for-faster-better-performing-ai-agents-at-half-the-price/", "https://plotly.com/blog/gpt-6-1-terra-plotly-data-analytics-bench/", "https://decrypt.co/381883/openai-launches-gpt-6-1-terra-half-good-half-price"],
  },
  {
    key: "gpt-luna", providerId: "codex", model: "gpt-6-luna", reasoning: "high", label: "GPT-6 Luna (Codex)", tier: "light", available: true,
    summary: "OpenAI's cheap model: DeepSWE 66.6% at max effort for about $0.22 a task (Sol 68.8% at $2.74), but well behind Sol on broad agent work (Artificial Analysis coding index 41 vs 57). Fits only small, mechanical tasks with clear checks: a config value, a test, a one-file fix, a script, documentation. On our hub it was accepted on 63% of 43 tasks (Composer 91%, Grok 90%, 2026-10-13..27), so anything with judgment goes to Terra or Sonnet. Not for features, UI, refactors or architecture.",
    sources: ["https://www.vellum.ai/blog/gpt-6-sol-and-luna-benchmarks-explained", "https://benchlm.ai/compare/gpt-6-luna-vs-gpt-6-sol"],
  },
  {
    key: "sonnet", providerId: "claude-code", model: "claude-sonnet-5-5", reasoning: "medium", label: "Claude Sonnet 5.5", tier: "standard", available: true,
    summary: "Anthropic's everyday coder: Terminal-Bench 4.0 70.6% (ahead of Opus 5.5), CursorBench within two points of Opus at half the price. Fits daily features, bug fixes, refactors and code that must follow the project's conventions closely; writes clear Russian and English text, so good for docs and UI copy changes too. Opus is clearly stronger on long, ambiguous work.",
    sources: ["https://www.anthropic.com/claude-sonnet-5-5", "https://www.developersdigest.tech/blog/claude-opus-5-5-vs-sonnet-5-5-vs-haiku-5-5", "https://www.coderabbit.ai/blog/sonnet-5-5-model-review"],
  },
  {
    key: "fable", providerId: "claude-code", model: "claude-fable-5-1", reasoning: "high", label: "Claude Fable 5.1", tier: "strong", available: true,
    summary: "Anthropic's top model ($10/$50 per million, cache reads $0.25): Terminal-Bench 4.0 55.8% (Opus 5 52.3%), CursorBench 3.2 73.4%, and its biggest gains are on long-horizon agent work (Browserbase hard browser tasks 82% vs Opus 5 74%); figures are mostly vendor-reported. Fits the hardest tasks: long multi-step features across many files, deep debugging, architecture-heavy changes, work where Opus already failed. Slow and the heaviest on the Claude subscription's limits: not for routine or well-specified tasks.",
    sources: ["https://www.eesel.ai/blog/claude-fable-5-1-review", "https://codersera.com/blog/claude-fable-5-1-vs-opus-5-2026/amp/", "https://rits.shanghai.nyu.edu/ai/claude-fable-5-1-cache-read-price-cut/"],
  },
  {
    key: "opus", providerId: "claude-code", model: "claude-opus-5-5", reasoning: "high", label: "Claude Opus 5.5", tier: "strong", available: true,
    summary: "Anthropic's strongest everyday model: SWE-Bench Pro about 90%, catches more real bugs than Sonnet in review. Fits high-risk or open-ended changes: architecture, cross-cutting refactors, security-sensitive code, ambiguous bugs, migrations. The most expensive here: not for routine, well-scoped work.",
    sources: ["https://www.developersdigest.tech/blog/claude-opus-5-5-vs-sonnet-5-5-vs-haiku-5-5", "https://www.coderabbit.ai/blog/sonnet-5-5-model-review"],
  },
  {
    key: "glm-flash", providerId: "opencode2", model: "zai-coding-plan/glm-5.3-flash", reasoning: "high", label: "GLM-5.3 Flash (Z.AI)", tier: "light", available: true,
    summary: "Z.AI's fast model on the coding plan's quota: DeepSWE 63% (confirmed on the public leaderboard), Terminal-Bench 2.1 84.3 by Z.AI's own count. Fits routine agentic coding, scripts, debugging of small failures and bulk mechanical work when the main writers' limits matter. Most of its strong numbers are the vendor's; less proven on large features.",
    sources: ["https://docs.z.ai/guides/vlm/glm-5.3-flash", "https://www.datacamp.com/blog/glm-5-3-flash", "https://www.edenai.co/post/glm-5-3-flash-benchmark-vs-gemini-deepseek-gpt-5-6"],
  },
  {
    key: "zcode-flash", providerId: "zcode", model: "glm-5.3-flash-free", reasoning: "high", label: "ZCode · GLM-5.3-Flash · Free", tier: "standard", available: true,
    summary: "GLM-5.3-Flash run inside the owner's ZCode desktop app on the Mac mini on the Start Plan's free tokens (from 15:00 to 01:00 UTC): it costs nothing, and it is offered only while they are available, so when it fits the task it is the cheapest choice there is (the same model as GLM-5.3 Flash on the coding plan: DeepSWE 63%, good on mechanical and medium coding in our trials). Fits LARGE, self-contained tasks with clear checks: bulk mechanical edits across many similar files, documentation, writing tests for existing code, refactors and migrations that follow a pattern. Weak spots: ZCode adds about 35-43k input tokens of its own system prompt to every task, so a tiny task wastes it; it runs at most three tasks at once on the whole machine; it exists on the Mac mini only; stopping a task is slow. Not for the hardest design or debugging.",
    note: "offered only where it can work: the Mac mini, in the free hours (15:00-01:00 UTC, unless the setting zcode.window is always) and while a ZCode slot is free; the «· Free» model never bills the plan: without free tokens ZCode refuses and the next writer takes the task",
    sources: ["https://zcode.z.ai", "https://docs.z.ai/guides/vlm/glm-5.3-flash", "https://www.datacamp.com/blog/glm-5-3-flash"],
  },
  {
    key: "haiku", providerId: "claude-code", model: "claude-haiku-5-5", reasoning: "medium", label: "Claude Haiku 5.5", tier: "light", available: true,
    summary: "Anthropic's fast, very cheap model ($0.10/$0.50 per M tokens up to a 100K prompt, five times that above), built as a coding sub-agent: SWE-Bench Pro 64.8% (Sonnet 5.5 81.3%), SWE-bench Multilingual 83.7%; in a hands-on test it fixed a real production bug. Fits short, well-scoped edits with clear checks: a small fix, a test, a config or copy change, a one-file feature. Weak on long multi-step work (Terminal-Bench 4.0 39.2% against Sonnet's 70.6%) and costly past 100K tokens of context: not for large features or a big repository's wide changes.",
    sources: ["https://www.eesel.ai/blog/claude-haiku-5-5-review", "https://www.mindstudio.ai/blog/claude-haiku-5-5-real-world-test", "https://computingforgeeks.com/claude-haiku-5-5-released-features-benchmarks/", "https://www.developersdigest.tech/blog/claude-opus-5-5-vs-sonnet-5-5-vs-haiku-5-5"],
  },
  {
    key: "minimax-flash", providerId: "opencode2", model: "openlux/MiniMax-M3.1-Flash", reasoning: "high", label: "MiniMax M3.1 Flash", tier: "light", available: false,
    summary: "Very cheap ($0.15/$0.60 per M tokens), strong on agent workloads by its vendor (DeepSWE 73.7%), 73% on an independent long-session coding test against Opus 5.5's 87%; flagged for confident wrong answers.",
    note: "offered through OpenLux (pay per token), not in the owner's subscriptions: kept out of the pick", sources: ["https://www.minimax.io/blog/minimax-m31f", "https://bito.ai/blog/minimax-m3-1-flash-benchmark-vs-claude/"],
  },
  {
    key: "gemini-pro", providerId: "opencode2", model: "openrouter/~google/gemini-pro-latest", reasoning: "high", label: "Gemini Pro", tier: "strong", available: false,
    summary: "Google's large model.", note: "the owner's verdict: weak for this work; not used", sources: [],
  },
  {
    key: "gemini-argon", providerId: "opencode2", model: "openlux/gemini-4-argon", reasoning: "high", label: "Gemini 4 Argon", tier: "strong", available: false,
    summary: "Google's newest large model.", note: "not in the owner's subscriptions", sources: [],
  },
];

/** The profiles the pick may choose from: available, and in the project's list when it names one (`writer.models`). */
export function writerCandidates(settings: Record<string, unknown>): WriterProfile[] {
  const listed = Array.isArray(settings["writer.models"]) ? (settings["writer.models"] as unknown[]).map(String) : null;
  return WRITER_PROFILES.filter((profile) => profile.available && (!listed || listed.includes(profile.key)));
}
