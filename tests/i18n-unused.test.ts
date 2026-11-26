import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { en } from "@lane-pilot/i18n";
import { SETTINGS_REGISTRY } from "../src/rooms/settings-registry";

const ROOT = join(__dirname, "..");

/** Dynamic prefixes where i18n keys are constructed at runtime via template literals or mapping tables. */
const DYNAMIC_PREFIXES = [
  "acc_baseline_",
  "acc_verdict_",
  "accessBbPlugin_",
  "accessCliPlugin_",
  "accessCol_",
  "accessExcept_",
  "accessGroupShort_",
  "accessGroup_",
  "accessName_",
  "accessPurpose_",
  "accessSkill_",
  "accessSwitchNote_",
  "attempt_",
  "boardGate_",
  "docsCadence_",
  "docsReason_",
  "field_",
  "graphRole_",
  "howLevel",
  "howStepBody_",
  "howStep_",
  "kind_",
  "phase_",
  "reason_",
  "ret_to_",
  "roleModelName_",
  "roleModelWhy_",
  "schColumn_",
  "schFormPreset_",
  "schKind_",
  "schRunStatus_",
  "schTrigger_",
  "schWhoIssue_",
  "schWhoSource_",
  "section_",
  "stage_",
  "state_",
  "trackRisk_",
  "unapplied",
  "wfEditCondMode_",
  "wfEditEnv_",
  "wfEditJoin_",
  "wfEditOp_",
  "wfEditPassHint_",
  "wfEditSession_",
  "wfEditTimeout_",
  "wfEditType_",
  "wfKind_",
  "wfModelCost_",
  "wfModelIssue_",
  "wfModelOverrideScope_",
  "wfModelSrc_",
  "wfPass_",
  "wfRerunReason_",
  "wfRunReason_",
  "wfRunStatus_",
  "wfScope_",
  "wfStatus_",
] as const;

function walkTs(dir: string, skip?: (rel: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const abs = join(dir, entry.name);
    const rel = abs.slice(ROOT.length + 1);
    if (skip?.(rel)) continue;
    if (entry.isDirectory()) out.push(...walkTs(abs, skip));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(abs);
  }
  return out;
}

describe("i18n unused keys", () => {
  it("has no unreferenced keys outside declared dynamic prefixes", () => {
    const files = [
      join(ROOT, "app.tsx"),
      join(ROOT, "server.ts"),
      join(ROOT, "host.ts"),
      ...walkTs(join(ROOT, "src")),
      ...walkTs(join(ROOT, "packages"), (rel) => rel.startsWith("packages/i18n/")),
    ];
    const i18nMain = readFileSync(join(ROOT, "packages/i18n/src/i18n.ts"), "utf8");
    const i18nCodeTail = i18nMain.slice(i18nMain.indexOf("export const en = "));
    const corpus = [
      ...files.map((file) => readFileSync(file, "utf8")),
      i18nCodeTail,
      readFileSync(join(ROOT, "packages/i18n/src/role-names.ts"), "utf8"),
    ].join("\n");

    const regIds = new Set(SETTINGS_REGISTRY.visible.map((def) => def.id));
    const regSections = new Set(SETTINGS_REGISTRY.visible.map((def) => def.section));
    const unused = Object.keys(en).filter((key) => {
      if (corpus.includes(`"${key}"`) || corpus.includes(`'${key}'`)) return false;
      return !DYNAMIC_PREFIXES.some((prefix) => key.startsWith(prefix));
    });
    const staleDynamic = Object.keys(en).filter((key) => {
      if (corpus.includes(`"${key}"`) || corpus.includes(`'${key}'`)) return false;
      if (key.startsWith("field_")) return !regIds.has(key.slice(6));
      if (key.startsWith("reason_")) return !regIds.has(key.slice(7));
      if (key.startsWith("section_")) return !regSections.has(key.slice(8));
      return false;
    });

    expect(unused, `unused i18n keys: ${unused.join(", ")}`).toEqual([]);
    expect(staleDynamic, `stale dynamic setting i18n keys: ${staleDynamic.join(", ")}`).toEqual([]);
  });
});
