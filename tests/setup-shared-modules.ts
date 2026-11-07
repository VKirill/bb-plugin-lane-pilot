// Only the node project (files that share the plugin modules with the files before them, vitest.config.ts) runs this setup.
// Module state an earlier file left behind and a later file relies on being empty is cleared here, one line per known case.
import { setJevForTests } from "@lane-pilot/jev";

// A test that starts the plugin and never disposes it leaves its Jev installed (packages/jev/src/runtime.ts); a self-repair tick in the
// next file then judged with it.
setJevForTests(null);

// A provider limit one test's helper answered with would take that provider off the next test's picks (spawn-model.ts, seen limits).
import { beforeEach } from "vitest";
import { resetSeenLimits } from "../src/rooms/platform/server/spawn-model";
beforeEach(() => resetSeenLimits());
