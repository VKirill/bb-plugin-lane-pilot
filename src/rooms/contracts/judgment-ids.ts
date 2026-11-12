/** Judgment ids `runs` reads without importing the workflow or writer rooms, and the writer-route KV key the pick writes and the sweep reads. */
export const WRITER_MODEL_JUDGMENT_ID = "writer.model";
export const writerRouteKey = (runId: string, taskId: string) => `writer-route:${runId}:${taskId}`;
