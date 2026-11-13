// Only the node project (files that share the plugin modules with the files before them, vitest.config.ts) runs this setup.
// Module state an earlier file left behind and a later file relies on being empty is cleared here, one line per known case.
