import { spawnAsync } from "@lane-pilot/kit";
import { parseSkillTree, SKILL_TREE_TTL_MS, type SkillTree } from "../../models/skill-tree";

let cache: { at: number; tree: SkillTree | null } | null = null;
let pending: Promise<SkillTree | null> | null = null;

export function resetSkillTreeCache(): void {
  cache = null;
  pending = null;
}

/** Cached tree. `null` (a bad read, cached for the hour) means the caller uses the old catalog. */
export function skillTreeCached(read: () => Promise<string>): Promise<SkillTree | null> {
  if (cache && Date.now() - cache.at < SKILL_TREE_TTL_MS) return Promise.resolve(cache.tree);
  if (!pending) {
    pending = read()
      .then((raw) => {
        const tree = parseSkillTree(raw);
        cache = { at: Date.now(), tree };
        return tree;
      })
      .catch(() => {
        cache = { at: Date.now(), tree: null };
        return null;
      })
      .finally(() => { pending = null; });
  }
  return pending;
}

export async function readSkillTreeText(): Promise<string> {
  const bin = process.env.BB_CLI || "bb";
  const out = await spawnAsync(bin, ["tools", "skills-tree", "--skills", "--json"], { timeout: 20_000, maxBuffer: 8_000_000 });
  if (out.error || out.status !== 0) throw out.error ?? new Error(`skills-tree exit ${out.status}: ${out.stderr.slice(0, 200)}`);
  return out.stdout;
}
