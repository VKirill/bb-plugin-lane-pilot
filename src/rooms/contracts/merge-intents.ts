/** The merge-intent recovery pass, implemented by src/rooms/verification (createMergeIntentRecovery). */
export interface MergeIntentsApi {
  recoverMergeIntents(options?: { now?:number; graceMs?:number }): Promise<string[]>;
}
