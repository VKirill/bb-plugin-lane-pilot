import type { ExperimentalHostRpcHandlers } from "@get-bb/plugin-sdk";
import { hostContract } from "../../contracts";
import { buildDocsAnchors, buildDocsFlows, commitDocs, docsDepth as readDocsDepth, docsLineCounts as readDocsLineCounts, docsStaleness, docsWorthinessFacts as readDocsWorthinessFacts, gitDocsScope as readGitDocsScope, verifyDocsCitations } from "../../docs";
import { jevSource } from "./judges";

export const gitDocsScope: ExperimentalHostRpcHandlers<typeof hostContract>["gitDocsScope"] = async (input) => ({
  hostId:process.env.BB_HOST_ID??input.requestedHostId,
  ...await readGitDocsScope({projectCwd:input.projectCwd,sinceEpochMs:input.sinceEpochMs,base:input.base,docsDir:input.docsDir,exclude:input.exclude}),
});

export const docsWorthinessFacts: ExperimentalHostRpcHandlers<typeof hostContract>["docsWorthinessFacts"] = async (input) => ({
  hostId:process.env.BB_HOST_ID??input.requestedHostId, ...await readDocsWorthinessFacts({projectCwd:input.projectCwd}),
});

export const docsAnchors: ExperimentalHostRpcHandlers<typeof hostContract>["docsAnchors"] = async (input) => ({
  hostId:process.env.BB_HOST_ID??input.requestedHostId, ...await buildDocsAnchors({projectCwd:input.projectCwd,pages:input.pages,prefix:input.prefix,exclude:input.exclude,workspaces:input.workspaces,...jevSource(input)}),
});

export const docsFlows: ExperimentalHostRpcHandlers<typeof hostContract>["docsFlows"] = async (input) => ({
  hostId:process.env.BB_HOST_ID??input.requestedHostId, ...await buildDocsFlows({projectCwd:input.projectCwd,workspaces:input.workspaces,keep:input.keep,...jevSource(input)}),
});

export const docsDepth: ExperimentalHostRpcHandlers<typeof hostContract>["docsDepth"] = async (input) => ({
  hostId:process.env.BB_HOST_ID??input.requestedHostId, ...await readDocsDepth({projectCwd:input.projectCwd,pages:input.pages,core:input.core,...jevSource(input)}),
});

export const docsVerifyCitations: ExperimentalHostRpcHandlers<typeof hostContract>["docsVerifyCitations"] = async (input) => ({
  hostId:process.env.BB_HOST_ID??input.requestedHostId, ...await verifyDocsCitations({projectCwd:input.projectCwd,pages:input.pages,related:input.related,...jevSource(input)}),
});

export const docsStalenessHandler: ExperimentalHostRpcHandlers<typeof hostContract>["docsStaleness"] = async (input) => ({
  hostId:process.env.BB_HOST_ID??input.requestedHostId,
  ...await docsStaleness({projectCwd:input.projectCwd,base:input.base,changed:input.changed,pages:input.pages,...jevSource(input)}),
});

export const docsLineCounts: ExperimentalHostRpcHandlers<typeof hostContract>["docsLineCounts"] = async (input) => ({
  hostId:process.env.BB_HOST_ID??input.requestedHostId,
  counts:await readDocsLineCounts({projectCwd:input.projectCwd,files:input.files}),
});

export const gitCommitDocs: ExperimentalHostRpcHandlers<typeof hostContract>["gitCommitDocs"] = async (input) => ({
  hostId:process.env.BB_HOST_ID??input.requestedHostId,
  ...await commitDocs({projectCwd:input.projectCwd,paths:input.paths,message:input.message}),
});
