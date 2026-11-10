// Public API of docs: what other rooms import. Everything else in this room is private.
// Add a name here to make it public; scripts/refactor/barrels.ts wrote the first version from the existing imports.
export { CITATION_SOURCE, expandCitationLists, mergeFrontmatter, parseFrontmatter, setFrontmatter } from "./docs-lint";
export type { Frontmatter } from "./docs-lint";
export { DOCS_DEFAULT_SELECTION, parseDocsSettings } from "./docs";
export { buildDocsFlows } from "./docs-flows";
export { buildDocsAnchors, docsDepth, docsStaleness, jevApiKey, jevCallFor, verifyDocsCitations } from "./docs-jev";
export type { Anchor, JevCallAuth, JevCallSource, JevStatus } from "./docs-jev";
export { commitDocs, docsLineCounts, docsWorthinessFacts, gitDocsScope } from "./git-docs";
