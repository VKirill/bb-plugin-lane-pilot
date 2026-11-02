import type { PmReplay } from "./service";

export const PM_REPLAY_USAGE = [
  "bb lane-pilot pm-replay import <file.json> [--project <id>]   seed the set (pm-live-eval scenario format)",
  "bb lane-pilot pm-replay run [--rule <id>] [--scenario <id>…]  replay the set (or one rule's incidents) on a host",
  "bb lane-pilot pm-replay decide [--rule <id>]                 apply the staged A/B decision",
  "bb lane-pilot pm-replay status                               last night: harvested, ran, adopted, cost",
  "bb lane-pilot pm-replay list [active|retired]                the scenario set",
  "bb lane-pilot pm-replay link <rule-id> <scenario-id>…        tie scenarios to the rule they prove",
  "bb lane-pilot pm-replay retire <scenario-id>",
].join("\n");

export async function runPmReplayCli(replay: PmReplay, listScenariosFn: (state?: string) => unknown[], argv: string[]): Promise<{ exitCode: number; stdout?: string; stderr?: string }> {
  const [op, ...args] = argv;
  const flag = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
  const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--project" && args[i - 1] !== "--rule" && args[i - 1] !== "--scenario");
  try {
    switch (op) {
      case "import": {
        const file = positional[0];
        if (!file) return { exitCode: 1, stderr: "pm-replay import <file.json>" };
        return { exitCode: 0, stdout: JSON.stringify(replay.importFile(file, flag("project") ?? "*"), null, 2) };
      }
      case "run": {
        const result = await replay.replay({ ruleId: flag("rule"), scenarioIds: flag("scenario") ? [flag("scenario")!] : undefined });
        return { exitCode: result.error ? 1 : 0, stdout: JSON.stringify(result, null, 2), ...(result.error ? { stderr: result.error } : {}) };
      }
      case "decide":
        return { exitCode: 0, stdout: JSON.stringify(await replay.decide({ ruleId: flag("rule") }), null, 2) };
      case "status":
        return { exitCode: 0, stdout: JSON.stringify(await replay.status(), null, 2) };
      case "list":
        return { exitCode: 0, stdout: JSON.stringify(listScenariosFn(positional[0]), null, 2) };
      case "link": {
        const [ruleId, ...ids] = positional;
        if (!ruleId || !ids.length) return { exitCode: 1, stderr: "pm-replay link <rule-id> <scenario-id>…" };
        return { exitCode: 0, stdout: JSON.stringify({ linked: replay.linkScenariosToRule(ids, ruleId) }) };
      }
      case "retire":
        return { exitCode: positional[0] && replay.retireScenario(positional[0]) ? 0 : 1, ...(positional[0] ? {} : { stderr: "pm-replay retire <scenario-id>" }) };
      default:
        return { exitCode: op ? 1 : 0, ...(op ? { stderr: `unknown operation «${op}»\n${PM_REPLAY_USAGE}` } : { stdout: PM_REPLAY_USAGE }) };
    }
  } catch (cause) {
    return { exitCode: 1, stderr: cause instanceof Error ? cause.message : String(cause) };
  }
}
