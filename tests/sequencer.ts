import { relative } from "node:path";
import { BaseSequencer, type TestSpecification } from "vitest/node";

/**
 * Vitest's own order runs the projects one after another (alphabetically: node, node-isolated, ui, ui-isolated) and sorts only
 * inside a project. The slowest files of the run are the page files of the ui project, so they started last and ran nine at a
 * time into a tail of three or four, then the isolated files again with a few workers busy: a full run held 9 workers busy
 * for 40 s and 3-4 of them for the last 30. This order is one list for all projects: failed files first (as before), then the
 * longest by the duration of their last run, files that were never run first by size. The files of every project still run in
 * their own project (isolation, environment, setup are the project's), only the queue is shared.
 */
export default class LongestFirstSequencer extends BaseSequencer {
  async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const cache = this.ctx.cache;
    const key = (spec: TestSpecification) => `${spec.project.name}:${relative(this.ctx.config.root, spec.moduleId)}`;
    return [...files].sort((a, b) => {
      const aState = cache.getFileTestResults(key(a));
      const bState = cache.getFileTestResults(key(b));
      if (!aState || !bState) {
        const statsA = cache.getFileStats(key(a));
        const statsB = cache.getFileStats(key(b));
        if (!statsA || !statsB) return !statsA && statsB ? -1 : !statsB && statsA ? 1 : 0;
        return statsB.size - statsA.size;
      }
      if (aState.failed && !bState.failed) return -1;
      if (!aState.failed && bState.failed) return 1;
      return bState.duration - aState.duration;
    });
  }
}
