/**
 * A red-gate episode: one gate command that keeps failing on the same test files, until a gate run is green. One row on the
 * owner's list per episode (keyed by `startedAt`); later red runs of the same episode add nothing and tell nobody (live
 * 2026-10-09: the same form reached the owner three times; 2026-10-31: a gate note woke a finished PM).
 */
export type GateEpisode = {
  command: string;
  /** Every failing file seen in the episode. */
  files: string[];
  startedAt: number;
};

const norm = (path: string) => path.replace(/^\.\//, "").replace(/\\/g, "/").trim();

/**
 * The same episode when the command is the same and the files that fail now are among those that failed before (a fix in
 * progress shrinks the set; it does not start a new question). A run whose failing files could not be read continues only
 * an episode that had none either.
 */
export function continuesEpisode(episode: GateEpisode | null | undefined, command: string, files: string[]): boolean {
  if (!episode || episode.command !== command) return false;
  if (files.length === 0 || episode.files.length === 0) return files.length === 0 && episode.files.length === 0;
  const known = new Set(episode.files.map(norm));
  return files.every((file) => known.has(norm(file)));
}
