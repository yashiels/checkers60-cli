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
  active?: boolean;
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
  /** True ONLY when the raw deal is explicitly `active: true`. */
  active: boolean;
  /** True ONLY on a positive sixty60 signal (channel flag true, or an override object). */
  availableOnSixty60: boolean;
  offerTypeCode?: string;
  /** Finite epoch-ms, `null` when present-but-invalid, `undefined` when absent. */
  startDate?: number | null;
  /** Finite epoch-ms, `null` when present-but-invalid, `undefined` when absent. */
  endDate?: number | null;
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
 *
 * The override is resolved per-field (never by spreading the raw envelope), so
 * an override key present with any value wins — matching the previous merge
 * semantics — while no unknown raw field can leak through.
 */
function sixty60Override(raw: RawBonusBuy): Partial<RawBonusBuy> {
  const override = raw.channelSpecificPromotions?.sixty60;
  return isPlainObject(override) ? (override as Partial<RawBonusBuy>) : {};
}

/** Pick a field from the sixty60 override when it declares the key, else the raw value. */
function preferred<K extends keyof RawBonusBuy>(
  override: Partial<RawBonusBuy>,
  raw: RawBonusBuy,
  key: K
): RawBonusBuy[K] {
  return (key in override ? override[key] : raw[key]) as RawBonusBuy[K];
}

/** Copy an array of strings, dropping any non-string entry (never aliases the raw array). */
function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Normalize a date boundary: a finite epoch-ms number passes through; a value
 * that is PRESENT but not a finite number — `null` (e.g. an override nulling out
 * a valid top-level date), NaN, a string, ±Infinity — becomes `null` so the
 * active check can fail CLOSED on it; only an absent field (`undefined`) stays
 * `undefined` (unbounded on that side).
 */
function epochBound(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isoOrUndefined(epochMs?: number | null): string | undefined {
  if (typeof epochMs !== "number" || !Number.isFinite(epochMs)) return undefined;
  const d = new Date(epochMs);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** Normalize one raw bonus-buy deal into the CLI's {@link BonusBuy} shape. */
export function normalizeBonusBuy(raw: RawBonusBuy): BonusBuy {
  const ov = sixty60Override(raw);
  const p = <K extends keyof RawBonusBuy>(key: K) => preferred(ov, raw, key);
  const discountValue = p("discountValue");
  return {
    id: p("id"),
    code: p("code"),
    promotionId: p("promotionId"),
    title: p("name") ?? "",
    description: p("longDescription") ?? p("shortDescription") ?? p("name") ?? "",
    discountTypeCode: p("discountType")?.code,
    discountValue: typeof discountValue === "number" ? discountValue : undefined,
    membersOnly: p("memberType")?.code === "fox_members",
    active: p("active") === true,
    availableOnSixty60:
      raw.channelSpecificPromotions?.sixty60 === true ||
      isPlainObject(raw.channelSpecificPromotions?.sixty60),
    offerTypeCode: p("offerType")?.code,
    startDate: epochBound(p("startDate")),
    endDate: epochBound(p("endDate")),
    validUntil: isoOrUndefined(epochBound(p("endDate"))),
    memberProductIds: stringList(p("productIds")),
    memberArticleNumbers: stringList(p("products")),
    channelIndicator: p("channelIndicator"),
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
