import { wfRunRow, type NodeExecutor, type WorkflowEngine } from "@lane-pilot/workflow-engine";
import { assertRunAdmission, beginRunAdmission, trackWorkflowAdmissions, type LanePilotDatabase } from "../../storage";

/** Protect both admission and actual callbacks: cancel/timeout can publish a terminal graph before its executor settles. */
export function installWorkflowAdmission(db: LanePilotDatabase, engine: WorkflowEngine): () => void {
  const start = engine.start.bind(engine);
  engine.start = (input) => db.transaction(() => {
    if (input.link?.runId) assertRunAdmission(db, input.link.runId);
    return start(input);
  }).immediate();

  async function protectedWork<T>(runId: string, work: () => Promise<T>): Promise<T> {
    const linked = wfRunRow(db, runId)?.link_run_id;
    const release = linked ? beginRunAdmission(db, linked) : () => {};
    try { return await work(); } finally { release(); }
  }
  const rerun = engine.rerunNode.bind(engine);
  engine.rerunNode = (runId, ...args) => protectedWork(runId, () => rerun(runId, ...args));
  const register = engine.register.bind(engine);
  engine.register = <R>(key: string, executor: NodeExecutor<R>) => {
    const wrapped: NodeExecutor<R> = {
      ...executor,
      run: (context) => protectedWork(context.runId, () => executor.run(context)),
      ...(executor.poll ? { poll: (...args) => protectedWork(args[0].runId, () => executor.poll!(...args)) } : {}),
    };
    return register(key, wrapped);
  };
  return trackWorkflowAdmissions(db, () => engine.inFlight());
}
