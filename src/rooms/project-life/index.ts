// Public API of project-life: what other rooms import. Everything else in this room is private.
// Add a name here to make it public; scripts/refactor/barrels.ts wrote the first version from the existing imports.
export { acceptedOnboardingEvidence } from "./onboarding";
export type { OnboardingAcceptedEvidence, OnboardingInputPage } from "./onboarding";
export { isAllowedProjectLifePath } from "./project-life";
export type { ProjectLifeTaskSummary } from "./project-life";
