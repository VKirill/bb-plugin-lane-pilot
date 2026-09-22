export type CliRunStatus = "accepted" | "blocked" | "running";

export type CliOutcome = {
  status: CliRunStatus;
  taskAccepted: boolean;
  upstreamAccepted: boolean | null;
  upstreamStatus: string | null;
  reason: string;
};

const TERMINAL_FAIL = new Set(["failed", "blocked", "canceled"]);
const IN_FLIGHT = new Set(["started", "running", "awaiting_verification", "verified", "provider_partial"]);

function numberField(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

function parseJsonObject(stdout: string): Record<string, unknown> | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    const value = JSON.parse(trimmed) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    const start = trimmed.lastIndexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      const value = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
      return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }
}

export function classifyCliOutcome(input: {
  subcommand: string;
  exitCode: number;
  stdout: string;
}): CliOutcome {
  const parsed = parseJsonObject(input.stdout);
  const accepted = typeof parsed?.accepted === "boolean" ? parsed.accepted : null;
  const upstream = typeof parsed?.status === "string"
    ? parsed.status
    : (input.stdout.match(/\bstatus=([a-z_]+)/i)?.[1] ?? null);
  const taskExit = numberField(parsed?.exit_code);
  const acceptedSignal = accepted === true || upstream === "accepted";
  const failedSignal = (upstream !== null && TERMINAL_FAIL.has(upstream)) || (taskExit !== null && taskExit !== 0);
  const inFlightSignal = upstream !== null && IN_FLIGHT.has(upstream);
  if (acceptedSignal && (failedSignal || inFlightSignal || (accepted === true && upstream !== null && upstream !== "accepted") || (upstream === "accepted" && accepted === false))) {
    return {
      status:"blocked",
      taskAccepted:false,
      upstreamAccepted:accepted,
      upstreamStatus:upstream,
      reason:"conflicting upstream receipt",
    };
  }
  if (acceptedSignal) {
    return {
      status:"accepted",
      taskAccepted:true,
      upstreamAccepted:accepted,
      upstreamStatus:upstream,
      reason:"upstream accepted",
    };
  }
  if (upstream !== null && TERMINAL_FAIL.has(upstream)) {
    return {
      status:"blocked",
      taskAccepted:false,
      upstreamAccepted:accepted,
      upstreamStatus:upstream,
      reason:`upstream ${upstream}`,
    };
  }
  if (upstream !== null && IN_FLIGHT.has(upstream)) {
    return {
      status:"running",
      taskAccepted:false,
      upstreamAccepted:accepted,
      upstreamStatus:upstream,
      reason:`upstream ${upstream}`,
    };
  }
  if (taskExit !== null && taskExit !== 0) {
    return {
      status:"blocked",
      taskAccepted:false,
      upstreamAccepted:accepted,
      upstreamStatus:upstream,
      reason:`upstream exit ${taskExit}`,
    };
  }
  if (accepted === false) {
    return {
      status:"blocked",
      taskAccepted:false,
      upstreamAccepted:accepted,
      upstreamStatus:upstream,
      reason:"upstream not accepted",
    };
  }
  if ((input.subcommand === "start" || input.subcommand === "run") && input.exitCode === 0) {
    return {
      status:"running",
      taskAccepted:false,
      upstreamAccepted:accepted,
      upstreamStatus:upstream,
      reason:"control command started, writer not accepted",
    };
  }
  if (input.exitCode !== 0) {
    return {
      status:"blocked",
      taskAccepted:false,
      upstreamAccepted:accepted,
      upstreamStatus:upstream,
      reason:`control exit ${input.exitCode}`,
    };
  }
  return {
    status:"running",
    taskAccepted:false,
    upstreamAccepted:accepted,
    upstreamStatus:upstream,
    reason:"control exit 0 without accepted=true",
  };
}

export type DirtSnapshot = { path: string; sha256: string };

function asSnapshots(rows: DirtSnapshot[] | string[]): DirtSnapshot[] {
  return rows.map((row) => typeof row === "string" ? { path:row, sha256:"" } : row);
}

export function parseDirtSnapshots(raw: string): DirtSnapshot[] {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => {
      if (typeof item === "string" && item.length > 0) return [{ path:item, sha256:"" }];
      if (item && typeof item === "object" && typeof (item as DirtSnapshot).path === "string") {
        const sha256 = typeof (item as DirtSnapshot).sha256 === "string" ? (item as DirtSnapshot).sha256 : "";
        return [{ path:(item as DirtSnapshot).path, sha256 }];
      }
      return [];
    });
  } catch {
    return [];
  }
}

export function attemptProduced(after: DirtSnapshot[] | string[], before: DirtSnapshot[] | string[]): string[] {
  const afterFiles = asSnapshots(after);
  const beforeFiles = asSnapshots(before);
  const hashed = [...afterFiles, ...beforeFiles].some((file) => file.sha256.length > 0);
  if (!hashed) {
    const previous = new Set(beforeFiles.map((file) => file.path));
    return afterFiles.map((file) => file.path).filter((path) => !previous.has(path));
  }
  const previous = new Map(beforeFiles.map((file) => [file.path, file.sha256]));
  const current = new Map(afterFiles.map((file) => [file.path, file.sha256]));
  const produced = new Set<string>();
  for (const file of afterFiles) {
    if (previous.get(file.path) !== file.sha256) produced.add(file.path);
  }
  for (const file of beforeFiles) {
    if (!current.has(file.path)) produced.add(file.path);
  }
  return [...produced];
}
