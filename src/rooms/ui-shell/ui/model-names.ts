/** `acp-cursor` is shown as `cursor`. */
export const providerShort = (id: string | null): string => (id ? id.replace(/^acp-/, "") : "");
/** `router9/ag/gemini-3.8-flash-high` is shown as `gemini-3.8-flash-high`. */
export const modelShort = (model: string | null): string => (model ? model.slice(model.lastIndexOf("/") + 1) : "");
