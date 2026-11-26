import { dirnamePath, resolvePath } from "./path-utils";
import { parseReadFirstHints } from "./read-first";
import {
  CHECK_HISTORY_MIN_RUNS,
  DEFAULT_CHECK_TIMEOUT_SEC,
  NO_RED_KINDS,
  SANDBOX_OWN_ENV,
  acceptanceCommandFindings,
  birthFindings,
  birthGates,
  blockingClass,
  browserQaRequired,
  checkNamedPaths,
  checkProgram,
  concreteFile,
  dependsLoopFindings,
  emptyCheckReason,
  existenceOnlyPaths,
  fileAllowedByOwns,
  fileBlockedByNeverTouch,
  findSandboxUnsafeMissingExcludes,
  folderFilters,
  gluedCheckCommand,
  isMainfixTask,
  isOutputPath,
  mapVerificationCwd,
  maskedExitReason,
  matchOwnsPath,
  namedTestCandidates,
  nearSecretName,
  needsCommitReason,
  ownerWordFindings,
  ownsPathsOverlap,
  p95,
  passWithNoTestsReason,
  readFirstFindings,
  repeatedRunner,
  runsGateCommand,
  runsWholeSuite,
  safeRelative,
  siblingTestCandidates,
  subjectiveWordIn,
  taskCreatesFile,
  taskStandardFindings,
  unownedExpectedOutputs,
  validateOwnershipContract,
  type LintFinding,
  type LintInput,
} from "./contract-lint-checks";

export {
  DISPLAY_TITLE_MAX,
  checkNamedPaths,
  emptyCheckReason,
  existenceOnlyPaths,
  lintProbePaths,
  namedTestCandidates,
  nearSecretName,
  repeatedRunner,
  runnerFilterArgs,
  runsGateCommand,
  siblingTestCandidates,
  siblingTestFolders,
  subjectiveWordIn,
  taskStandardFindings,
  type LintFinding,
  type LintInput,
  type LintOpenTask,
  type PathKind,
} from "./contract-lint-checks";

/** Everything a task contract gets wrong before any helper or writer runs; errors send the task back to the PM, warnings go along with the answer. */
export function lintContract(input:LintInput):{ errors:LintFinding[]; warnings:LintFinding[] } {
  const { task, kinds } = input;
  const errors:LintFinding[] = [], warnings:LintFinding[] = [];
  const kindOf = (path:string) => kinds?.get(path);

  errors.push(...taskStandardFindings(task));
  // Owner 2026-10-31: Lane Pilot as it is now counts from stats.epoch (default 2026-10-31), so this is only a warning in the
  // receipt and the PM answer — no refusal, no redo. Revisit once ~20 tasks with 4+ items land after the epoch: if plan-fact
  // still fails about twice as often above 3, the refusal comes back. Full mode may keep a longer list; a mainfix lists every red check.
  const acceptanceMode = input.qualityMode ?? task.quality_mode;
  if (!isMainfixTask(task.id) && (acceptanceMode === "quick" || acceptanceMode === "standard") && task.acceptance.length > 3) {
    warnings.push({ code:"acceptance_too_many", message:`acceptance has ${task.acceptance.length} items; a ${acceptanceMode} task keeps at most 3 (plan-fact receipts since 2026-10-29 failed 28.9-32.7% at 4+ vs 15.8% at 3). Split the task or compress acceptance to 3 items` });
  }
  // Prompt audit 2026-11-02 (this thread + thr_j329nem3ba): the PM wrote acceptance as a design spec («left: the example
  // frame…, right: one sticky panel…») and the plan said the same thing again — two sources of truth, up to 3,000 of the
  // contract's characters. Over the week before: 996 items, average 178 characters, 57 over 400, 9 over 600. An item is one
  // claim a judge can check; the look of the thing lives in the plan, once. A warning in the dispatch answer, never a refusal.
  task.acceptance.forEach((item, index) => {
    if (item.length > 400) warnings.push({ code:"acceptance_spec_text", message:`acceptance[${index}] is ${item.length} characters: that reads as design text, not a check. Keep the one claim a judge can verify (a string on the page, a number, a command's result; about 400 characters at most) and move the layout and the details into the plan, which the writer reads anyway` });
  });
  errors.push(...acceptanceCommandFindings(task));
  // quality_mode full: a task with qa_cases owes a browser check, and the task's own graph runs it from qa_url.
  if (input.qualityMode && browserQaRequired(input.qualityMode, task) && !task.qa_url) {
    errors.push({ code:"qa_url_missing", message:`quality_mode is full and the task has qa_cases, so its graph runs the browser check itself and needs the page to open: add qa_url (the address the cases run on, e.g. "http://127.0.0.1:5173/orders"), plus qa_env_class (local, staging, preview, production or unknown) and qa_dev_server (the command that starts the dev server, when it is not running); or drop qa_cases` });
  }
  // The task-birth rails (src/rooms/tasks/models/rails.ts): open clarification, the promise in Given/When/Then words, the drawing a screen task follows.
  const birth = birthFindings(task, input.birth, input.redoneBirth);
  errors.push(...birth.errors, ...ownerWordFindings(task, input.ownerWords === true));
  warnings.push(...birth.warnings);
  // Service drawing kinship (SMA ap_design_kin): a task only follows a drawing confirmed for its own run, whose files still
  // match the recorded hash. A phase's piece passes by construction — it is issued with the phase's own drawing.
  if (birthGates(input.birth, input.redoneBirth).drawing && task.drawing?.length) {
    const confirmed = input.confirmedDrawings ?? [];
    const kin = confirmed.find((drawing) => task.drawing!.every((path) => drawing.paths.includes(path)));
    if (kin?.changed) errors.push({ code:"drawing_kin", message:`the drawing ${task.drawing.join(", ")} changed after the phase's design stage confirmed it: confirm the new drawing in the phase (lane_pilot_phase), then send the task` });
    else if (!kin && confirmed.length) errors.push({ code:"drawing_kin", message:`the drawing ${task.drawing.join(", ")} is not the drawing this run's phase confirmed (${confirmed.map((drawing) => drawing.paths.join(", ")).join(" | ").slice(0, 300)}): follow the confirmed one` });
    // No phase drew for this run: the task follows its own mock-up, which no design stage reviewed. Said, not refused.
    else if (!kin) warnings.push({ code:"drawing_unconfirmed", message:`the drawing ${task.drawing.join(", ")} was not confirmed by a phase's design stage: nobody but its author reviewed it` });
  }
  for (const [index, check] of task.verification.entries()) {
    const program = checkProgram(check.command);
    if (program && !program.includes("/") && input.programs?.get(program) === false) {
      errors.push({ code:"check_not_runnable", message:`verification[${index}] starts ${program}, which the writer's machine (${input.hostId}) does not find on PATH, among the user's tool bins or in node_modules/.bin; install it there or use a command that exists` });
    }
  }

  errors.push(...readFirstFindings(input));

  // owns_paths and never_touch stay inside the project root, and a path is not both owned and forbidden.
  const unsafe = [["owns_paths", task.owns_paths], ["never_touch", task.never_touch]] as const;
  for (const [field, patterns] of unsafe) for (const pattern of patterns) {
    if (!safeRelative(pattern)) errors.push({ code:"ownership_unsafe", message:`unsafe ownership path pattern: ${pattern} in ${field}; use a path relative to the project root, without "..", a leading "/" or backslashes` });
  }
  // A check runs in a folder of the project: an absolute cwd under project_cwd, or a relative one. Anything else has no copy in the attempt's worktree.
  for (const [index, check] of task.verification.entries()) {
    if (mapVerificationCwd(check.cwd, task.project_cwd, task.project_cwd) === null) {
      errors.push({ code:"verification_cwd", message:`verification[${index}] cwd ${check.cwd} is outside the project ${task.project_cwd}, so the check cannot run in the attempt's worktree; use ${task.project_cwd} or a folder under it (for example ${task.project_cwd}/apps/web, or the relative path apps/web)` });
    }
  }
  if (!errors.some((error) => error.code === "ownership_unsafe" || error.code === "verification_cwd")) {
    const rest = validateOwnershipContract(task);
    if (rest) errors.push({ code:"ownership_contract", message:rest });
  }
  for (const pattern of task.owns_paths) {
    if (/[*?[]/.test(pattern)) continue;
    const barred = task.never_touch.find((never) => matchOwnsPath(pattern, never));
    if (barred) errors.push({ code:"owns_never_touch", message:`owns_paths ${pattern} lies inside never_touch ${barred}, so the writer may not change it; remove one of the two` });
  }
  // A concrete file that is not on the base and that the task does not create is a wrong path: the writer cannot edit it and will not produce it.
  // read_first already reports its own missing files. A folder or a glob is where new files go, so it is not a missing file.
  if (kinds) {
    let readFirst = new Set<string>();
    try { readFirst = new Set(parseReadFirstHints(task.read_first).map((hint) => hint.path)); } catch { /* reported above */ }
    // A missing file in an existing folder reads as a create the author did not mark (owner 2026-10-30): a warning, never a
    // refusal. The refusal holds only when the folder itself is not there — the path is a typo, not a create.
    for (const pattern of task.owns_paths) {
      const path = concreteFile(pattern);
      if (!path || readFirst.has(path) || taskCreatesFile(task, path) || kindOf(resolvePath(input.workspacePath, path)) !== "missing") continue;
      const dirKind = dirnamePath(path) === "." ? "directory" : kindOf(resolvePath(input.workspacePath, dirnamePath(path)));
      if (dirKind === "missing") {
        errors.push({ code:"owns_missing", message:`owns_paths ${path} does not exist and neither does its folder ${dirnamePath(path)}: the path is a wrong name, not a file the task will create; fix the path` });
        if (errors.filter((error) => error.code === "owns_missing").length >= 5) break;
      } else {
        warnings.push({ code:"owns_unmarked_create", message:`owns_paths ${path} does not exist but its folder does; the lint reads it as a file the task creates — declare it in expected_outputs or a files[] create if so` });
        if (warnings.filter((warning) => warning.code === "owns_unmarked_create").length >= 5) break;
      }
    }
    for (const file of task.files ?? []) {
      if (file.action === "create") continue;
      const path = concreteFile(file.path);
      if (!path || taskCreatesFile(task, path) || kindOf(resolvePath(input.workspacePath, path)) !== "missing") continue;
      const dirKind = dirnamePath(path) === "." ? "directory" : kindOf(resolvePath(input.workspacePath, dirnamePath(path)));
      if (dirKind === "missing") {
        errors.push({ code:"output_missing", message:`files[] ${file.action} ${path} does not exist and neither does its folder ${dirnamePath(path)}: fix the path, or set action create and add the file to expected_outputs if the task creates it` });
        if (errors.filter((error) => error.code === "output_missing").length >= 5) break;
      } else {
        warnings.push({ code:"output_unmarked_create", message:`files[] ${file.action} ${path} does not exist but its folder does; the lint reads it as a create — set action create and add it to expected_outputs if so` });
        if (warnings.filter((warning) => warning.code === "output_unmarked_create").length >= 5) break;
      }
    }
  }

  // expected_outputs inside owns_paths and outside never_touch.
  for (const entry of unownedExpectedOutputs(task).slice(0, 5)) {
    errors.push({ code:"output_unowned", message:`expected_outputs ${entry} is outside owns_paths, so the writer may not create it and no attempt can pass; add it (or its folder) to owns_paths, or drop it from expected_outputs` });
  }
  for (const entry of task.expected_outputs.filter((item) => item.includes("/") && isOutputPath(item) && fileBlockedByNeverTouch(item.replace(/^\.\//, ""), task.never_touch)).slice(0, 5)) {
    errors.push({ code:"output_never_touch", message:`expected_outputs ${entry} is inside never_touch, so the writer may not create it; drop it from expected_outputs or narrow never_touch` });
  }

  // convergence.criteria must be decidable by a command, a grep or a file read: no subjective words.
  for (const [index, criterion] of (task.convergence?.criteria ?? []).entries()) {
    const word = subjectiveWordIn(criterion);
    if (word) errors.push({ code:"criteria_subjective", message:`convergence.criteria[${index}] rests on the subjective words «${word}», which no command can decide; name the exact string, value or exit code a command, a grep or a file read checks («src/a.ts contains 'LIMIT = 10'», «the command exits 0»)` });
  }
  // files[] is a hint for the writer: the files it names are the task's own.
  for (const [index, file] of (task.files ?? []).entries()) {
    const path = file.path.replace(/^\.\//, "");
    if (!safeRelative(path)) errors.push({ code:"files_unsafe", message:`files[${index}] path ${file.path} must be relative to the project root, without "..", a leading "/" or backslashes` });
    else if (!fileAllowedByOwns(path, task.owns_paths)) errors.push({ code:"files_unowned", message:`files[${index}] ${path} is outside owns_paths, so the writer may not change it; add it (or its folder) to owns_paths, or drop it from files` });
    else if (fileBlockedByNeverTouch(path, task.never_touch)) errors.push({ code:"files_never_touch", message:`files[${index}] ${path} is inside never_touch, so the writer may not change it; drop it from files or narrow never_touch` });
  }

  // An owned code file's own test is the task's too: the writer updates it with the code, and an edit outside owns_paths
  // rejects the attempt (SelfyStudio cards-postpay-bind-v2, greeting-card-pages-en, en-hreflang-sitemap-fix, 2026-10-11…12:
  // each owned «x.ts» or «useGreetingCard*», not «__tests__/x.test.ts», and lost an attempt to it). never_touch says «leave it».
  // A test named longer than the code («api/shoot.ts» → «api/__tests__/shoot-seo-audit.test.ts») comes from the folder listings: SelfyStudio
  // site-en-shoot, site-seo-polish, site-vitest-alias-fix and site-en-hydration-fix (2026-10-24) each owned shoot.ts, cards.ts or models.ts,
  // not the «shoot-seo-audit», «cards-seo-audit» or «models-en» test the change turned red, and lost an attempt to it.
  // One finding per owned file names all of its unowned tests, so the PM fixes them in one pass (site-seo-polish had nine).
  const flagged = new Map<string, { owned:string; folder?:string; tests:string[] }>();
  const named = input.listings ? namedTestCandidates(task, input.workspacePath, input.listings).map((candidate) => ({ ...candidate, folder:undefined, listed:true })) : [];
  const seen = new Set<string>();
  for (const candidate of [...siblingTestCandidates(task).map((candidate) => ({ ...candidate, listed:false })), ...named]) {
    const present = candidate.listed || (candidate.folder ? kindOf(resolvePath(input.workspacePath, candidate.folder)) === "directory" : kindOf(resolvePath(input.workspacePath, candidate.test)) === "file");
    if (!present || seen.has(candidate.test) || seen.size >= 20) continue;
    if (fileAllowedByOwns(candidate.test, task.owns_paths) || fileBlockedByNeverTouch(candidate.test, task.never_touch)) continue;
    const key = `${candidate.owned}\u0000${candidate.folder ?? ""}`;
    if (!flagged.has(key) && flagged.size >= 5) continue;
    seen.add(candidate.test);
    const group = flagged.get(key) ?? { owned:candidate.owned, ...(candidate.folder ? { folder:candidate.folder } : {}), tests:[] };
    group.tests.push(candidate.test);
    flagged.set(key, group);
  }
  for (const { owned, folder, tests } of flagged.values()) {
    const what = folder ? `tests in ${folder}` : tests.length > 1 ? `its tests ${tests.join(", ")}` : `its test ${tests[0]}`;
    errors.push({ code:"test_unowned", message:`owns_paths ${owned} has ${what} outside owns_paths; the writer updates the tests of the code it changes and an edit there rejects the attempt, so add ${tests.join(", ")} to owns_paths, or to never_touch if the writer must leave ${tests.length > 1 ? "them" : "it"} as ${tests.length > 1 ? "they are" : "it is"}` });
  }

  // A check that cannot fail proves nothing; a task of medium risk or more needs one that fails until its work exists.
  for (const [index, check] of task.verification.entries()) {
    const why = emptyCheckReason(check.command);
    if (why) errors.push({ code:"verification_empty_check", message:`verification[${index}] command "${check.command}" ${why}, so it passes whatever the writer does; replace it with a check that fails when the work is missing (the task's own test file, a grep for the expected string, test -f on a new file, a typecheck)` });
  }
  // A check that cannot see its own failure: a pipe into `tail`, a runner flag that passes when no test ran (rules 30694c, 45b334).
  for (const [index, check] of task.verification.entries()) {
    const masked = maskedExitReason(check.command);
    if (masked) errors.push({ code:"verification_masked_exit", message:`verification[${index}] command "${check.command}" ${masked}; start the command with \`set -o pipefail;\` (checks run in bash) or drop the pipe, so the check fails when the command before it fails` });
    const committed = needsCommitReason(check.command, (path) => path ? taskCreatesFile(task, path) : (task.files ?? []).some((file) => file.action === "create"));
    if (committed) errors.push({ code:"verification_needs_commit", message:`verification[${index}] ${committed}: Lane Pilot merges accepted work itself, so this check stays red whatever the writer does; read the working tree instead (cat, head, test, git status --porcelain, git diff), and leave what must be true after the merge to the acceptance` });
    const none = passWithNoTestsReason(check.command);
    if (none) errors.push({ code:"verification_pass_with_no_tests", message:`verification[${index}] command "${check.command}" ${none}; remove the flag and name the test file or folder exactly, so a wrong filter fails the check` });
  }
  // A check that only tests the existence of files the base already has is green before the work: it proves nothing.
  if (kinds && !isMainfixTask(task.id)) {
    const present = (path:string, cwd:string) => { const kind = kindOf(resolvePath(cwd, path)); return kind === "file" || kind === "directory"; };
    const vacuous = task.verification.flatMap((check, index) => {
      const paths = existenceOnlyPaths(check.command);
      return paths && paths.every((path) => present(path, check.cwd)) ? [{ index, check, paths }] : [];
    });
    const allVacuous = vacuous.length === task.verification.length && vacuous.length > 0;
    for (const { index, check, paths } of vacuous) {
      const finding = { code:"verification_existence_on_base", message:`verification[${index}] command "${check.command}" only tests that ${paths.join(", ")} exists, and it already exists on the base commit, so it passes before the work; test a new file, grep -q for the expected string, or run a test that fails now` };
      if (allVacuous && task.risk !== "low" && !NO_RED_KINDS.includes(task.kind ?? "")) errors.push(finding); else warnings.push(finding);
    }
  }
  if ((task.risk !== "low" || task.kind === "fix") && task.verification.length > 0 && kinds && !isMainfixTask(task.id) && !errors.some((error) => error.code === "verification_empty_check")
    && !checkNamedPaths(task).some((path) => kindOf(path) === "missing")) {
    const closes = task.kind === "fix" || task.kind === "check";
    warnings.push({ code:"no_red_before_green", message:`risk ${task.risk}${task.kind ? `, kind ${task.kind}` : ""}: no verification command names a file that is missing on the base commit, so every check may already pass before the work. ${closes ? `If they do, a ${task.kind} closes accepted without a writer. If the bug is still there, add a check that reproduces it.` : "If they do, the attempt does not start: green checks do not tell done from not done. Add a check that is red now."} This is a warning: the task goes on` });
  }

  // Checks: a folder filter ends in «/», and a whole-suite vitest run excludes what the sandbox cannot run.
  for (const filter of folderFilters(task)) {
    if (kindOf(filter.path) === "directory") {
      errors.push({ code:"filter_folder_slash", message:`verification[${filter.index}] filters by the folder ${filter.arg} without a trailing slash, which the runner reads as a text match and so also runs ${filter.arg}-*.test.ts and the like; write ${filter.arg}/` });
    }
  }
  for (const check of task.verification) {
    // With a gate, a task's check is its own files: the whole suite is the gate's, once per batch (so no exclusions to add either).
    // Two filtered calls of the same runner (`--filter A && --filter B`) are the suite twice; one filter is enough.
    const again = repeatedRunner(check.command);
    if (input.gate && again && !runsWholeSuite(check.command) && !runsGateCommand(check.command, input.gate.command)) {
      errors.push({ code:"repeated_runner_chain", message:`verification command "${check.command}" runs ${again} more than once in one check; one filtered run is enough, the integration gate (${input.gate.command}) runs the whole suite once per batch`,
        data:{ gateCommand:input.gate.command, runner:again } });
      continue;
    }
    if (input.gate && (runsWholeSuite(check.command) || runsGateCommand(check.command, input.gate.command))) {
      errors.push({ code:"whole_suite_with_gate", message:`verification command "${check.command}" runs the whole test suite; the integration gate (${input.gate.command}) runs the whole suite once per batch, so check only this task's files, e.g. npx vitest run <its test files>, plus the typecheck`,
        data:{ gateCommand:input.gate.command } });
      continue;
    }
    // A chain of one runner spends a suite startup per link whether or not a gate exists: warn and offer the one command (G2).
    if (again) {
      const glued = gluedCheckCommand(check.command);
      warnings.push({ code:"runner_chain", message:`verification command "${check.command}" runs ${again} more than once in one check; one run covers the same tests${glued ? ` — write it as "${glued}"` : " — name this task's test files together in one command (npx vitest run a.test.ts b.test.ts)"}`,
        data:{ runner:again, ...(glued ? { suggestedCommand:glued } : {}) } });
    }
    const missing = findSandboxUnsafeMissingExcludes(check.command, input.sandboxUnsafe);
    if (!missing.length) continue;
    const suggestedFlags = missing.map((pattern) => `--exclude "${pattern}"`).join(" ");
    errors.push({ code:"sandbox_unsafe", message:`verification command "${check.command}" runs a full test suite without excluding sandbox-unsafe tests; add missing exclusions: ${suggestedFlags}`,
      data:{ missingExcludes:missing, suggestedFlags } });
  }

  // A check that has outrun its limit in this project fails whatever the writer does: the recorded timeouts and green runs say how long it needs.
  // (Vampirism Fire 2026-10-26: wc35ef88c-T1 ran the whole Studio suite, 5–10 min, with no timeout_sec: killed at 120 s five times.)
  for (const [index, check] of task.verification.entries()) {
    const history = input.checkHistory?.(check);
    if (!history) continue;
    const limit = check.timeout_sec ?? DEFAULT_CHECK_TIMEOUT_SEC;
    const timedOut = Math.max(0, ...history.timedOutSec);
    const green = history.greenMs.length >= CHECK_HISTORY_MIN_RUNS ? Math.ceil(p95(history.greenMs) / 1000) : 0;
    const limitText = check.timeout_sec ? `timeout_sec ${limit}` : `no timeout_sec (the default is ${DEFAULT_CHECK_TIMEOUT_SEC} s)`;
    // The timed-out run says only «longer than its limit»: 5× that; the green runs say how long it takes: twice the p95, as the check's own widening does.
    const needed = Math.min(7200, Math.ceil(Math.max(limit <= timedOut ? timedOut * 5 : 0, limit < green ? green * 2 : 0) / 60) * 60);
    if (limit <= timedOut) {
      errors.push({ code:"verification_timeout", message:`verification[${index}] command "${check.command}" timed out in this project at ${timedOut} s (${history.timedOutSec.length} attempt${history.timedOutSec.length > 1 ? "s" : ""}) and this contract has ${limitText}, so it is killed again whatever the writer does; set timeout_sec to ${needed} or more${green ? ` (its green runs take up to ${green} s)` : ""}, or narrow the command to this task's tests` });
    } else if (limit < green) {
      errors.push({ code:"verification_timeout", message:`verification[${index}] command "${check.command}" took up to ${green} s in its last ${history.greenMs.length} green runs in this project and this contract has ${limitText}; set timeout_sec to ${needed} or more, or narrow the command to this task's tests` });
    }
  }

  // Secrets a check declares: a valid name, left open by the project list, of a kind a check can take, and in Env Catalog.
  // A name that is simply not saved yet is a warning: the task waits for it (waiting_secret) and starts once it is.
  const declared = [...new Set(task.verification.flatMap((check) => check.secrets ?? []))];
  const reserved = declared.filter((name) => SANDBOX_OWN_ENV.has(name));
  for (const name of reserved) errors.push({ code:"secret_reserved", message:`verification secrets names ${name}, which the sandbox sets itself; pick another name in Env Catalog` });
  const found = input.secrets;
  if (found && declared.length) {
    if (found.unavailable) {
      errors.push({ code:"secret_catalog_unavailable", message:`verification declares secrets (${declared.join(", ")}) but Env Catalog is not installed or not answering, so no check can receive them; install and enable the env-catalog plugin, or drop secrets from the checks` });
    } else {
      // The project list only narrows: a non-empty «Secrets checks may use» (secrets.allow) that leaves a name out stops it.
      if (found.denied.length) errors.push({ code:"secret_not_allowed", data:{ deniedSecrets:found.denied },
        message:`verification secrets ${found.denied.join(", ")} are left out of the project list «Secrets checks may use» (secrets.allow); add the name to the list (or empty the list, then every declared name is allowed), then send the task again` });
      if (found.wrongKind.length) errors.push({ code:"secret_kind", message:`verification secrets ${found.wrongKind.join(", ")} are SSH or FTP access, which a check cannot take; a deploy step that needs them goes to lane_pilot_errand` });
      for (const name of found.missing.filter((missing) => !reserved.includes(missing))) {
        const near = found.catalog ? nearSecretName(name, found.catalog) : null;
        if (near) errors.push({ code:"secret_name_unknown", message:`verification secrets ${name} is not in Env Catalog; did you mean ${near}? use the exact name` });
        else warnings.push({ code:"secret_missing", message:`verification secrets ${name} is not in Env Catalog yet: call env_request for it now (name ${name}, with a purpose); the task waits (waiting_secret:${name}) and starts by itself once the owner saves it` });
      }
    }
  }

  errors.push(...dependsLoopFindings(task, input.runTasks));

  // depends_on a task that already ended blocked or canceled: the PM replans before this one is queued.
  for (const dead of input.deadDependencies) {
    errors.push({ code:"depends_dead", data:{ replan:true }, message:dead.state === "blocked"
      ? `replan: depends_on ${dead.id} ended blocked, so this task would never start; send ${dead.id} again (fixed) first and then this task, which waits for it, or drop ${dead.id} from depends_on if the task does not need its files`
      : `replan: depends_on ${dead.id} ended canceled, so this task would never start; drop it from depends_on or dispatch ${dead.id} again first` });
  }

  // Overlapping an open task is allowed: the later task waits for the earlier one, so it is a note.
  for (const open of input.openTasks) {
    if (open.id !== task.id && ownsPathsOverlap(task.owns_paths, open.owns_paths) && !task.depends_on.includes(open.id)) {
      warnings.push({ code:"owns_overlap_open", message:`owns_paths overlap the open task ${open.id}; this task waits for it and runs after it, not beside it` });
    }
  }
  return { errors, warnings };
}

/** The one message that goes back to the PM: every problem with its fix, nothing created. */
export function lintReply(runId:string, errors:readonly LintFinding[]):Record<string, unknown> {
  const data = Object.assign({}, ...[...errors].reverse().map((error) => error.data ?? {})) as Record<string, unknown>;
  return { runId, state:"validation_failed", ...data,
    reason:`contract lint: nothing was dispatched and no attempt was spent. Fix and send the task again:\n${errors.map((error) => `- ${error.message}`).join("\n")}`,
    findings:errors.map(({ code, message }) => ({ code, message, blockingClass:blockingClass(code) })),
    // Three blocking classes: what is missing, what must come first, what is in the way.
    blockingClasses:[...new Set(errors.map((error) => blockingClass(error.code)).filter(Boolean))] };
}
