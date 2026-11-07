/** Resolves «the Lane Pilot project» and keeps the owner's notice about it in step; implemented by src/rooms/self-repair. */
export type LaneProjectNotice = (db: unknown, bb: unknown, host: unknown) => Promise<{ projectId: string; environmentId: string } | null>;
