# @lane-pilot/kit

Small helpers every part of the plugin uses, with no dependency on the plugin itself.

| Export | What it does |
|---|---|
| `sha256Hex(data)` (`sha256Buffer` is the old name), `sha256File`, `sha256Tree`, `hashPath` | The one place that calls `createHash("sha256")` |
| `redactSecrets`, `registerSecrets`, `redactKnown`, `redactKnownDeep` | Masks the secret values the process knows before text is stored or sent |
| `spawnAsync` | The only child-process seam; the host worker must never block in `spawnSync` |
| `cleanCheckOutput` and friends (`output-excerpt`) | Bounded excerpts of check output |
| `readBoundedWorkspaceFile` (`bounded-read`) | The one reader of workspace files, with size and symlink rules |
| `jsonc` | Edits of the OpenCode `plugin` list that keep comments |
| `paths` | Home, `.agents`, the plugin root from a module URL (`pluginRootFromModule`) |
| `owns-paths` (also `@lane-pilot/kit/owns-paths`) | `owns_paths` / `never_touch` glob matching; the subpath has no `node:` import and is the one the UI may use |

The index imports `node:` modules: the browser bundle must use the subpath above and nothing else from here.
Depends on nothing; every other package and room may use it.
