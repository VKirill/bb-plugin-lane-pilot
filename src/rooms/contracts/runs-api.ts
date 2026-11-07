/** What runs owns and other rooms reach through the services bag (src/rooms/runs/server/blocked-by.ts). */
export type IsTaskSatisfied = (kv: { get(key: string): Promise<unknown>; set(key: string, value: never): Promise<unknown> }, projectId: string, taskId: string) => Promise<boolean>;
