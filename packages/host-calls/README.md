# @lane-pilot/host-calls

Calls from the plugin server to BB host machines.

- `runOnHost(host, { hostId, cwd, command, timeoutSec, timeoutMs? })`: the `runCommand` host call that 16 server modules used to
  spell out by hand. The host id travels twice on the wire (in the input and in the call options); the default wait is the command's
  own limit plus five seconds, and a caller that needs another wait passes `timeoutMs`. The host type is structural.
- `createHostJobs`, `isHostJobKind` (`host-jobs`): a long host call run as a background job. The host daemon cancels a call at its
  deadline and kills the worker, so `jobStart` returns at once, `jobStatus` is polled with backoff, and the job's id is kept in KV
  until the answer is taken; a plugin reload finds the id and carries on. The core wraps `host.call` with it.

Depends on `@lane-pilot/contracts` (`HOST_JOB_KINDS`) and `@lane-pilot/kit`. Used by the `server/` code of the rooms.
