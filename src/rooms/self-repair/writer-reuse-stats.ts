type Db = { prepare(sql:string):{ all(...args:unknown[]):unknown[] } };

export type WriterReuseStats = {
  /** Writer tasks dispatched in the period, and how many of them ended accepted. */
  tasks:number; accepted:number;
  /** Writer threads started: each is a cold session that re-reads the project. */
  coldThreads:number;
  /** Attempts that continued an existing writer thread (an area's next task or a redo in place). */
  continued:number;
  /** Cold threads per accepted task; 1 or less is a writer per task, SelfyStudio's page port was 2.2. */
  coldPerAccepted:number | null;
  /** Share of tasks that named an area, and accepted tasks per area. */
  areaShare:number | null; tasksPerArea:number | null;
  /** Median minutes from dispatch to acceptance. */
  medianMinutesToAccept:number | null;
};

const round1 = (value:number) => Math.round(value * 10) / 10;

/** How often writers start cold versus continue, and how fast tasks land, for one project since `since`. */
export function writerReuseStats(db:Db, projectId:string, since:number):WriterReuseStats {
  const tasks = db.prepare(`SELECT t.id, t.created_at AS createdAt, json_extract(t.contract_json,'$.area') AS area,
      (SELECT MIN(a.updated_at) FROM lane_pilot_attempt a WHERE a.task_id=t.id AND a.run_id=t.run_id AND a.state='accepted') AS acceptedAt
    FROM lane_pilot_task t JOIN lane_pilot_run r ON r.id=t.run_id
    WHERE r.project_id=? AND t.kind='bb' AND t.created_at>=?`).all(projectId, since) as Array<{ id:string; createdAt:number; area:string | null; acceptedAt:number | null }>;
  const threads = db.prepare(`SELECT a.thread_id AS threadId, COUNT(*) AS turns FROM lane_pilot_attempt a
    JOIN lane_pilot_task t ON t.id=a.task_id AND t.run_id=a.run_id JOIN lane_pilot_run r ON r.id=a.run_id
    WHERE r.project_id=? AND t.kind='bb' AND t.created_at>=? AND a.thread_id IS NOT NULL GROUP BY a.thread_id`).all(projectId, since) as Array<{ threadId:string; turns:number }>;
  const accepted = tasks.filter((row) => row.acceptedAt !== null);
  const continued = threads.reduce((sum, row) => sum + row.turns - 1, 0);
  const waits = accepted.map((row) => (row.acceptedAt! - row.createdAt) / 60_000).sort((a, b) => a - b);
  const areas = new Set(accepted.map((row) => row.area?.trim().toLowerCase()).filter(Boolean));
  const withArea = tasks.filter((row) => row.area).length;
  return {
    tasks:tasks.length, accepted:accepted.length, coldThreads:threads.length, continued,
    coldPerAccepted:accepted.length ? round1(threads.length / accepted.length) : null,
    areaShare:tasks.length ? Math.round(100 * withArea / tasks.length) : null,
    tasksPerArea:areas.size ? round1(accepted.filter((row) => row.area).length / areas.size) : null,
    medianMinutesToAccept:waits.length ? Math.round(waits[Math.floor((waits.length - 1) / 2)]!) : null,
  };
}
