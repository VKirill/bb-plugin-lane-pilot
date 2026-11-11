// Every import here carries its .ts suffix: the session hook imports this index and runs as plain source (node --experimental-strip-types).
// @ts-expect-error TS5097
export { buildFileCard, type FileCard, type GitFacts } from "./card.ts";
// @ts-expect-error TS5097
export { collectGitFacts, trackedFiles } from "./git.ts";
// @ts-expect-error TS5097
export { appendTouch, cardNotes, catalogDir, catalogExists, findRepo, readCatalog, readMeta, readTouches, repoHead, writeCatalog, type Touch } from "./store.ts";
// @ts-expect-error TS5097
export { buildCatalog, catalogNeedsBuild, collectCards, startCatalogBuild } from "./build.ts";
// @ts-expect-error TS5097
export { CATALOG_USAGE, runCatalogCli } from "./cli.ts";
