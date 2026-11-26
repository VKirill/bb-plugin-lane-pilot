// Public API of owner-presence/server: the sweep of the machines' marks and the hold it answers.
export { observeOwnerDispatch } from "./handlers/dispatch-hook";
export { mountOwnerPresence } from "./handlers/presence-lifecycle";
export { room } from "./room";
export { bindOwnerPresence, createOwnerPresence } from "./services/presence-service";
export type { OwnerPresenceApi } from "./services/presence-service";
