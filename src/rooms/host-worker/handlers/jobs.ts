import type { ExperimentalHostRpcHandlers } from "@get-bb/plugin-sdk";
import { currentHostId } from "@lane-pilot/kit";
import { hostContract } from "../../contracts";
import { cancelHostJob, hostJobStatus, startHostJob } from "../jobs";

/** Background jobs (B4): ordinary short calls; the long work runs in a process of its own, see src/jobs.ts. */
export const jobStart: ExperimentalHostRpcHandlers<typeof hostContract>["jobStart"] = async (input) => ({
  hostId:currentHostId(input.requestedHostId),
  jobId:await startHostJob({kind:input.kind,input:input.input,timeoutSec:input.timeoutSec,...(input.key?{key:input.key}:{})}),
});

export const jobStatus: ExperimentalHostRpcHandlers<typeof hostContract>["jobStatus"] = async (input) => ({
  hostId:currentHostId(input.requestedHostId),
  jobId:input.jobId,
  ...await hostJobStatus(input.jobId),
});

export const jobCancel: ExperimentalHostRpcHandlers<typeof hostContract>["jobCancel"] = async (input) => ({
  hostId:currentHostId(input.requestedHostId),
  jobId:input.jobId,
  cancelled:await cancelHostJob(input.jobId),
});
