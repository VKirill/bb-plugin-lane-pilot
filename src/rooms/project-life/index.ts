// Public API of project-life: what other rooms import. Everything else in this room is private.
// Add a name here to make it public; scripts/refactor/barrels.ts wrote the first version from the existing imports.
export { instructionForms } from "./instruction-forms";
export type { InstructionForms, InstructionProject } from "./instruction-forms";
export { acceptedOnboardingEvidence } from "./onboarding";
export type { OnboardingAcceptedEvidence, OnboardingInputPage } from "./onboarding";
export { isAllowedProjectLifePath, shouldTriggerProjectLife } from "./project-life";
