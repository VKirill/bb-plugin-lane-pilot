export type EmergencyTrigger = {
  state:string;
  reason?:string|null;
  stopConfirmed?:boolean;
  /** The same writer already failed this check the same way: one next writer may take the task. */
  checkEscalation?:boolean;
};

export type EmergencyFallbackDecision =
  | {run:true; reason:string}
  | {run:false; reason:string};

/** Permit one emergency writer only after the original writer is known terminal. */
export function emergencyFallbackDecision(trigger:EmergencyTrigger):EmergencyFallbackDecision {
  if (trigger.state === "provider_error" || trigger.state === "empty_output") {
    return {run:true,reason:`primary_${trigger.state}`};
  }
  if (trigger.state === "timeout" && trigger.stopConfirmed === true) {
    return {run:true,reason:"primary_timeout_stopped"};
  }
  if (trigger.state === "spawn_rejected" && typeof trigger.reason === "string"
    && /^(writer_provider_unavailable:|writer_model_unavailable:|writer_service_tier_unavailable:|writer_live_catalog_unavailable$)/.test(trigger.reason)) {
    return {run:true,reason:trigger.reason};
  }
  if (trigger.checkEscalation && trigger.state === "validation_failed" && /^verification failed\b/.test(trigger.reason ?? "")) {
    return {run:true,reason:"repeated_check"};
  }
  return {run:false,reason:`not_safe_for_emergency_fallback:${trigger.state}`};
}

export function sameWriterSelection(primary:{providerId:string;model:string}, emergency:{providerId:string;model:string}):boolean {
  return primary.providerId === emergency.providerId && primary.model === emergency.model;
}
