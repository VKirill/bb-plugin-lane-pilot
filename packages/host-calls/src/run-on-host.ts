/**
 * `runCommand` on a machine of the BB hub: the one shape every caller used to spell out by hand,
 * `host.call("runCommand", { requestedHostId, command, cwd, timeoutSec }, { hostId, timeoutMs })`.
 * The host id travels twice on the wire (in the input and in the call options); it is given once here.
 */
export type RunCommandResult = { hostId: string; exitCode: number; stdout: string; stderr: string };

/** What `runOnHost` needs of the host client: the typed `call` of the plugin core (or of the raw SDK client). */
export type RunCommandHost = {
  call(
    method: "runCommand",
    input: { requestedHostId: string; command: string; cwd: string; timeoutSec?: number },
    options: { hostId: string; timeoutMs?: number },
  ): Promise<RunCommandResult>;
};

export type RunOnHostArgs = {
  hostId: string;
  cwd: string;
  command: string;
  timeoutSec: number;
  /** How long the hub waits for the answer. Default: the command's own limit plus five seconds for the transport. */
  timeoutMs?: number;
};

export function runOnHost(host: RunCommandHost, args: RunOnHostArgs): Promise<RunCommandResult> {
  return host.call(
    "runCommand",
    { requestedHostId: args.hostId, command: args.command, cwd: args.cwd, timeoutSec: args.timeoutSec },
    { hostId: args.hostId, timeoutMs: args.timeoutMs ?? (args.timeoutSec + 5) * 1000 },
  );
}
