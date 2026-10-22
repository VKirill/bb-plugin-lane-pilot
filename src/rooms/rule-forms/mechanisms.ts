import type { MechanismKind } from "@lane-pilot/run-insights";

/**
 * The rules a mechanism of this repository already holds (SMA block 6, P2-6). A rule is only listed when the mechanism REFUSES the
 * mistake the rule describes: tests/rule-mechanisms.test.ts runs each `full` entry's recorded bad case through the real contract lint
 * (or checks its named test) and fails when the mechanism stops refusing it or its test file is gone. Only a `full` entry lets the rule's
 * text leave the brief (`bb lane-pilot rules mechanize`); a `partial` one is shown so the owner sees what is still missing.
 *
 * Add an entry in the same commit as the mechanism, never before; `matches` is tested on the rule's words.
 */
export type Mechanism = {
  id: string;
  kind: MechanismKind;
  coverage: "full" | "partial";
  /** Written to the rule's `mechanized_by`: what enforces it and where. */
  ref: string;
  /** Repository-relative test files that must exist for the entry to stand. */
  tests: readonly string[];
  /** The words of the rules this mechanism makes redundant. */
  matches: RegExp;
  /** Contract lint finding codes the mechanism raises (full entries of kind contract_lint). */
  lintCodes?: readonly string[];
  /** For a partial entry: what is not covered yet. */
  gap?: string;
};

export const MECHANISMS: readonly Mechanism[] = [
  { id: "verification-masked-exit", kind: "contract_lint", coverage: "full", lintCodes: ["verification_masked_exit"], tests: ["tests/contract-lint-exit-status.test.ts"],
    ref: "contract lint verification_masked_exit (src/rooms/tasks/server/lint-exit-status.ts, tests/contract-lint-exit-status.test.ts)",
    matches: /`\$\?`[^.]{0,40}pipe|\|\s*tail`? always exits 0/i },
  // Partial: the accepted rule also carries project knowledge the lint cannot hold (SelfyStudio apps/api: `npm run test -- <file>` goes to node --test).
  { id: "verification-pass-with-no-tests", kind: "contract_lint", coverage: "partial", lintCodes: ["verification_pass_with_no_tests"], tests: ["tests/contract-lint-exit-status.test.ts"],
    ref: "contract lint verification_pass_with_no_tests (src/rooms/tasks/server/lint-exit-status.ts, tests/contract-lint-exit-status.test.ts)",
    matches: /--passWithNoTests/i,
    gap: "the lint refuses --passWithNoTests; the rule's project knowledge (how a project's test runner takes a file argument) stays text" },
  { id: "filter-folder-slash", kind: "contract_lint", coverage: "full", lintCodes: ["filter_folder_slash"], tests: ["tests/contract-lint.test.ts"],
    ref: "contract lint filter_folder_slash (src/rooms/tasks/server/contract-lint.ts, tests/contract-lint.test.ts)",
    matches: /name a test folder with a trailing slash/i },
  { id: "sibling-tests-owned", kind: "contract_lint", coverage: "full", lintCodes: ["test_unowned"], tests: ["tests/contract-lint.test.ts"],
    ref: "contract lint test_unowned (src/rooms/tasks/server/contract-lint.ts, tests/contract-lint.test.ts)",
    matches: /colocated tests[\s\S]{0,160}owns_paths/i },
  { id: "task-standard", kind: "contract_lint", coverage: "full", lintCodes: ["display_title_missing", "kind_missing"], tests: ["tests/contract-lint.test.ts"],
    ref: "contract lint display_title_missing / kind_missing (src/rooms/tasks/server/contract-lint.ts, tests/contract-lint.test.ts)",
    matches: /must carry display_title[\s\S]{0,240}contract lint rejects/i },
  { id: "paths-outside-project", kind: "contract_lint", coverage: "full", lintCodes: ["ownership_unsafe", "read_first_path"], tests: ["tests/contract-lint.test.ts"],
    ref: "contract lint ownership_unsafe / read_first_path (src/rooms/tasks/server/contract-lint.ts, tests/contract-lint.test.ts)",
    matches: /never put paths outside the project[\s\S]{0,80}task contract/i },
  { id: "code-roles-keep-gitnexus", kind: "static_test", coverage: "full", tests: ["tests/role-mcp-hints.test.ts"],
    ref: "test tests/role-mcp-hints.test.ts (ROLE_PROFILES: writer, code-repair, night-fixer, code-critic keep gitnexus)",
    matches: /never strip the code-intelligence tools/i },
  // Partial: the mistake is caught after it happened, or only where the project configured the list.
  { id: "writer-changed-outside-owns", kind: "ownership_check", coverage: "partial", tests: ["tests/server/ownership-reason.test.ts"],
    ref: "attempt gate «writer changed paths outside owns_paths» (src/rooms/verification/ownership.ts)",
    matches: /(?:compare|сверя)[\s\S]{0,100}owns_paths/i,
    gap: "the gate rejects the attempt after the writer edited the file (a spent attempt); a PreToolUse guard that refuses the edit before it happens does not exist" },
  { id: "sandbox-unsafe-excludes", kind: "contract_lint", coverage: "partial", lintCodes: ["sandbox_unsafe", "whole_suite_with_gate"], tests: ["tests/contract-lint.test.ts"],
    ref: "contract lint sandbox_unsafe / whole_suite_with_gate (needs the project's verification.sandbox_unsafe list or an integration gate)",
    matches: /bare `npx vitest run`|exclude[^.]{0,40}tests\/verification|full vitest suite as a task's verification/i,
    gap: "enforced only for a project that lists its sandbox-unsafe tests (verification.sandbox_unsafe) or has an integration gate; the rule is the only holder elsewhere" },
];

/** The mechanism that holds a rule, or null; the first entry whose words match. */
export function mechanismFor(rule: string): Mechanism | null {
  return MECHANISMS.find((entry) => entry.matches.test(rule)) ?? null;
}
