

// A reload stops a pass in flight: its API handle goes stale and its database closes. The catch-up resumes it.
// Its host calls end too: the daemon disposes the retired generation's worker, which exits with 0 and rejects the
// calls still pending with «host plugin worker exited (0)», and the core aborts the schedule run, whose signal
// cancels the rest («Host plugin call was cancelled»). A worker that crashes or is killed exits otherwise and stays a failure.
export const pluginStopped=(cause:unknown)=>/stale API handle|generation .* is retired|plugin .* (reloaded|disabled)|database connection is not open|host plugin worker exited \(0\)|^Host plugin call was cancelled$/i.test(cause instanceof Error?cause.message:String(cause));
