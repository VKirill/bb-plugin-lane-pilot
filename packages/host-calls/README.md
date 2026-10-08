# @lane-pilot/host-calls

`runOnHost(host, { hostId, cwd, command, timeoutSec, timeoutMs? })`: the `runCommand` host call that 16 server
modules used to spell out by hand. The host id travels twice on the wire (in the input and in the call options);
the default wait is the command's own limit plus five seconds, and a caller that needs another wait passes
`timeoutMs`. The host type is structural, so the package depends on nothing; the typed call itself is the core's
`host.call`. Used by the `server/` code of the rooms.
