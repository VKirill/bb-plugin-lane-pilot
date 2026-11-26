import type { ExperimentalHostRpcHandlers } from "@get-bb/plugin-sdk";
import { currentHostId } from "@lane-pilot/kit";
import { hostContract } from "../../contracts";
import { commitDocs, docsLineCounts as readDocsLineCounts, docsWorthinessFacts as readDocsWorthinessFacts, gitDocsScope as readGitDocsScope } from "../../docs";

export const gitDocsScope: ExperimentalHostRpcHandlers<typeof hostContract>["gitDocsScope"] = async (input) => ({
  hostId:currentHostId(input.requestedHostId),
  ...await readGitDocsScope({projectCwd:input.projectCwd,sinceEpochMs:input.sinceEpochMs,base:input.base,docsDir:input.docsDir,exclude:input.exclude}),
});

export const docsWorthinessFacts: ExperimentalHostRpcHandlers<typeof hostContract>["docsWorthinessFacts"] = async (input) => ({
  hostId:currentHostId(input.requestedHostId), ...await readDocsWorthinessFacts({projectCwd:input.projectCwd}),
});

export const docsAnchors: ExperimentalHostRpcHandlers<typeof hostContract>["docsAnchors"] = async (input) => ({
  hostId: currentHostId(input.requestedHostId),
  briefPath: "",
  anchors: 0,
  productFiles: [],
  core: [],
  tables: [],
  deploy: false,
});

export const docsFlows: ExperimentalHostRpcHandlers<typeof hostContract>["docsFlows"] = async (input) => ({
  hostId: currentHostId(input.requestedHostId),
  briefPath: "",
  routes: 0,
  flows: [],
});

export const docsLineCounts: ExperimentalHostRpcHandlers<typeof hostContract>["docsLineCounts"] = async (input) => ({
  hostId:currentHostId(input.requestedHostId),
  counts:await readDocsLineCounts({projectCwd:input.projectCwd,files:input.files}),
});

export const gitCommitDocs: ExperimentalHostRpcHandlers<typeof hostContract>["gitCommitDocs"] = async (input) => ({
  hostId:currentHostId(input.requestedHostId),
  ...await commitDocs({projectCwd:input.projectCwd,paths:input.paths,message:input.message}),
});
