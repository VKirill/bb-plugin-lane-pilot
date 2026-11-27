export const CARD_KINDS = ["niche", "brand", "contact", "platform"] as const;
export type CardKind = (typeof CARD_KINDS)[number];

export const CARD_SOURCE_KINDS = ["owner", "url", "file", "run"] as const;
export type CardSourceKind = (typeof CARD_SOURCE_KINDS)[number];

export interface CardSource {
  kind: CardSourceKind;
  ref: string;
}

export const cardConcept = (kind: CardKind, key: string): string =>
  `card:${kind}:${key.trim().toLowerCase()}`;

export const CARD_LIMITS = {
  perLoad: 4,
  chars: 1200,
  defaultTtlDays: {
    niche: 90,
    brand: 180,
    contact: 365,
    platform: 60,
  },
} as const;

export interface CardRef {
  kind: CardKind;
  key: string;
}

export interface Card {
  id: string;
  projectId: string | null;
  kind: CardKind;
  key: string;
  content: string;
  verifiedAt: number;
  source: CardSource;
  validUntil: number;
  trust: "confirmed" | "observed";
  stale: boolean;
}
