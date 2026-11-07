export type StageWriterSource = "stage" | "writer-profile" | "prototype";

export type StageWriterSelection = {
  requestedProviderId: string;
  requestedModel: string;
  providerId: string;
  model: string;
  source: StageWriterSource;
};

function nonempty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function resolveStageWriterSelection(input: {
  settings: Record<string, unknown>;
  config: { writerProviderId: string; writerModel: string };
  stageProviderKey?: string;
  stageModelKey?: string;
}): StageWriterSelection {
  const stageProvider = input.stageProviderKey ? nonempty(input.settings[input.stageProviderKey]) : null;
  const stageModel = input.stageModelKey ? nonempty(input.settings[input.stageModelKey]) : null;
  const profileProvider = nonempty(input.settings["writer.provider"]);
  const profileModel = nonempty(input.settings["writer.model"]);
  const providerId = stageProvider ?? profileProvider ?? input.config.writerProviderId;
  const model = stageModel ?? profileModel ?? input.config.writerModel;
  const source: StageWriterSource = stageProvider || stageModel
    ? "stage"
    : profileProvider || profileModel
      ? "writer-profile"
      : "prototype";
  return {
    requestedProviderId: providerId,
    requestedModel: model,
    providerId,
    model,
    source,
  };
}
