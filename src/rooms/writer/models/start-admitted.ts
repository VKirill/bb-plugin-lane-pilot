/** The tasks whose writer passed admission, per plugin instance: the files they own are theirs until their last attempt ends. */
export const admittedByCore = new WeakMap<object, Map<string, { runId:string; taskId:string; projectId:string }>>();
