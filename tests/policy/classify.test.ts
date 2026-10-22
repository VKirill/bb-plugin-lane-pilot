import { describe, expect, it } from "vitest";
import { EXAM } from "../../src/rooms/policy/exam";
import { POLICY, classifyChange, explainChange, globMatch, normalizePath, parsePolicy, type ChangeDescriptor } from "../../src/rooms/policy/policy";

const proof = { bench_subset_passed: true, auto_revertible: true };

describe("classifyChange: one change from each list goes to its own tier", () => {
  const cases: Array<[string, ChangeDescriptor, string]> = [
    ["LP-fault repair with proof", { kind: "lp_fault_repair", files: ["src/rooms/relay/server/relay.ts", "tests/relay.test.ts"], attrs: proof }, "night_decides"],
    ["docs regeneration", { kind: "docs_regenerate", files: ["docs/learning.md", "packages/kit/docs/index.md"] }, "night_decides"],
    ["memory note expiry", { kind: "memory_note_expire", attrs: { memory_tier: "note" } }, "night_decides"],
    ["retire a harness tree that lost on the bench", { kind: "harness_retire", attrs: { lost_on_bench: true } }, "night_decides"],
    ["green deploy", { kind: "deploy", attrs: { full_suite_green: true, drill_green: true, auto_revertible: true } }, "night_decides"],
    ["rule on trial (an accepted rule is core memory: a proposal since version 2)", { kind: "rule_adopt", attrs: { trial: true, always_on: false } }, "night_proposes"],
    ["rule the owner accepts", { kind: "rule_accept" }, "night_proposes"],
    ["always-on rule", { kind: "rule_adopt", attrs: { trial: true, always_on: true } }, "night_proposes"],
    ["default model for a role", { kind: "setting_change", settings: ["writer.model"] }, "night_proposes"],
    ["new pipeline stage", { kind: "stage_add" }, "night_proposes"],
    ["graph edit by file", { files: ["workflows/lp-task-pipeline.json"] }, "night_proposes"],
    ["graph edit by kind", { kind: "graph_edit" }, "night_proposes"],
    ["run budget", { kind: "setting_change", settings: ["run.max_tokens"] }, "owner_only"],
    ["daily judge cap", { settings: ["dailyJudgeCap"] }, "owner_only"],
    ["Env Catalog code", { files: ["src/rooms/secrets/server/issuance.ts"] }, "owner_only"],
    ["secret table", { tables: ["lane_pilot_secret_issuance"] }, "owner_only"],
    ["irreversible data action", { kind: "data_delete" }, "owner_only"],
    ["irreversible by attribute", { kind: "something_new", attrs: { irreversible: true } }, "owner_only"],
    ["project deletion", { kind: "project_delete" }, "owner_only"],
    ["a gate", { files: ["src/rooms/verification/ownership.ts"] }, "owner_only"],
    ["a verification setting", { settings: ["verification.sandbox_unsafe"] }, "owner_only"],
    ["the bench set", { files: ["bench/set-1/task-3.json"] }, "owner_only"],
    ["a threshold", { settings: ["review.accuracy"] }, "owner_only"],
    ["this policy", { files: ["policy/night-policy.json"] }, "owner_only"],
    ["the classifier", { files: ["src/rooms/policy/policy.ts"] }, "owner_only"],
  ];
  it.each(cases)("%s", (_name, change, tier) => expect(classifyChange(change)).toBe(tier));
});

describe("classifyChange: the rule", () => {
  it("an unknown change is a proposal", () => {
    expect(classifyChange({ kind: "teleport", files: ["src/new-thing.ts"] })).toBe("night_proposes");
    expect(classifyChange({})).toBe("night_proposes");
  });

  it("the most restrictive match wins: a repair that touches a gate is the owner's", () => {
    const repair: ChangeDescriptor = { kind: "lp_fault_repair", files: ["src/rooms/relay/server/relay.ts"], attrs: proof };
    expect(classifyChange(repair)).toBe("night_decides");
    expect(classifyChange({ ...repair, files: [...repair.files!, "src/rooms/verification/ownership.ts"] })).toBe("owner_only");
    const hit = explainChange({ ...repair, files: ["src/rooms/verification/ownership.ts"] });
    expect(hit.matched.map((m) => m.id).sort()).toEqual(["judge_gates", "lp_fault_repair"]);
  });

  it("a repair that edits the graph is downgraded to a proposal (graph changes go through the owner's yes)", () => {
    expect(classifyChange({ kind: "lp_fault_repair", files: ["packages/workflow-engine/src/run.ts"], attrs: proof })).toBe("night_proposes");
  });

  it("a night_decides entry without its proof is no match: unknown, so a proposal", () => {
    expect(classifyChange({ kind: "lp_fault_repair" })).toBe("night_proposes");
    expect(classifyChange({ kind: "lp_fault_repair", attrs: { bench_subset_passed: true } })).toBe("night_proposes");
    expect(classifyChange({ kind: "lp_fault_repair", attrs: { bench_subset_passed: true, auto_revertible: "true" } })).toBe("night_proposes");
    expect(classifyChange({ kind: "lp_fault_repair", attrs: { bench_subset_passed: false, auto_revertible: true } })).toBe("night_proposes");
  });

  it("docs regeneration that also touches code is no longer docs regeneration", () => {
    expect(classifyChange({ kind: "docs_regenerate", files: ["docs/a.md", "src/rooms/learning/store.ts"] })).toBe("night_proposes");
    expect(classifyChange({ kind: "docs_regenerate" })).toBe("night_proposes");
  });

  it("a docs path that climbs out of docs/ is judged by where it lands", () => {
    expect(classifyChange({ kind: "docs_regenerate", files: ["docs/../policy/night-policy.json"] })).toBe("owner_only");
    expect(classifyChange({ files: ["docs/../../bb-plugin-other/x.ts"] })).toBe("owner_only");
  });

  it("case and separators do not hide a protected file", () => {
    expect(classifyChange({ files: ["Policy/Night-Policy.JSON"] })).toBe("owner_only");
    expect(classifyChange({ files: ["policy\\exam.json"] })).toBe("owner_only");
    expect(classifyChange({ files: ["./src/rooms/Verification/gate-output.ts"] })).toBe("owner_only");
  });

  it("anything outside the repository is the owner's", () => {
    expect(classifyChange({ files: ["../bb-plugin-opencode2/src/provider.ts"] })).toBe("owner_only");
    expect(classifyChange({ files: ["/etc/hosts"] })).toBe("owner_only");
  });

  it("env files in any folder are secrets", () => {
    expect(classifyChange({ files: [".env"] })).toBe("owner_only");
    expect(classifyChange({ files: ["apps/admin/.env.production"] })).toBe("owner_only");
  });

  it("a gate setting is the owner's even inside a setting change of a model key", () => {
    expect(classifyChange({ kind: "setting_change", settings: ["writer.model", "night_review.auto_merge"] })).toBe("owner_only");
  });

  it("the stage of a model default is a proposal, a budget next to it makes it the owner's", () => {
    expect(classifyChange({ settings: ["night_review.model"] })).toBe("night_proposes");
    expect(classifyChange({ settings: ["night_review.model", "memory.core_budget"] })).toBe("owner_only");
  });

  it("an empty files list never satisfies files_all", () => {
    expect(classifyChange({ kind: "docs_regenerate", files: [] })).toBe("night_proposes");
  });

  it("an always-on rule is a proposal even with trial proof", () => {
    expect(classifyChange({ kind: "rule_adopt", attrs: { trial: true, always_on: true } })).toBe("night_proposes");
  });
});

describe("standing prohibitions: what the owner said never to do is his, whatever else the change is", () => {
  const cases: Array<[string, string, ChangeDescriptor]> = [
    ["never_acp_opencode", "provider attr", { kind: "setting_change", attrs: { provider: "acp-opencode" } }],
    ["never_acp_opencode", "setting key", { settings: ["providers.acp-opencode.enabled"] }],
    ["never_acp_opencode", "kind", { kind: "opencode_v1_enable" }],
    ["never_jev_routes_session_turns", "kind", { kind: "jev_route_session_turn" }],
    ["never_jev_routes_session_turns", "target attr", { attrs: { jev_route_target: "owner_message" } }],
    ["never_lane_rules_on_plain_sessions", "ungated hook", { kind: "lane_hook_ungated" }],
    ["never_fast_tier_default", "tier attr", { settings: ["writer.service_tier"], attrs: { service_tier: "fast" } }],
    ["never_bb_connect_expose", "kind", { kind: "bb_connect_expose" }],
    ["never_flat_access_ban", "bare refusal", { attrs: { refusal_text: "bare" } }],
    ["never_full_suite_per_parallel_agent", "agent run", { kind: "full_suite_run", attrs: { actor: "parallel_agent" } }],
    ["never_block_env_catalog_reads", "attr", { attrs: { blocks_env_catalog_get: true } }],
  ];
  it.each(cases)("%s (%s)", (id, _how, change) => {
    const answer = explainChange(change);
    expect(answer.tier).toBe("owner_only");
    expect(answer.matched.map((hit) => hit.id)).toContain(id);
  });

  it("beats a night_decides proof on the same change", () => {
    const repair: ChangeDescriptor = { kind: "lp_fault_repair", files: ["src/rooms/relay/server/relay.ts"], attrs: { ...proof, service_tier: "fast" } };
    expect(classifyChange(repair)).toBe("owner_only");
  });

  it("the same vocabulary with another value is not a prohibition", () => {
    expect(classifyChange({ attrs: { service_tier: "default" } })).toBe("night_proposes");
    expect(classifyChange({ attrs: { provider: "opencode2" } })).toBe("night_proposes");
    expect(classifyChange({ attrs: { jev_route_target: "subagent" } })).toBe("night_proposes");
  });

  it("every prohibition quotes its source, with a file and a line for memory files, and examples", () => {
    expect(POLICY.standing_prohibitions.length).toBeGreaterThanOrEqual(8);
    for (const entry of POLICY.standing_prohibitions) {
      expect(entry.source.quote.length, entry.id).toBeGreaterThan(20);
      expect(entry.examples.length, entry.id).toBeGreaterThan(0);
      if (entry.source.type === "memory_file") expect(entry.source.line, entry.id).toBeGreaterThan(0);
      expect(entry.id.startsWith("never_"), entry.id).toBe(true);
    }
  });

  it("a prohibition whose quote overlaps an exam item says so (cited_by_v1_exam); the rest share no text with the exam", () => {
    const quotes = EXAM.items.map((item) => item.quote.trim().toLowerCase());
    for (const entry of POLICY.standing_prohibitions) {
      const own = entry.source.quote.trim().toLowerCase();
      const overlaps = quotes.some((quote) => quote.includes(own) || own.includes(quote));
      if (overlaps) expect(entry.source.cited_by_v1_exam, `${entry.id} shares text with an exam item but is not marked cited_by_v1_exam`).toBe(true);
    }
  });

  it("cited_by_v1_exam tells the truth: it is set exactly for the files a v1 exam item cites", () => {
    const cited = new Set(EXAM.items.filter((item) => item.source.type === "memory").map((item) => item.source.ref));
    for (const entry of POLICY.standing_prohibitions) if (entry.source.type === "memory_file") expect(entry.source.cited_by_v1_exam, entry.id).toBe(cited.has(entry.source.ref));
  });
});

describe("globs and paths", () => {
  it("* stays in a segment, ** crosses them, ?  is one character", () => {
    expect(globMatch("docs/*.md", "docs/a.md")).toBe(true);
    expect(globMatch("docs/*.md", "docs/a/b.md")).toBe(false);
    expect(globMatch("docs/**", "docs/a/b/c.md")).toBe(true);
    expect(globMatch("**/.env", ".env")).toBe(true);
    expect(globMatch("**/.env", "a/b/.env")).toBe(true);
    expect(globMatch("a?c", "abc")).toBe(true);
    expect(globMatch("a?c", "a/c")).toBe(false);
  });

  it("dots in a glob are literal", () => {
    expect(globMatch("a.b", "axb")).toBe(false);
  });

  it("normalises", () => {
    expect(normalizePath("./a//b/../c")).toBe("a/c");
    expect(normalizePath("A\\B")).toBe("a/b");
    expect(normalizePath("../x")).toBe("../x");
  });
});

describe("policy file shape", () => {
  it("every entry id is unique and every design item informs a real entry", () => {
    const ids = new Set([...POLICY.night_decides, ...POLICY.night_proposes, ...POLICY.owner_only, ...POLICY.standing_prohibitions].map((entry) => entry.id));
    for (const item of POLICY.design_items) for (const id of item.informs) expect(ids.has(id), `${item.id} informs unknown entry ${id}`).toBe(true);
  });

  it("refuses a matcher without a field and a duplicate id", () => {
    const base = JSON.parse(JSON.stringify(POLICY));
    base.owner_only[0].match = [{}];
    expect(() => parsePolicy(base)).toThrow();
    const dup = JSON.parse(JSON.stringify(POLICY));
    dup.night_proposes[0].id = dup.owner_only[0].id;
    expect(() => parsePolicy(dup)).toThrow(/twice/);
  });

  it("the brief's lists are all present", () => {
    const has = (list: Array<{ id: string }>, ...ids: string[]) => ids.every((id) => list.some((entry) => entry.id === id));
    expect(has(POLICY.night_decides, "lp_fault_repair", "docs_regeneration", "memory_note_expiry", "harness_retire_lost")).toBe(true);
    expect(has(POLICY.night_proposes, "rule_trial_apply", "rule_always_on", "default_model_change", "new_pipeline_stage", "graph_edit")).toBe(true);
    expect(has(POLICY.owner_only, "spending_caps", "secrets_env_catalog", "irreversible_data", "judge_gates", "judge_bench_set", "judge_thresholds", "policy_itself", "project_deletion")).toBe(true);
  });
});
