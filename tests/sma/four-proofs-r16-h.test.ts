// Region 16 (slash commands and workflows), batch h: project start, workspaces and the profile (n1349 … n1367).
// Each test checks the result its card names on the REAL code (the engine on the real graph files with the real lp.* executors against a temp git checkout, the real `profile` verb,
// the real worktree removal); the observations live in r16-world-h.ts and are the same ones the region scene proves. Agent nodes answer from a table (no model): what an agent
// WRITES into the repository is its own act, so for a model step the checked result is the run it is part of (its place in the path, what it is given, what the run returns).
import { describe, expect, it, vi } from "vitest";
import { PROFILE_KEYS } from "../../src/rooms/anamnesis";
import { observeH } from "./r16-world-h";

vi.setConfig({ testTimeout: 180_000 });
type Row = Record<string, unknown>;
const KEYS = [...PROFILE_KEYS];
const MAIN_VALUE_MAP = "Value map builder, before asking anything: from README, the passport (project-onboard), the site and the code — who the product is for, the job they hire it for, what they get, how we would know it works. Return the complete raw Markdown of VALUE-MAP.md in document; the code-owned writer persists it to .agents/planning/.";
const PIECES = [{ id: "p1", task: { owns_paths: ["src/**"] } }];

describe("region 16 batch h: project start, workspaces and the profile", () => {
  it("[sma:k_c_import] /sma-import: a plan with a conflict goes to the owner, then is cut into pieces and checked; no conflict skips the owner; an abort ends with no pieces; pieces that fail the check end invalid", async () => {
    const w = await observeH.k_c_import();
    expect(w.conflicted).toEqual({ path: "grill resolve pieces check emit", asked: 1, out: { status: "done", pieces: PIECES, conflicts: ["conflicts with locked decision D3"] } });
    expect(w.clean.path).toBe("grill resolve pieces check emit");
    expect(w.clean.skipped).toEqual(["resolve"]);
    expect(w.clean.out).toEqual({ status: "done", pieces: PIECES, conflicts: [] });
    expect(w.aborted).toEqual({ path: "grill resolve aborted", piecesAsked: 0, out: { status: "aborted", pieces: [], conflicts: ["conflicts with locked decision D3"] } });
    expect(w.invalid).toEqual({ path: "grill resolve pieces check invalid", out: { status: "invalid", pieces: [], conflicts: ["p1: owns_paths «../x» is not a path inside the checkout"] } });
    expect(w.ownsEscaping).toEqual(["p1: owns_paths «../x» is not a path inside the checkout", "p1: owns_paths «/etc/**» is not a path inside the checkout"]);
    expect(w.ownsInside).toEqual([]);
  });

  it("[sma:k_c_ingest] the repository's ADR or spec enters as the plan text of plan-import: the conflict check sees it word for word with the goal, and its conflicts come back in the result", async () => {
    const w = await observeH.k_c_ingest();
    expect(w.grillSaw).toEqual({ plan: "# ADR-7: orders move to Postgres\n\nStatus: accepted. Orders are written to Postgres; the queue stays Redis.", goal: "move orders to Postgres", depth: "standard" });
    expect(w.path).toBe("grill resolve pieces check emit");
    expect(w.out).toEqual({ status: "done", pieces: PIECES, conflicts: ["ADR-7 contradicts the locked decision D3 (the queue is Redis)"] });
  });

  it("[sma:k_c_rmws] removing a workspace takes its copy and its merged branch, leaves the other copy alone, and takes the workspace folder with the last copy", async () => {
    const w = await observeH.k_c_rmws();
    expect(w.after1).toEqual({ removed: true, folder: false, listed: false, otherKept: true, branch: "", parent: true });
    expect(w.after2).toEqual({ removed: true, folder: false, listed: false, branch: "", parent: false, main: ["a.txt", "work.txt"] });
  });

  it("[sma:k_wst_map] the value map is built before any question: the tree is counted first, the value map step is given the five counts, and the owner is asked only after it", async () => {
    const w = await observeH.k_wst_map();
    expect(w.status).toBe("succeeded");
    expect(w.order.slice(0, 3)).toEqual(["tree", "probe", "value_map"]);
    expect(w.prompt.startsWith(MAIN_VALUE_MAP)).toBe(true);
    expect(w.prompt.endsWith("Open VALUE-MAP.md with these five lines counted from the tree itself, verbatim: sources 3, tests 2, docs 2, planning artifacts 2, commits 7.")).toBe(true);
    expect(w.commits).toBe(7);
    expect(w.askPath).toBe("tree probe value_map write_value_map preview profile_write ask research write_research_stack write_research_features write_research_architecture write_research_pitfalls requirements write_requirements recap write_roadmap write_project add_phases done");
    expect(w.askOrder.indexOf("value_map")).toBeLessThan(w.askOrder.indexOf("ask"));
  });

  it("[sma:k_v_startmap] the start counts five things from the tree itself: sources, tests, docs, planning files and commits; with the switch off nothing is read", async () => {
    const w = await observeH.k_v_startmap();
    expect(w.off).toEqual({ enabled: "off", sources: 0, tests: 0, docs: 0, planning: 0, commits: 0, counts_note: "" });
    expect(w.on).toEqual({ enabled: "on", sources: 3, tests: 2, docs: 3, planning: 1, commits: w.headCommits, counts_note: `Open VALUE-MAP.md with these five lines counted from the tree itself, verbatim: sources 3, tests 2, docs 3, planning artifacts 1, commits ${w.headCommits}.` });
    expect(w.headCommits).toBe(9);
  });

  it("[sma:k_wst_quick] an existing install is asked only for what is missing: all three present resumes with no model, a missing roadmap runs only the recap side, a missing profile asks the owner", async () => {
    const w = await observeH.k_wst_quick();
    expect(w.resumed.executed).toEqual(["tree", "probe", "resumed"]);
    expect(w.resumed.modelCalls).toBe(0);
    expect(w.resumed.output).toEqual({ status: "resumed", value_map: "", next_steps: ["the project is already started — continue with project-resume"], refused: [] });
    expect(w.roadmapMissing).toEqual({ costly: ["preview", "research", "requirements", "recap"], skipped: ["value_map", "write_value_map", "ask", "write_research_stack", "write_research_features", "write_research_architecture", "write_research_pitfalls", "write_requirements"] });
    expect(w.profileMissing).toEqual({ costly: ["preview", "ask", "research", "requirements"], skipped: ["value_map", "write_value_map", "write_research_stack", "write_research_features", "write_research_architecture", "write_research_pitfalls", "write_requirements", "recap", "write_roadmap", "write_project", "add_phases"] });
    expect(w.nothing.costly).toEqual(["value_map", "preview", "ask", "research", "requirements", "recap"]);
  });

  it("[sma:k_wst_project] the recap writes the first planning files only where there is no roadmap yet: it runs on a fresh start with the PROJECT.md and roadmap instructions, and is skipped when a roadmap exists", async () => {
    const w = await observeH.k_wst_project();
    expect(w.fresh.executed).toEqual(["tree", "probe", "value_map", "write_value_map", "preview", "profile_write", "research", "requirements", "recap", "write_roadmap", "write_project", "add_phases", "done"]);
    expect(w.fresh.nextSteps).toEqual(["a", "b", "c"]);
    expect(w.fresh.prompt).toContain("the project's Vision, Value and Limits as raw Markdown in project_document");
    expect(w.fresh.prompt).toContain("the roadmap skeleton as raw Markdown in roadmap_draft");
    expect(w.withRoadmap.executed).toEqual(["tree", "probe", "resumed"]);
    expect(w.withRoadmap.nextSteps).toEqual(["the project is already started — continue with project-resume"]);
  });

  it("[sma:k_wst_stack] the stack and test command the preview answers become the project's profile, written after the preview and the value map; nothing else is stored", async () => {
    const w = await observeH.k_wst_stack();
    expect(w.status).toBe("succeeded");
    expect(w.previewBeforeWriter).toBe(true);
    expect(w.modelCalls).toEqual(["value_map", "preview", "research", "requirements", "recap"]);
    expect(w.stored).toEqual({ "profile.stack": "typescript, vitest", "profile.test_command": "npm test" });
    expect(w.refused).toEqual([]);
  });

  it("[sma:k_wst_infra] the infra profile: the keys the preview is told to return are exactly the eight the writer accepts, all eight are stored, and a ninth is refused", async () => {
    const w = await observeH.k_wst_infra();
    expect(w.accepted).toEqual(KEYS);
    expect(w.told).toEqual(w.accepted);
    expect(w.stored).toEqual({ "profile.stack": "node", "profile.test_command": "npm test", "profile.release": "tag", "profile.hosts": "ovh", "profile.start": "pm2 start", "profile.deploy": "scripts/deploy.sh", "profile.logs": "pm2 logs", "profile.style": "terse" });
    expect(w.refused).toEqual(["flavour"]);
  });

  it("[sma:k_wst_style] the working style reaches the starter notes: PROJECT.md gets a Developer preferences section with the style, CLAUDE.md points at AGENTS.md, and a person's AGENTS.md is left as it is", async () => {
    const w = await observeH.k_wst_style();
    expect(w.done).toEqual({ refused: [], set: ["stack", "test_command", "style"], reasons: [] });
    expect(w.projectMd).toContain("## Developer preferences");
    expect(w.projectMd).toContain("- Language: typescript\n- Test command: npm test\n- Style: small functions, no comments\n");
    expect(w.agentsMd).toBe("# mine\nwritten by a person\n");
    expect(w.claudeMd).toBe("@AGENTS.md\n");
    expect(w.copilot).toContain(".agents/planning/PROJECT.md");
  });

  it("[sma:k_wst_close] the start ends with the recap's next steps and the value map in its result; the recap is given the recap instructions and not the profile ones", async () => {
    const w = await observeH.k_wst_close();
    expect(w.output).toEqual({ status: "done", value_map: "for shop owners", next_steps: ["a", "b", "c"], refused: [] });
    expect(w.order.slice(-2)).toEqual(["add_phases", "done"]);
    expect(w.recapNote.length).toBeGreaterThan(100);
    expect(w.prompt.endsWith(w.recapNote)).toBe(true);
    expect(w.prompt).not.toContain(w.profileNote);
  });

  it("[sma:k_lib_startmap] the value map is built first and only once: a fresh start asks the builder with the counts and returns its map, an existing VALUE-MAP.md skips it", async () => {
    const w = await observeH.k_lib_startmap();
    expect(w.fresh.executed).toContain("value_map");
    expect(w.fresh.valueMap).toBe("for shop owners");
    expect(w.fresh.prompt.startsWith(MAIN_VALUE_MAP)).toBe(true);
    expect(w.fresh.prompt.endsWith("verbatim: sources 1, tests 0, docs 1, planning artifacts 1, commits 2.")).toBe(true);
    expect(w.had.skipped).toEqual(expect.arrayContaining(["value_map"]));
    expect(w.had.valueMap).toBe("");
    expect(w.valueMapCalls).toBe(1);
  });

  it("[sma:k_v_profile] bb lane-pilot profile reads the eight keys, sets with = kept inside the value, refuses a secret or an unknown key with its reason and writes nothing, refuses a writer thread, and an empty value resets", async () => {
    const w = await observeH.k_v_profile();
    expect(w.emptyKeys).toEqual(KEYS.map((key) => `profile.${key}`));
    expect(w.emptyValues).toEqual([""]);
    expect(w.set).toBe(0);
    expect(w.read).toEqual({ "profile.stack": "typescript", "profile.test_command": "npm test -- --grep=a=b", "profile.release": "", "profile.hosts": "", "profile.start": "", "profile.deploy": "", "profile.logs": "", "profile.style": "" });
    expect(w.secret).toEqual({ exitCode: 1, text: "refused release: the value looks like a secret" });
    expect(w.unknown.exitCode).toBe(1);
    expect(w.unknown.text).toBe(`refused flavour: unknown profile key «flavour»; the keys are: ${KEYS.join(", ")}`);
    expect(w.afterRefusals).toEqual({ "profile.stack": "typescript", "profile.test_command": "npm test -- --grep=a=b" });
    expect(w.fromWriter).toEqual({ exitCode: 1, text: "refused: the profile is set by the PM chat or the owner, not by a writer thread" });
    expect(w.resetExit).toBe(0);
    expect(w.afterReset).toEqual({ "profile.test_command": "npm test -- --grep=a=b" });
    expect(w.noProject.exitCode).toBe(1);
    expect(w.noProject.text).toContain("usage: bb lane-pilot profile <project-id>");
  });

  it("[sma:k_lib_profile] the profile is read through the one settings reader: a project's own value beats the hub-wide one, the hub-wide value fills what the project did not set, and another project does not see it", async () => {
    const w = await observeH.k_lib_profile();
    expect(w.loaded).toEqual({ "profile.hosts": "project-host", "profile.style": "terse", "profile.stack": "typescript" });
    expect(w.viaVerb).toEqual({ "profile.stack": "typescript", "profile.test_command": "", "profile.release": "", "profile.hosts": "project-host", "profile.start": "", "profile.deploy": "", "profile.logs": "", "profile.style": "terse" });
    expect([w.otherStack, w.otherStyle, w.otherHosts]).toEqual(["php", "terse", "global-host"]);
  });

  it("[sma:k_lib_profilewriter] the profile writer keeps the good pairs under profile.<key>, refuses a secret value and a key that is not one of the eight by key name with its reason, and no secret reaches a row, a result or a file", async () => {
    const w = await observeH.k_lib_profilewriter();
    expect(w.written.set).toEqual(["stack", "test_command", "deploy"]);
    expect(w.written.refused).toEqual(["db_password", "release", "flavour"]);
    expect(w.written.reasons as string[]).toEqual([`db_password: unknown profile key «db_password»; the keys are: ${KEYS.join(", ")}`, "release: the value looks like a secret", `flavour: unknown profile key «flavour»; the keys are: ${KEYS.join(", ")}`]);
    expect(w.stored).toEqual({ "profile.stack": "typescript", "profile.test_command": "npm test", "profile.deploy": "manual" });
    expect(`${w.secretsInRows}${w.secretsInFiles}`).not.toMatch(/hunter2|sk-a/);
    expect(w.none as Row).toMatchObject({ refused: ["token"], set: [] });
  });
});
