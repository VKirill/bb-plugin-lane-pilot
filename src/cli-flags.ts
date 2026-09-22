import type { CliBinary } from "./channels";

const PROJECT_CWD_COMMANDS: Record<CliBinary, string[]> = {
  "run-controller": ["run", "start"],
  "lane-ctl": ["start", "verify", "accept"],
};

const TASK_FILE_COMMANDS: Record<CliBinary, string[]> = {
  "run-controller": [],
  "lane-ctl": ["start", "verify", "accept"],
};

const TASK_ID_REQUIRED: Record<CliBinary, string[]> = {
  "run-controller": [],
  "lane-ctl": ["status", "tail", "events", "cancel", "retry", "fallback"],
};

export function requiredCliFlags(input: {
  binary: CliBinary;
  subcommand: string;
  runDir: string;
  projectCwd?: string;
  taskFile?: string;
  taskId?: string;
}): Record<string, string> {
  const flags: Record<string, string> = {
    "--run-dir": input.runDir,
  };
  if (input.subcommand === "status") {
    flags["--json"] = "";
  }
  if (PROJECT_CWD_COMMANDS[input.binary].includes(input.subcommand)) {
    if (!input.projectCwd) throw new Error(`${input.binary} ${input.subcommand} requires --project-cwd`);
    flags["--project-cwd"] = input.projectCwd;
  }
  if (TASK_FILE_COMMANDS[input.binary].includes(input.subcommand)) {
    if (!input.taskFile) throw new Error(`${input.binary} ${input.subcommand} requires --task-file`);
    flags["--task-file"] = input.taskFile;
  }
  if (TASK_ID_REQUIRED[input.binary].includes(input.subcommand)) {
    if (!input.taskId) throw new Error(`${input.binary} ${input.subcommand} requires --task-id`);
    flags["--task-id"] = input.taskId;
  }
  return flags;
}
