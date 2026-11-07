import { describe, expect, it } from "vitest";
import {
  COUNCIL_KEYS, COUNCIL_SEATS, PAIR_ROLE_SPECS, ROLE_SPECS, ROLE_SELECTION_KEYS, ROLE_TABLE,
  roleAtomicMessage, roleSpec, roleSpecKey, WRITER_FALLBACK_KEYS, WRITER_FALLBACK_SLOTS,
} from "@lane-pilot/models";
import { rpcSettings } from "../src/rooms/contracts/rpc-settings";
import { SELECTION_SPECS, selectionKeys, type SelectionId } from "../src/rooms/settings/ui/picker-selections";
import { ROLE_GROUPS } from "../src/rooms/native-agent/ui/team-model";
import { en, ru } from "@lane-pilot/i18n";
import { NATIVE_CODE_CRITIQUE_KEYS, NATIVE_DOCS_KEYS, NATIVE_MEMORY_KEYS, NATIVE_NIGHT_REVIEW_KEYS, NATIVE_ONBOARDING_KEYS, NATIVE_PLAN_CRITIQUE_KEYS, NATIVE_PM_READ_KEYS, NATIVE_PROJECT_LIFE_KEYS, NATIVE_SPECIALIST_KEYS, NATIVE_WRITER_KEYS } from "../src/rooms/runs/server/run-routing";

/**
 * The names the hand-written code had before the RoleSpec table (packages/models/role-specs.ts). The table is the one list now; this
 * snapshot is the old one, so a rename of an RPC or a setting key cannot pass silently.
 */
const OLD_RPC_NAMES = [
  "save_writer_selection", "save_memory_selection", "save_night_review_selection", "save_docs_selection",
  "save_project_life_selection", "save_pm_read_selection", "save_onboarding_selection", "save_plan_critique_selection",
  "save_specialist_selection", "save_writer_fallback_selection", "save_council_seat_selection", "save_code_critique_selection",
].sort();

const OLD_SETTING_KEYS = [
  "writer.provider", "writer.model", "writer.reasoning_effort", "writer.service_tier",
  "memory.provider", "memory.model", "memory.reasoning_effort", "memory.service_tier",
  "night_review.provider", "night_review.model", "night_review.reasoning_effort", "night_review.service_tier",
  "docs.provider", "docs.model", "docs.reasoning_effort", "docs.service_tier",
  "project_life.provider", "project_life.model", "project_life.reasoning_effort", "project_life.service_tier",
  "onboarding.provider", "onboarding.model", "onboarding.reasoning_effort", "onboarding.service_tier",
  "pm_read.provider", "pm_read.model", "pm_read.reasoning_effort", "pm_read.service_tier",
  "plan_critique.provider", "plan_critique.model", "plan_critique.reasoning_effort", "plan_critique.service_tier",
  "code_critique.provider", "code_critique.model", "code_critique.reasoning_effort", "code_critique.service_tier",
  "specialist.provider", "specialist.model", "specialist.reasoning_effort", "specialist.service_tier",
  ...["product", "demand", "audience", "skeptic", "growth", "ux", "chair"].flatMap((seat) => [`council.${seat}.provider`, `council.${seat}.model`, `council.${seat}.reasoning_effort`]),
  ...[1, 2, 3].flatMap((slot) => [`writer.fallback${slot}.provider`, `writer.fallback${slot}.model`, `writer.fallback${slot}.reasoning_effort`]),
].sort();

const OLD_PICKER_KEYS = OLD_SETTING_KEYS.filter((key) => !key.startsWith("writer.fallback"));

const OLD_ATOMIC_MESSAGES: Record<string, string> = {
  memory: "use atomic memory provider/model selection",
  night_review: "use atomic night-review provider/model selection",
  docs: "use atomic docs provider/model selection",
  project_life: "use atomic project-life provider/model selection",
  onboarding: "use atomic onboarding provider/model selection",
  pm_read: "use atomic PM-read provider/model selection",
  plan_critique: "use atomic plan-critique provider/model selection",
  code_critique: "use atomic code-critique provider/model selection",
  specialist: "use atomic specialist provider/model selection",
};

const OLD_SELECTION_SPECS: Record<string, { prefix: string; rpc: string; effort: string; effortFromWriter?: boolean }> = {
  memory: { prefix: "memory", rpc: "save_memory_selection", effort: "none", effortFromWriter: true },
  night: { prefix: "night_review", rpc: "save_night_review_selection", effort: "high" },
  docs: { prefix: "docs", rpc: "save_docs_selection", effort: "high" },
  projectLife: { prefix: "project_life", rpc: "save_project_life_selection", effort: "high" },
  pmRead: { prefix: "pm_read", rpc: "save_pm_read_selection", effort: "low" },
  onboarding: { prefix: "onboarding", rpc: "save_onboarding_selection", effort: "medium" },
  planCritique: { prefix: "plan_critique", rpc: "save_plan_critique_selection", effort: "medium", effortFromWriter: true },
  codeCritique: { prefix: "code_critique", rpc: "save_code_critique_selection", effort: "medium", effortFromWriter: true },
  specialist: { prefix: "specialist", rpc: "save_specialist_selection", effort: "high" },
};

describe("the RoleSpec table against the names it replaced", () => {
  it("names exactly the RPCs the hand-written contract had", () => {
    expect([...ROLE_SPECS.map((spec) => spec.rpc)].sort()).toEqual(OLD_RPC_NAMES);
    for (const rpc of OLD_RPC_NAMES) expect(rpcSettings, rpc).toHaveProperty(rpc);
  });

  it("owns exactly the setting keys the hand-written sets had", () => {
    expect([...ROLE_SELECTION_KEYS].sort()).toEqual(OLD_SETTING_KEYS);
    expect([...PAIR_ROLE_SPECS.flatMap((spec) => [...spec.keys]), ...COUNCIL_KEYS].sort()).toEqual(OLD_PICKER_KEYS);
  });

  it("derives the NATIVE_*_KEYS sets of the runs room from the same rows", () => {
    const sets: Record<string, Set<string>> = {
      writer: NATIVE_WRITER_KEYS, memory: NATIVE_MEMORY_KEYS, night_review: NATIVE_NIGHT_REVIEW_KEYS, docs: NATIVE_DOCS_KEYS,
      project_life: NATIVE_PROJECT_LIFE_KEYS, onboarding: NATIVE_ONBOARDING_KEYS, pm_read: NATIVE_PM_READ_KEYS,
      plan_critique: NATIVE_PLAN_CRITIQUE_KEYS, code_critique: NATIVE_CODE_CRITIQUE_KEYS, specialist: NATIVE_SPECIALIST_KEYS,
    };
    for (const [id, set] of Object.entries(sets)) expect([...set].sort(), id).toEqual([...roleSpec(id)!.keys].sort());
  });

  it("keeps the council seats and the writer fallback slots", () => {
    expect([...COUNCIL_SEATS]).toEqual(["product", "demand", "audience", "skeptic", "growth", "ux", "chair"]);
    expect([...WRITER_FALLBACK_SLOTS]).toEqual([1, 2, 3]);
    expect(COUNCIL_KEYS).toHaveLength(21);
    expect(WRITER_FALLBACK_KEYS).toHaveLength(9);
    expect(roleSpec("council")!.keys).toEqual(COUNCIL_KEYS);
    expect(roleSpec("writer_fallback")!.keys).toEqual(WRITER_FALLBACK_KEYS);
  });

  it("answers save_setting with the same per-role message", () => {
    for (const [id, message] of Object.entries(OLD_ATOMIC_MESSAGES)) expect(roleAtomicMessage(id), id).toBe(message);
    expect(roleAtomicMessage("writer")).toBeNull();
  });

  it("drives the screen's picker specs and the page's key constants", () => {
    for (const [id, old] of Object.entries(OLD_SELECTION_SPECS)) {
      const spec = SELECTION_SPECS[id as SelectionId];
      expect(spec, id).toMatchObject({ prefix: old.prefix, rpc: old.rpc, effort: old.effort });
      expect(spec.effortFromWriter, id).toBe(old.effortFromWriter);
      const keys = PAIR_ROLE_SPECS.find((row) => row.selectionId === id)?.keys ?? [];
      expect(Object.values(selectionKeys(id as SelectionId)).sort(), id).toEqual([...keys].sort());
    }
    expect(roleSpecKey("writer", "provider")).toBe("writer.provider");
    expect(roleSpecKey("night_review", "service_tier")).toBe("night_review.service_tier");
  });

  it("names role-table rows that exist", () => {
    const rows = new Set(ROLE_TABLE.map((row) => row.id));
    for (const spec of ROLE_SPECS) if (spec.tableRole) expect(rows, spec.id).toContain(spec.tableRole!);
  });

  it("gives every selection a team row, an access role and its i18n names", () => {
    const listed = ROLE_GROUPS.flatMap((group) => group.roles.map((role) => role.id));
    for (const spec of ROLE_SPECS) {
      if (!spec.accessRole) continue;
      expect(listed, spec.id).toContain(spec.accessRole);
      const id = spec.accessRole.replace(/[:-]/g, "_");
      expect((en as Record<string, string>)[`accessName_${id}`], spec.id).toBeTruthy();
      expect((ru as Record<string, string>)[`accessName_${id}`], spec.id).toBeTruthy();
    }
  });
});
