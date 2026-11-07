/** The wall's config and status reads, structurally, so a consumer (the self-improvement screen) needs no wall import. */
export interface WallConfigStatus {
  config(): Promise<{ enabled: boolean }>;
  status(): { nights: Array<{ startedAt?: number; dryRun?: boolean; spend?: unknown; cap?: unknown }>; open: number };
}
