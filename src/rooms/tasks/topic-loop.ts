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

/** The refusal the PM reads: the topic, who already tried, and the one move that is allowed. */
export function topicLoopMessage(found: TopicLoop): string {
  const what = found.topic === "file" ? `the file ${found.key}` : `the test ${found.key}`;
  const tried = `${found.families.length} earlier tasks of this run (${found.families.slice(-5).join(", ")}${found.families.length > 5 ? ", ..." : ""}) already worked on ${what} in the last ${found.hours} h, and it is still being patched, not solved`;
  if (found.openAnalysis) return `topic_loop: ${tried}. The analysis task ${found.openAnalysis} is still open: wait for its receipt (lane_pilot_wait_writer); tasks on ${what} go out again once it is accepted, and they follow its finding.`;
  return `topic_loop: ${tried}. A fourth try is not sent. Step back: dispatch ONE research task (kind research, or check) that looks at the whole picture, i.e. what each of those tasks changed, why it did not hold, and the root cause, and writes the finding to a file; name ${found.key} in it. Once it is accepted, tasks on ${what} go out again and follow its finding. This needs no owner: it is the next move for you.`;
}
