/**
 * Bonus-Buy ("buy these together and save") deals as delivered inline with a
 * catalog `products/filter` response under the `bonusBuys` map.
 *
 * The purchase threshold ("Buy 2") and the saving ("Save 20%") live only in the
 * human `name`/`longDescription` text — `discountValue` is 0 for the `other`
 * (complex) discount type that these use. So this normalizer deliberately does
 * NOT invent a numeric threshold or "X of N" progress: it exposes the human
 * terms plus the raw codes and the qualifying member set, and nothing more.
 */

interface CodeRef {
  code?: string;
}

/** Raw bonus-buy deal as returned by the catalog (`bonusBuys` map value). */
export interface RawBonusBuy {
  id: string;
  code?: string;
  promotionId?: string;
  name?: string;
  shortDescription?: string;
  longDescription?: string;
  discountType?: CodeRef;
  discountValue?: number;
  memberType?: CodeRef;
  offerType?: CodeRef;
  startDate?: number;
  endDate?: number;
  products?: string[];
  productIds?: string[];
  channelSpecificPromotions?: Record<string, unknown>;
  channelIndicator?: string;
  [key: string]: unknown;
}

/** Normalized bonus-buy deal used throughout the CLI. */
export interface BonusBuy {
  id: string;
  code?: string;
  promotionId?: string;
  /** Short human heading, e.g. "Buy 2 & Save 20%". */
  title: string;
  /** Full human terms, e.g. "Buy Any 2 Selected Bouquet Flowers And Save 20%". */
  description: string;
  /** Raw discount-type code (`other` == complex; `discountValue` then 0). */
  discountTypeCode?: string;
  discountValue?: number;
  /** True when the deal is Xtra-Savings-members only (`fox_members`). */
  membersOnly: boolean;
  offerTypeCode?: string;
  startDate?: number;
  endDate?: number;
  /** `endDate` rendered as an ISO-8601 string, when present. */
  validUntil?: string;
  /** Mongo product ids of the qualifying member set (NOT a threshold). */
  memberProductIds: string[];
  /** Article numbers of the qualifying member set. */
  memberArticleNumbers: string[];
  channelIndicator?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * When a deal carries a full sixty60-specific override object under
 * `channelSpecificPromotions.sixty60`, its fields take precedence over the
 * top-level ones. In the live schema that key is usually a boolean channel flag,
 * in which case there is nothing to override and the top-level fields are used.
 */
function sixty60Source(raw: RawBonusBuy): RawBonusBuy {
  const override = raw.channelSpecificPromotions?.sixty60;
  if (isPlainObject(override)) {
    return { ...raw, ...(override as Partial<RawBonusBuy>) };
  }
  return raw;
}

function isoOrUndefined(epochMs?: number): string | undefined {
  if (typeof epochMs !== "number" || !Number.isFinite(epochMs)) return undefined;
  const d = new Date(epochMs);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** Normalize one raw bonus-buy deal into the CLI's {@link BonusBuy} shape. */
export function normalizeBonusBuy(raw: RawBonusBuy): BonusBuy {
  const src = sixty60Source(raw);
  return {
    id: src.id,
    code: src.code,
    promotionId: src.promotionId,
    title: src.name ?? "",
    description: src.longDescription ?? src.shortDescription ?? src.name ?? "",
    discountTypeCode: src.discountType?.code,
    discountValue: typeof src.discountValue === "number" ? src.discountValue : undefined,
    membersOnly: src.memberType?.code === "fox_members",
    offerTypeCode: src.offerType?.code,
    startDate: src.startDate,
    endDate: src.endDate,
    validUntil: isoOrUndefined(src.endDate),
    memberProductIds: Array.isArray(src.productIds) ? src.productIds : [],
    memberArticleNumbers: Array.isArray(src.products) ? src.products : [],
    channelIndicator: src.channelIndicator,
  };
}

/** Normalize a `bonusBuys` map (id → raw deal) into a `BonusBuy[]`. */
export function normalizeBonusBuys(
  map: Record<string, RawBonusBuy> | undefined | null
): BonusBuy[] {
  if (!map || typeof map !== "object") return [];
  return Object.values(map)
    .filter((d): d is RawBonusBuy => isPlainObject(d) && typeof d.id === "string")
    .map(normalizeBonusBuy);
}
