// Types for the scene lib next to it (lp-ui-drive.mjs is plain .mjs; the tests import these).
export class SceneUsage extends Error {}
export type SceneArgs = { stage: boolean; trees: string[]; port: number | null; width: number | null; scene: string };
export function parseSceneArgs(argv: string[]): SceneArgs;
export function kitOfTrees(checkoutRoot: string): string[];
export function treeAddress(treePath: string, port?: number | null): string;
export function treeBuildError(treePath: string): string | null;
export function serveTree(treePath: string, opts?: { port?: number | null }): Promise<{ url: string; temp: string; close(): Promise<void> }>;
export function waitForPage(url: string, timeoutMs?: number): Promise<boolean>;
