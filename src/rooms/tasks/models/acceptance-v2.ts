import type { TaskV2 } from "../../contracts";

export function acceptanceArtifactDir(workspace: string, runId: string, taskId: string): string {
  return `${workspace}/.agents/runs/${runId}/artifacts/${taskId}`;
}

export function bbWriterReportMarkdown(task: TaskV2, attempt: number): string {
  return [
    "STATUS: complete",
    "",
    `# ${task.title}`,
    "",
    task.objective,
    "",
    `Attempt ${attempt} accepted by Lane Pilot BB writer.`,
    "",
  ].join("\n");
}
