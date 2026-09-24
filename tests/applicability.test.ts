import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SETTING_CATALOG } from "../src/channels";
import { UI_CATALOG, VISIBLE_CATALOG } from "../src/ui-catalog";

const summary = JSON.parse(
  readFileSync(new URL("../src/ui-catalog.summary.json", import.meta.url), "utf8"),
) as { editable: number; readonly: number; gap: number; excluded: number; blank: number; tuple_equal: boolean };

const SETTINGS = JSON.parse(
  readFileSync(new URL("../../../.agency/jobs/AG-179/settings.json", import.meta.url), "utf8"),
) as { settings: Array<{ area: string; setting: string; location: string; category: string }> };

const APPLICABILITY = readFileSync(new URL("../docs/adoc-applicability.md", import.meta.url), "utf8");
const PATH_LINE = /[A-Za-z0-9_./{}*-]+:\d+/;

function parseApplicabilityTable(): Array<{
  area: string; setting: string; location: string; category: string;
  decision: string; evidence: string;
}> {
  const lines = APPLICABILITY.split("\n");
  const start = lines.findIndex((line) => line.startsWith("| # | area | setting | location | category |"));
  expect(start).toBeGreaterThanOrEqual(0);
  const rows: ReturnType<typeof parseApplicabilityTable> = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith("|")) break;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    expect(cells).toHaveLength(8);
    rows.push({
      area: cells[1]!,
      setting: cells[2]!,
      location: cells[3]!,
      category: cells[4]!,
      decision: cells[6]!,
      evidence: cells[7]!,
    });
  }
  return rows;
}

describe("adoc applicability catalog", () => {
  it("matches settings.json 1:1 on area+setting+location+category", () => {
    expect(UI_CATALOG).toHaveLength(381);
    expect(SETTINGS.settings).toHaveLength(355);
    const catalogKeys = UI_CATALOG.slice(0,355).map((row) => `${row.area}\0${row.setting}\0${row.location}\0${row.category}`);
    const settingKeys = SETTINGS.settings.map((row) => `${row.area}\0${row.setting}\0${row.location}\0${row.category}`);
    expect(catalogKeys).toEqual(settingKeys);
  });

  it("has a decision and path:line evidence on every row and counts match", () => {
    expect(UI_CATALOG.every((row) => row.uiStatus.length > 0 && row.rationale.length > 0 && PATH_LINE.test(row.evidence))).toBe(true);
    const counts = { editable: 0, readonly: 0, gap: 0, excluded: 0 };
    for (const row of UI_CATALOG) counts[row.uiStatus] += 1;
    expect(counts).toEqual({
      editable: summary.editable,
      readonly: summary.readonly,
      gap: summary.gap,
      excluded: summary.excluded,
    });
    expect(counts.editable + counts.readonly + counts.gap + counts.excluded).toBe(381);
    expect(summary.blank).toBe(0);
    expect(summary.tuple_equal).toBe(true);
  });

  it("exposes native task-level workspace risk and multi-output controls",()=>{
    expect(UI_CATALOG.find(row=>row.id==="s041")).toMatchObject({
      storageKey:"adoc.041",uiStatus:"editable",control:"slider",min:0,max:10,defaultValue:"4",
    });
    expect(UI_CATALOG.find(row=>row.id==="s042")).toMatchObject({
      storageKey:"adoc.042",uiStatus:"editable",control:"switch",defaultValue:"true",
    });
  });

  it("exposes the typed run gate with exact upstream choices and an executable consumer",()=>{
    expect(UI_CATALOG.find((row)=>row.id==="s333")).toMatchObject({
      storageKey:"run.gate",uiStatus:"editable",channel:"OWN",control:"select",options:["none","pre-merge"],defaultValue:"none",
      evidence:"server.ts:719",
    });
  });

  it("adapts run-v2 pools through bounded native settings and derives score/risk into receipts",()=>{
    expect(UI_CATALOG.find((row)=>row.id==="s331")).toMatchObject({storageKey:"ops.pool_size",uiStatus:"readonly",channel:"NONE"});
    expect(UI_CATALOG.find((row)=>row.id==="s332")).toMatchObject({storageKey:"ops.verify_pool_size",uiStatus:"readonly",channel:"NONE"});
    expect(UI_CATALOG.find((row)=>row.id==="s334")).toMatchObject({uiStatus:"readonly",channel:"NONE",evidence:"server.ts:1174"});
    expect(UI_CATALOG.find((row)=>row.id==="s335")).toMatchObject({uiStatus:"readonly",channel:"NONE",evidence:"server.ts:1174"});
  });

  it("maps upstream gate-report category choices to typed gate-event reporting",()=>{
    expect(UI_CATALOG.find((row)=>row.id==="s284")).toMatchObject({uiStatus:"readonly",channel:"NONE",
      options:["accept","owns-paths","validate","verification"],evidence:"server.ts:3050"});
    expect(APPLICABILITY).toContain("| 284 | gate scripts | gate-report --gate | bin/gate-report:129 | user | NONE | readonly |");
  });

  it("documents the 355 source rows and native docs/onboarding additions with location and path:line", () => {
    const rows = parseApplicabilityTable();
    expect(rows).toHaveLength(381);
    expect(rows.filter((row) => !PATH_LINE.test(row.evidence))).toEqual([]);
    for (const [index, row] of rows.slice(0,355).entries()) {
      expect(row.area).toBe(SETTINGS.settings[index]!.area);
      expect(row.setting).toBe(SETTINGS.settings[index]!.setting);
      expect(row.location).toBe(SETTINGS.settings[index]!.location);
      expect(row.category).toBe(SETTINGS.settings[index]!.category);
      expect(row.decision.length).toBeGreaterThan(0);
    }
    expect(rows.slice(355).map((row)=>row.setting)).toEqual(["docs.provider","docs.model","docs.reasoning_effort","docs.service_tier","onboarding.provider","onboarding.model","onboarding.reasoning_effort","onboarding.service_tier","onboarding.agent","onboarding.depth","sandbox.backend","helper.context_mode","helper.skills","helper.mcp_servers","helper.bb_plugins","helper.native_plugins","helper.placement","code_critique.enabled","code_critique.mode","code_critique.provider","code_critique.model","code_critique.reasoning_effort","code_critique.service_tier","code_critique.agent","code_critique.auto_fix","code_critique.max_rounds"]);
    const sums = { editable: 0, readonly: 0, gap: 0, excluded: 0 };
    for (const row of rows) sums[row.decision as keyof typeof sums] += 1;
    expect(sums).toEqual({
      editable: summary.editable,
      readonly: summary.readonly,
      gap: summary.gap,
      excluded: summary.excluded,
    });
  });

  it("maps every SETTING_CATALOG key onto a UI storageKey", () => {
    const stored = new Set(UI_CATALOG.map((row) => row.storageKey));
    expect(SETTING_CATALOG.map((spec) => spec.key).filter((key) => !stored.has(key))).toEqual([]);
  });

  it("maps docs-specific model controls to the native picker and runtime",()=>{
    expect(UI_CATALOG.slice(355).every((row)=>row.uiStatus==="editable"&&row.channel==="OWN")).toBe(true);
    expect(UI_CATALOG.find((row)=>row.id==="s365")).toMatchObject({storageKey:"sandbox.backend",control:"select",options:["auto","macos-seatbelt","linux-bubblewrap"],defaultValue:"auto"});
    expect(UI_CATALOG.find((row)=>row.id==="s274")).toMatchObject({uiStatus:"readonly",storageKey:"adoc.274",section:"guard"});
  });

  it("maps upstream gate-triage auto-merge to the sole native, gated night-fix control",()=>{
    expect(UI_CATALOG.find((row)=>row.id==="s291")).toMatchObject({uiStatus:"readonly",channel:"NONE",storageKey:"night_review.auto_merge"});
    expect(UI_CATALOG.find((row)=>row.id==="s007")).toMatchObject({uiStatus:"editable",channel:"OWN",storageKey:"night_review.auto_merge"});
    expect(UI_CATALOG.find((row)=>row.id==="s290")).toMatchObject({uiStatus:"readonly",channel:"NONE",storageKey:"night_review.provider"});
    expect(UI_CATALOG.find((row)=>row.id==="s088")).toMatchObject({uiStatus:"editable",channel:"OWN",storageKey:"night_review.provider"});
  });

  it("maps legacy stage/ownership inputs only when a native runtime equivalent is present",()=>{
    for (const [id, evidence] of [["s098","server.ts:1846"],["s099","server.ts:1906"],["s100","server.ts:1909"],["s102","server.ts:1884"],["s117","server.ts:1810"],["s276","src/task-v2.ts:33"],["s277","server.ts:911"],["s278","server.ts:1441"],["s279","server.ts:1085"],["s281","src/database.ts:574"],["s282","server.ts:910"]]) {
      expect(UI_CATALOG.find((row)=>row.id===id)).toMatchObject({uiStatus:"readonly",channel:"NONE",evidence});
    }
    expect(UI_CATALOG.find((row)=>row.id==="s280")?.uiStatus).toBe("readonly");
    expect(UI_CATALOG.filter((row)=>row.id>="s355"&&row.id<="s364").every((row)=>row.uiStatus==="editable"&&row.channel==="OWN")).toBe(true);
  });

  it("maps workspace threshold and session task cap to their native runtime consumers",()=>{
    expect(UI_CATALOG.find((row)=>row.id==="s055")).toMatchObject({storageKey:"adoc.041",uiStatus:"editable",channel:"OWN"});
    expect(UI_CATALOG.find((row)=>row.id==="s056")).toMatchObject({storageKey:"ops.max_tasks",uiStatus:"editable",channel:"OPS-DIRECT"});
  });

  it("exposes the three active plan-critique policy controls and keeps the hidden TUI aggregate read-only",()=>{
    expect(UI_CATALOG.find((row)=>row.id==="s078")).toMatchObject({storageKey:"plan_critique.min_score",uiStatus:"editable",channel:"OWN",control:"number",defaultValue:"7"});
    expect(UI_CATALOG.find((row)=>row.id==="s079")).toMatchObject({storageKey:"plan_critique.min_write_tasks",uiStatus:"editable",channel:"OWN",control:"number",defaultValue:"3"});
    expect(UI_CATALOG.find((row)=>row.id==="s080")).toMatchObject({storageKey:"plan_critique.on_high_risk",uiStatus:"editable",channel:"OWN",control:"switch",defaultValue:"true"});
    expect(UI_CATALOG.find((row)=>row.id==="s156")).toMatchObject({uiStatus:"readonly",channel:"NONE",evidence:"server.ts:332"});
  });

  it("maps gate-report and gate-triage inputs only where the native BB stage implements the behavior",()=>{
    for(const id of ["s283","s285","s286","s287","s288","s289","s292","s293","s336"]){
      expect(UI_CATALOG.find((row)=>row.id===id)?.uiStatus).toBe("readonly");
      expect(UI_CATALOG.find((row)=>row.id===id)?.evidence).toMatch(/server\.ts:\d+|src\/[a-z/-]+\.ts:\d+/);
    }
    expect(UI_CATALOG.find((row)=>row.id==="s290")?.uiStatus).toBe("readonly");
  });

  it("maps the legacy gate-log path to the project-scoped append-only BB event ledger without exposing a global path write",()=>{
    expect(UI_CATALOG.find((row)=>row.id==="s272")).toMatchObject({uiStatus:"readonly",channel:"NONE",storageKey:"adoc.272",
      evidence:"src/database.ts:155",rationale:expect.stringContaining("append-only project ledger")});
    expect(UI_CATALOG.find((row)=>row.id==="s272")?.rationale).toContain("global file-path/off switch is intentionally not written or honored");
  });

  it("documents retry LANE_JEV_EFFORT as an alias of the single native control",()=>{
    expect(UI_CATALOG.find((row)=>row.id==="s273")).toMatchObject({
      storageKey:"jev.LANE_JEV_EFFORT",uiStatus:"readonly",channel:"NONE",evidence:"server.ts:825",
    });
  });

  it("keeps legacy fast-mode rows diagnostic and aliases the TUI field to service tier", () => {
    const legacy = UI_CATALOG.filter((row) => ["s024", "s303", "s315"].includes(row.id));
    expect(legacy).toHaveLength(3);
    expect(legacy.every((row) => row.storageKey === "writer.fast_mode" && row.uiStatus === "readonly" && row.channel === "NONE")).toBe(true);
    expect(UI_CATALOG.find((row) => row.id === "s142")).toMatchObject({
      storageKey: "writer.service_tier",
      uiStatus: "editable",
      channel: "W-DIRECT",
    });
  });

  it("keeps all former UI-visible fields on screen", () => {
    expect(VISIBLE_CATALOG).toHaveLength(251);
    expect(VISIBLE_CATALOG.every((row) => row.uiStatus !== "excluded")).toBe(true);
    expect(UI_CATALOG.filter((row) => row.id >= "s355" && row.setting.startsWith("docs.")).every((row) => row.uiStatus === "editable" && row.channel === "OWN")).toBe(true);
    expect(UI_CATALOG.filter((row)=>["night_review.enabled","night_review.provider","night_review.model","night_review.agent"].includes(row.storageKey)&&row.id!=="s290").every((row)=>row.uiStatus==="editable"&&row.channel==="OWN")).toBe(true);
    expect(UI_CATALOG.filter((row)=>row.storageKey.startsWith("pm_read.")&&row.id>="s258").every((row)=>row.uiStatus==="editable"&&row.channel==="OWN")).toBe(true);
    expect(UI_CATALOG.filter((row)=>row.id>="s359"&&row.setting.startsWith("onboarding.")).every((row)=>row.uiStatus==="editable"&&row.channel==="OWN")).toBe(true);
  });

  it("classifies aggregate PM-read and sandbox aliases by their executable native controls", () => {
    expect(UI_CATALOG.find((row) => row.id === "s045")).toMatchObject({
      uiStatus: "readonly", channel: "NONE", evidence: "server.ts:300",
    });
    expect(UI_CATALOG.find((row) => row.id === "s045")?.rationale).toContain("individual project settings at rows 258-263");
    expect(UI_CATALOG.find((row) => row.id === "s065")).toMatchObject({
      uiStatus: "readonly", channel: "NONE", evidence: "src/verification/sandbox.ts:22",
    });
    expect(UI_CATALOG.find((row) => row.id === "s065")?.rationale).toContain("project-scoped verified sandbox.backend selector at row 365");
  });

  it("maps the formerly excluded critique-provider and browser-effort flags to their native stage controls", () => {
    expect(UI_CATALOG.find((row) => row.id === "s014")).toMatchObject({
      storageKey:"plan_critique.provider", uiStatus:"readonly", channel:"NONE", evidence:"server.ts:335",
    });
    expect(UI_CATALOG.find((row) => row.id === "s075")).toMatchObject({
      storageKey:"plan_critique.provider", uiStatus:"editable", channel:"OWN",
    });
    expect(UI_CATALOG.find((row) => row.id === "s018")).toMatchObject({
      storageKey:"browser_qa.reasoning_effort", uiStatus:"readonly", channel:"NONE", evidence:"server.ts:1869",
    });
    expect(UI_CATALOG.find((row) => row.id === "s125")).toMatchObject({
      storageKey:"browser_qa.reasoning_effort", uiStatus:"editable", channel:"OWN",
    });
  });

  it("maps upstream personal-bot memory scope to its native isolated project setting",()=>{
    expect(UI_CATALOG.find((row)=>row.id==="s113")).toMatchObject({storageKey:"memory.personal_bot",uiStatus:"editable",channel:"OWN",control:"select",options:["","claude","codex","grok","qwen","kimi","agy","cursor"]});
  });

  it("maps legacy onboarding provider/depth to the sole native preview controls",()=>{
    expect(UI_CATALOG.find((row)=>row.id==="s097")).toMatchObject({storageKey:"onboarding.provider",uiStatus:"readonly",channel:"NONE"});
    expect(UI_CATALOG.find((row)=>row.id==="s101")).toMatchObject({storageKey:"onboarding.depth",uiStatus:"readonly",channel:"NONE"});
    expect(UI_CATALOG.find((row)=>row.id==="s359")).toMatchObject({storageKey:"onboarding.provider",uiStatus:"editable",channel:"OWN"});
    expect(UI_CATALOG.find((row)=>row.id==="s364")).toMatchObject({storageKey:"onboarding.depth",uiStatus:"editable",channel:"OWN",options:["fast","deep"]});
  });

  it("excludes run-controller status JSON because it is a required machine format, not a user preference",()=>{
    expect(UI_CATALOG.find((row)=>row.id==="s304")).toMatchObject({uiStatus:"excluded",section:"excluded",evidence:"bin/run-controller:1738"});
    expect(UI_CATALOG.find((row)=>row.id==="s304")?.rationale).toContain("--json is argparse-required");
  });

  it("records evidence-based scope decisions for the remaining non-setting rows",()=>{
    expect(UI_CATALOG.find((row)=>row.id==="s044")).toMatchObject({uiStatus:"excluded",section:"excluded"});
    expect(UI_CATALOG.find((row)=>row.id==="s044")?.rationale).toContain("plugin-wide BB preference");
    expect(UI_CATALOG.find((row)=>row.id==="s071")).toMatchObject({uiStatus:"excluded",section:"excluded"});
    expect(UI_CATALOG.find((row)=>row.id==="s071")?.rationale).toContain("direct GitNexus caller impact, and TaskV2 structural checks");
    expect(UI_CATALOG.find((row)=>row.id==="s071")?.rationale).toContain("truncated partial coverage");
    expect(UI_CATALOG.find((row)=>row.id==="s126")?.rationale).toContain("no stage-specific tier argument");
    expect(UI_CATALOG.find((row)=>row.id==="s251")?.rationale).toContain("no DRY_RUN or FORCE environment contract");
    expect(UI_CATALOG.find((row)=>row.id==="s235")).toMatchObject({uiStatus:"excluded",section:"excluded"});
    expect(UI_CATALOG.find((row)=>row.id==="s235")?.rationale).toContain("Static OpenCode slash-command argument-hint metadata");
    expect(UI_CATALOG.find((row)=>row.id==="s330")).toMatchObject({uiStatus:"excluded",section:"excluded"});
    expect(UI_CATALOG.find((row)=>row.id==="s330")?.rationale).toContain("already represented by editable row s064");
  });

  it("does not embed absolute home paths in catalog strings", () => {
    const blob = JSON.stringify(UI_CATALOG);
    expect(blob).not.toMatch(/\/home\/ubuntu/);
    expect(blob).not.toMatch(/\/Users\//);
  });
});
