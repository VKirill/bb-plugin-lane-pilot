import { taskFamily } from "../runs";
import { isMainfixTask } from "./validate-output";

/**
 * Run-level loop stopper (Matvey Maslov's rule: three tries, then a change of perspective and one analysis, not a fourth try).
 * The limits on one task family (`x`, `x.2`, `x-mainfix`) cannot see the PM sending the same work under different ids. Vampirism
 * Fire, 74 hours: nine tasks patched one Studio test runner (`studio_test.py`: vf-runner-dedupe, -one-window, -pool, -retry,
 * -game-errors, -open-throttle, -one-slot, -mcp-drop, -no-blind-open) and one flaky test (Par030) went through eight more.
 *
 * A topic comes from code facts only, never from words:
 *  - file: one specific file that small fix-like tasks of the run keep re-owning;
 *  - test: one test (a `--filter X`, a `for m in A B`, a test file) that failed the checks of other task families again and again.
 * Pure: the caller reads the run's tasks and attempts from the database (writer/server/topic-loop.ts).
 */

export interface LoopTask {
  id: string;
  createdAt: number;
  kind?: string;
  area?: string;
  title: string;
  /** The contract's objective: a new try on a closed topic names its incident and hypothesis there. */
  objective?: string;
  /** owns_paths and expected_outputs. */
  files: string[];
  /** The commands of the task's verification. */
  commands: string[];
  /** What the task says (title, objective, files, commands): a research task counts as looking at a topic when this names it. */
  text: string;
  attempts: Array<{ state: string; reason: string | null }>;
}

export const TOPIC_LOOP = {
  /** Earlier families on one topic that make the next task the fourth try. */
  families: 3,
  /** Only families active within this long before the new task count: an old patch is history, not a chase. */
  windowMs: 72 * 3_600_000,
  /** A task is «about» a file only when it owns at most this many entries besides docs: a wide task targets no file in particular. */
  focusEntries: 3,
  /** A file that this share of the run's families own is the run's shared ground (a registry, a barrel), not a topic. */
  sharedShare: 0.25,
  /** The share rule needs a run this long to mean anything. */
  sharedMinFamilies: 12,
} as const;

export interface TopicLoop {
  topic: "file" | "test";
  key: string;
  /** The earlier families on the topic, oldest first. */
  families: string[];
  /** Hours from the first of those families to the new task. */
  hours: number;
  /** A research or check task on the topic that is queued or running: the answer is to wait for it. */
  openAnalysis?: string;
}

const OPEN_STATES = new Set(["queued", "spawn_requested", "spawn_unknown", "running", "cancel_requested"]);
const ANALYSIS_KINDS = new Set(["research", "check"]);
const FIX_WORDS = /\b(fix|fixes|fixed|hotfix|regress\w*|repair\w*|flak\w*|unflak\w*|stabili[sz]\w*|retry|workaround)\b/i;
/** Docs, manifests and lock files are touched by every kind of task; sharing them says nothing about a chase. */
const COMPANION_FILE = /(\.(md|mdx|txt|rst|lock|log)|(^|\/)(package(-lock)?\.json|\.gitignore|CHANGELOG[^/]*))$/i;
const GLOB = /[*?[]/;

const lower = (text: string) => text.toLowerCase();
const isFixLike = (task: Pick<LoopTask, "kind" | "title" | "area">) =>
  task.kind === "fix" || task.kind === "check" || FIX_WORDS.test(`${task.title} ${task.area ?? ""}`);
const isDirectory = (path: string) => path.endsWith("/") || GLOB.test(path) || !/\.[A-Za-z0-9]+$/.test(path.split("/").pop() ?? "");

/** The tests a command or a failing reason names: `--filter X`, `-t 'x'`, `for m in A B; do`, and test files. Lower case, no duplicates. */
export function testNames(text: string): string[] {
  const names = new Set<string>();
  const add = (raw: string | undefined) => {
    const name = (raw ?? "").replace(/^["'`]+|["'`),;&|]+$/g, "");
    if (name.length >= 3 && !name.includes("$") && !/^-/.test(name)) names.add(lower(name));
  };
  for (const found of text.matchAll(/--(?:filter|grep|testNamePattern)(?:=|\s+)("[^"]+"|'[^']+'|[^\s"';&|)]+)/g)) add(found[1]);
  for (const found of text.matchAll(/(?:^|\s)-[tk]\s+("[^"]+"|'[^']+')/g)) add(found[1]);
  for (const found of text.matchAll(/\bfor\s+\w+\s+in\s+([^;]+);/g)) for (const token of found[1]!.split(/\s+/)) add(token);
  for (const found of text.matchAll(/[\w./-]+(?:\.(?:test|spec)\.[cm]?[jt]sx?|\/test_\w+\.py)\b/g)) add(found[0]);
  return [...names];
}

interface Family {
  id: string;
  firstAt: number;
  lastAt: number;
  members: LoopTask[];
  /** The newest member: its contract is the family's final ask. */
  latest: LoopTask;
  /** Some attempt ran (a family every attempt of which was cancelled was never tried). */
  tried: boolean;
}

function familiesOf(tasks: readonly LoopTask[]): Family[] {
  const byId = new Map<string, Family>();
  for (const task of [...tasks].sort((a, b) => a.createdAt - b.createdAt)) {
    const id = taskFamily(task.id);
    const family = byId.get(id) ?? { id, firstAt: task.createdAt, lastAt: task.createdAt, members: [], latest: task, tried: false };
    family.members.push(task);
    family.lastAt = task.createdAt;
    family.latest = task;
    if (task.attempts.some((attempt) => attempt.state !== "canceled")) family.tried = true;
    byId.set(id, family);
  }
  return [...byId.values()];
}

/** The entries a task is about: specific code files, unless the task is wide (then none). */
function focusFiles(task: LoopTask, ignored: ReadonlySet<string>): string[] {
  const entries = [...new Set(task.files)].filter((path) => !COMPANION_FILE.test(path));
  if (entries.length === 0 || entries.length > TOPIC_LOOP.focusEntries) return [];
  return entries.filter((path) => !isDirectory(path) && !ignored.has(path));
}

const RED = new Set(["validation_failed", "blocked", "empty_output"]);
/** The tests a family could not get green: named in the reason of a red check, or in the checks of a family that ended an attempt red. */
const failedNames = (family: Family) => new Set(family.members.flatMap((task) => [
  ...task.attempts.filter((attempt) => attempt.reason && /verification failed|checks red/.test(attempt.reason)).flatMap((attempt) => testNames(attempt.reason!)),
  ...(task.attempts.some((attempt) => RED.has(attempt.state)) ? task.commands.flatMap(testNames) : []),
]));

/**
 * Whether the task about to be dispatched is the fourth try on a topic of this run: `earlier` are the run's tasks so far (any
 * order, every member of every family). null for a task that may go: a research or check task, a mainfix, a redo of a family the
 * run already has, or a topic fewer than three other families worked on in the last 72 hours, or one a research/check task
 * on the topic has been accepted for since.
 */
export function topicLoop(candidate: LoopTask, earlier: readonly LoopTask[]): TopicLoop | null {
  if (ANALYSIS_KINDS.has(candidate.kind ?? "") || isMainfixTask(candidate.id)) return null;
  const own = taskFamily(candidate.id);
  if (earlier.some((task) => taskFamily(task.id) === own)) return null;
  const all = familiesOf(earlier.filter((task) => !isMainfixTask(task.id)));
  const recent = all.filter((family) => family.tried && family.lastAt >= candidate.createdAt - TOPIC_LOOP.windowMs && !ANALYSIS_KINDS.has(family.latest.kind ?? ""));
  const shared = new Set<string>();
  if (all.length >= TOPIC_LOOP.sharedMinFamilies) {
    const owners = new Map<string, number>();
    for (const family of all) for (const path of new Set(family.latest.files)) owners.set(path, (owners.get(path) ?? 0) + 1);
    for (const [path, count] of owners) if (count / all.length >= TOPIC_LOOP.sharedShare) shared.add(path);
  }

  // The newest research or check task on the topic that is accepted ends the chase before it; one still open holds the topic.
  const analysis = (key: string) => {
    const covering = earlier.filter((task) => ANALYSIS_KINDS.has(task.kind ?? "") && lower(task.kind === "check" ? task.title : task.text).includes(lower(key)));
    const open = covering.find((task) => task.attempts.some((attempt) => OPEN_STATES.has(attempt.state)));
    const accepted = covering.filter((task) => task.attempts.some((attempt) => attempt.state === "accepted"));
    return { open: open?.id, since: accepted.length ? Math.max(...accepted.map((task) => task.createdAt)) : 0 };
  };
  const hit = (topic: "file" | "test", key: string, members: Family[]): TopicLoop | null => {
    const { open, since } = analysis(key.split("/").pop()!);
    const counted = members.filter((family) => family.firstAt > since);
    if (counted.length < TOPIC_LOOP.families) return null;
    return { topic, key, families: counted.map((family) => family.id), hours: Math.round((candidate.createdAt - counted[0]!.firstAt) / 360_000) / 10, ...(open ? { openAnalysis: open } : {}) };
  };

  const found: TopicLoop[] = [];
  // File: small fix-like tasks that re-own the same specific file.
  if (isFixLike(candidate)) {
    for (const path of focusFiles(candidate, shared)) {
      const loop = hit("file", path, recent.filter((family) => isFixLike(family.latest) && focusFiles(family.latest, shared).includes(path)));
      if (loop) found.push(loop);
    }
  }
  // Test: the candidate's checks name a test that already failed the checks of three other families.
  const wanted = new Set(candidate.commands.flatMap(testNames));
  if (wanted.size) {
    const failed = recent.map((family) => ({ family, names: failedNames(family) }));
    for (const name of wanted) {
      const loop = hit("test", name, failed.filter((row) => row.names.has(name)).map((row) => row.family));
      if (loop) found.push(loop);
    }
  }
  // The topic with the most earlier tries is the one the PM is told about.
  return found.reduce<TopicLoop | null>((best, loop) => (!best || loop.families.length > best.families.length ? loop : best), null);
}

/** What a new try on a closed topic must carry, in the words the PM reads in the refusal. */
const newTryRule = (incident: string) => `A single new try is allowed only as an explicit decision tied to the incident ${incident}: its objective carries a line \`incident: ${incident}\`, a line \`hypothesis: ...\` with a cause no earlier task on the topic assumed, and its verification holds a command no earlier task on the topic used.`;

/**
 * The refusal the PM reads: the topic, who already tried, and what the machine does about it. The machine ends the loop itself (the wall's
 * hunters and a backlog item, see src/rooms/wall `loopExhausted`); `hunt` is its wall key. Without it (no wall) the old way stands: one research task.
 */
export function topicLoopMessage(found: TopicLoop, hunt?: string): string {
  const what = found.topic === "file" ? `the file ${found.key}` : `the test ${found.key}`;
  const tried = `${found.families.length} earlier tasks of this run (${found.families.slice(-5).join(", ")}${found.families.length > 5 ? ", ..." : ""}) already worked on ${what} in the last ${found.hours} h, and it is still being patched, not solved`;
  if (hunt && !found.openAnalysis) return `topic_loop: ${tried}. A fourth try is not sent. Lane Pilot took the big picture itself: three read-only hunters read ${what} from other sides (hunt ${hunt}), and their analysis with the proposed next step lands in the backlog (bb lane-pilot wall show ${hunt}). The topic stays closed however the hunt ends: no task on ${what} goes out, under any id, as a mainfix or from a workflow, until the backlog item is closed by an accepted fix. ${newTryRule(hunt)} You need not send a research task and nothing waits for the owner.`;
  if (found.openAnalysis) return `topic_loop: ${tried}. The analysis task ${found.openAnalysis} is still open: wait for its receipt (lane_pilot_wait_writer); tasks on ${what} go out again once it is accepted, and they follow its finding.`;
  return `topic_loop: ${tried}. A fourth try is not sent. Step back: dispatch ONE research task (kind research, or check) that looks at the whole picture, i.e. what each of those tasks changed, why it did not hold, and the root cause, and writes the finding to a file; name ${found.key} in it. Once it is accepted, tasks on ${what} go out again and follow its finding. This needs no owner: it is the next move for you.`;
}

/** A loop wall of a topic of the run, as the stopper reads it (the wall's `loopTopics`). */
export interface TopicWall {
  /** The incident id: the wall key `loop:topic:<hash>`. */
  key: string;
  /** The file or test the wall is about. */
  topic: string;
  state: "stopped" | "hunting" | "hunted" | "backlog" | "closed";
  /** How the hunt ended: `usable`, `unknown`, or `none` when no hunt ran (the day's hunt budget was spent). */
  hunt: string;
}

/** Whether a task is work on the topic: a fix-like task about the file, or a task whose checks name the test. Research and check tasks look at a topic, they do not patch it. */
function touchesTopic(task: LoopTask, key: string): boolean {
  if (ANALYSIS_KINDS.has(task.kind ?? "")) return false;
  return (isFixLike(task) && focusFiles(task, new Set()).includes(key)) || task.commands.flatMap(testNames).includes(key);
}

const INCIDENT_LINE = /^\s*incident:\s*(\S+)/im;
const HYPOTHESIS_LINE = /^\s*hypothesis:\s*(\S.*)$/im;
const words = (text: string) => new Set(lower(text).split(/[^\p{L}\p{N}_.\/-]+/u).filter((word) => word.length >= 3));
const sameWords = (a: string, b: string) => {
  const left = words(a), right = words(b);
  const shared = [...left].filter((word) => right.has(word)).length;
  return shared / Math.max(1, left.size + right.size - shared) >= 0.8;
};
const flat = (text: string) => text.replace(/\s+/g, " ").trim();

export interface TopicHold {
  wall: TopicWall;
  /** The task is the one new try the topic allows (or the redo or mainfix of that try): it goes on. */
  allowed: boolean;
  /** Why not (what the PM reads); empty when allowed. */
  why: string;
}

/**
 * The topic stays closed from the first refusal on: a task on the topic of a wall that is not closed is refused whatever its id, family or
 * origin (a redo, a mainfix, a workflow's task), and the hunt ending in the backlog does not reopen it. Only an accepted fix closes the
 * wall (the wall's `advance`). The one way through is a single new try, a machine decision tied to the incident: the objective names the
 * wall's key, states a hypothesis that differs from the earlier tasks' and carries a check none of them used. A hunt that ended unknown,
 * or never ran (the budget of the day), gives no permission. The try is one for the incident: a task that cites it ends the permission, and
 * only its own family (a redo, its mainfix) goes on. null for a task not on the topic of any open wall.
 */
export function topicHold(candidate: LoopTask, walls: readonly TopicWall[], earlier: readonly LoopTask[]): TopicHold | null {
  const wall = walls.find((row) => row.state !== "closed" && touchesTopic(candidate, row.topic));
  if (!wall) return null;
  const what = `${wall.topic} (incident ${wall.key})`;
  const refuse = (why: string): TopicHold => ({ wall, allowed: false, why });
  if (wall.state === "stopped" || wall.state === "hunting") return refuse(`topic_loop: ${what} is being read by the hunters, and the topic is closed to new tasks: no task on it goes out, under any id, as a mainfix or from a workflow, while the hunt runs or after it (the backlog item holds the topic until an accepted fix closes it). Work on something else. ${newTryRule(wall.key)}`);
  const citing = earlier.filter((task) => INCIDENT_LINE.exec(task.objective ?? "")?.[1] === wall.key);
  if (citing.some((task) => taskFamily(task.id) === taskFamily(candidate.id))) return { wall, allowed: true, why: "" };
  const closed = `topic_loop: ${what} is in the backlog and closed to new tasks: no task on it goes out, under any id, as a mainfix or from a workflow, until an accepted fix closes the backlog item (bb lane-pilot wall show ${wall.key}).`;
  if (wall.state !== "backlog" || wall.hunt !== "usable") return refuse(`${closed} No new try is allowed on it: ${wall.hunt === "usable" ? "the item is not in the backlog yet" : wall.hunt === "unknown" ? "every hunter ended unknown or without a citation that holds" : "no hunt ran (the hunt budget of the day was spent)"}, so there is nothing to base a changed approach on. Work on something else.`);
  if (citing.length) return refuse(`${closed} Its one new try was already made (${citing.map((task) => task.id).join(", ")}) and it did not close the item, so no further try on this incident goes out, whatever its hypothesis.`);
  const incident = INCIDENT_LINE.exec(candidate.objective ?? "")?.[1];
  if (incident !== wall.key) return refuse(`${closed} ${newTryRule(wall.key)}${incident ? ` The incident line says ${incident}, not ${wall.key}.` : " This task cites no incident."}`);
  const hypothesis = flat(HYPOTHESIS_LINE.exec(candidate.objective ?? "")?.[1] ?? "");
  if (hypothesis.split(" ").length < 4) return refuse(`${closed} The task cites the incident but states no hypothesis: add a line \`hypothesis: ...\` of the cause this try assumes (four words at least).`);
  const onTopic = earlier.filter((task) => touchesTopic(task, wall.topic));
  const seen = onTopic.flatMap((task) => [task.title, HYPOTHESIS_LINE.exec(task.objective ?? "")?.[1] ?? ""]).filter(Boolean);
  const repeated = seen.find((text) => sameWords(hypothesis, text));
  if (repeated) return refuse(`${closed} The hypothesis repeats an earlier one on this topic («${flat(repeated).slice(0, 120)}»): state a different cause.`);
  const used = new Set(onTopic.flatMap((task) => task.commands.map(flat)));
  if (!candidate.commands.some((command) => !used.has(flat(command)))) return refuse(`${closed} Every check of this task was already used by an earlier task on the topic: add a verification command that tells the new hypothesis from the old ones.`);
  return { wall, allowed: true, why: "" };
}
