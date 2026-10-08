// Optional second gate next to tests/architecture/boundaries.test.ts (that test is what the deploy gate runs):
//   npm run check:deps          prints a report of the same rules, readable by humans
// dependency-cruiser is not a devDependency; the script fetches it with npx. Cycles are not checked here: it counts
// `export type` and type-only edges as cycles, so tests/architecture/boundaries.test.ts (value imports only) is the one gate for them.
/** @type {import("dependency-cruiser").IConfiguration} */
module.exports = {
  options: {
    tsConfig: { fileName: "tsconfig.json" },
    doNotFollow: { path: "node_modules" },
    exclude: { path: "(^|/)(\\.claude|\\.bb|dist|node_modules|tests|scripts)/" },
    tsPreCompilationDeps: "specify",
    enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["import", "require", "node", "default"], extensions: [".ts", ".tsx", ".js", ".json"], mainFiles: ["index"] },
  },
  forbidden: [
    {
      name: "packages-never-import-src",
      comment: "packages/* are shared code: they depend on other packages and on npm modules, never on a room or an entry.",
      severity: "error",
      from: { path: "^packages/[^/]+/src" },
      to: { path: "^(src/|server\\.ts$|host\\.ts$|app\\.tsx$)" },
    },
    {
      name: "room-internals-are-private",
      comment: "Another room is entered through its index.ts, server/index.ts or ui/index.ts. Deep imports still present are counted in tests/architecture/deep-imports.json.",
      severity: "warn",
      from: { path: "^src/rooms/([^/]+)/" },
      to: { path: "^src/rooms/([^/]+)/", pathNot: ["^src/rooms/$1/", "^src/rooms/[^/]+/(server/|ui/)?index\\.tsx?$"] },
    },
    {
      name: "ui-does-not-import-server",
      severity: "error",
      from: { path: "^src/rooms/[^/]+/ui/" },
      to: { path: "^src/rooms/[^/]+/server/", dependencyTypesNot: ["type-only"] },
    },
    {
      name: "server-does-not-import-ui",
      severity: "error",
      from: { path: "^src/rooms/[^/]+/server/" },
      to: { path: "^src/rooms/[^/]+/ui/", dependencyTypesNot: ["type-only"] },
    },
    {
      name: "ui-bundle-has-no-node-modules",
      comment: "app.tsx runs in the browser.",
      severity: "error",
      from: { path: "^(app\\.tsx|src/rooms/[^/]+/ui/|packages/ui-kit/)" },
      to: { dependencyTypes: ["core"], dependencyTypesNot: ["type-only"] },
    },
  ],
};
