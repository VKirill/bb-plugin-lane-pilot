import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../contracts";
import type { ModelCatalog } from "@lane-pilot/models";

/** The hub's providers and models; null while it is read, or when no machine answered. */
export function useModelCatalog(projectId?: string | null): ModelCatalog | null {
  const rpc = useRpc<typeof rpcContract>() as unknown as { call: (method: string, input: unknown) => Promise<unknown> };
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  useEffect(() => {
    let live = true;
    // With the project the answer says which machine its helpers run on: the pickers list and check that machine's models.
    void Promise.resolve(rpc.call("workflow_model_catalog", projectId ? { projectId } : {})).then((value) => { if (live && value) setCatalog(value as ModelCatalog); }, () => undefined);
    return () => { live = false; };
  }, [rpc, projectId]);
  return catalog;
}
