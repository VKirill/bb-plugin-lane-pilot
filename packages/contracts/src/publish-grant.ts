export const PUBLISH_GRANT_VIAS = ["desk", "cli", "chat"] as const;
export type PublishGrantVia = (typeof PUBLISH_GRANT_VIAS)[number];

export const EVOLUTION_RECEIPT_DECISIONS = ["promote", "demote"] as const;
export type EvolutionReceiptDecision = (typeof EVOLUTION_RECEIPT_DECISIONS)[number];

export type PublishGrant = {
  kind: "owner";
  draftId: string;
  draftSha256: string;
  grantedAt: number;
  via: PublishGrantVia;
};

export type EvolutionReceipt = {
  kind: "evolution";
  draftId: string;
  draftSha256: string;
  trialId: string;
  decision: EvolutionReceiptDecision;
  issuedAt: number;
};

export type PublishAuthority = PublishGrant | EvolutionReceipt;
