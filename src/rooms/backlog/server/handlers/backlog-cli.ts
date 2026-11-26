import type { BacklogApi } from "../services/scanner";

export const BACKLOG_USAGE = "bb lane-pilot backlog <project-id> | --scan   (ready todos: issuable in queue order, to estimate, to split, blocked; --scan issues now within the caps)";

export async function runBacklogCli(api: BacklogApi, argv: readonly string[]): Promise<{ exitCode: number; stdout?: string; stderr?: string }> {
  try {
    if (argv.length === 1 && argv[0] === "--scan") return { exitCode: 0, stdout: JSON.stringify(await api.scan(), null, 2) };
    if (argv.length === 1 && !argv[0]!.startsWith("--")) return { exitCode: 0, stdout: JSON.stringify(await api.board(argv[0]!), null, 2) };
    return { exitCode: 1, stderr: BACKLOG_USAGE };
  } catch (cause) {
    return { exitCode: 1, stderr: cause instanceof Error ? cause.message : String(cause) };
  }
}
