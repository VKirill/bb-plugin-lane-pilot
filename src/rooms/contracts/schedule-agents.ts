import type { SqlDb } from "./sql-db";

export type AgentScheduleRef = { id: string; name: string; task: { agentId?: string } };
/** The schedule board's active-agent read, implemented by src/rooms/schedule and injected for the native-agent registry. */
export interface ScheduleAgentApi {
  activeAgentSchedules(db: SqlDb): AgentScheduleRef[];
}
