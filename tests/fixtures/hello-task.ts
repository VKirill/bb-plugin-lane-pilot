import { taskV2Schema } from "../../src/rooms/contracts";
import type { TaskV2 } from "../../src/rooms/contracts";

/** A small valid task-v2 for tests: two text outputs, one content check. Was the production dispatch's default (removed): a dispatch without a contract now fails. */
export function buildTask(writerWorkspacePath: string, taskId: string): TaskV2 {
  return taskV2Schema.parse({
    schema_version: 2,
    id: taskId,
    title: "Create the Lane Pilot hello fixture",
    display_title: "Файл hello для проверки записи",
    kind: "chore",
    area: "maintenance",
    risk: "low",
    lane: "writer",
    project_cwd: writerWorkspacePath,
    read_first: ["README.md"],
    interfaces: ["hello.txt must contain exactly: hello from native BB writer"],
    invariants: ["Do not edit files outside this fixture checkout"],
    out_of_scope: ["Lane Pilot plugin source", "user configuration"],
    expected_outputs: ["hello.txt", "tests/hello.test.txt"],
    owns_paths: ["hello.txt", "tests/hello.test.txt"],
    never_touch: [".git/**", ".claude/**"],
    depends_on: [],
    objective: "Create hello.txt and a text test fixture proving its exact content.",
    acceptance: [
      "hello.txt contains exactly 'hello from native BB writer' followed by a newline",
      "tests/hello.test.txt contains the expected line",
    ],
    verify: "tests",
    verification: [{ command: "test \"$(cat hello.txt)\" = \"hello from native BB writer\"", cwd: writerWorkspacePath, timeout_sec: 30 }],
  });
}
