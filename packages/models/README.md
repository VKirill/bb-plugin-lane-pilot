# @lane-pilot/models

Providers and models as the plugin sees them, with no SDK call.

| Export | What it does |
|---|---|
| `ModelCatalog`, `findProvider`, `findModel`, `findModelIn(models, id)` | The hub's catalog and the one lookup of a model by id or model name |
| `validateChoice`, `offeredOnHost`, `nodeEffortsFor`, `costTier` | Whether a provider/model/effort/tier choice is real, and on which machine |
| `presetSelection`, `PRESET_SLUGS`, … (`model-presets`) | The named model presets of workflow steps |
| `priceFor` (`model-prices`) | List prices per 1M tokens |
| `compatibleReasoningLevel`, `compatibleServiceTier` (`picker-compat`) | Fits a saved choice to the provider that is picked now |
| `writerExecutionSelection`, `bbServiceTier`, … (`jev-reasoning`) | The writer's reasoning level and tier mapping |

Pure data and functions; the server fills the catalog from `bb.sdk.providers`, the browser only reads it. Depends on nothing.
