import {
  CheckersAPI,
  type RawCatalogProduct,
  type RawDepartmentOption,
} from "./api.js";
import { normalizeBonusBuy, normalizeBonusBuys, type BonusBuy } from "./promotions.js";

/**
 * Normalization boundary for the discovery/offers commands, mirroring
 * src/lib/orders.ts: every value a command emits is rendered from one of the
 * DTOs below and NOTHING else. Mappers copy allowlisted fields field-by-field —
 * no object spreads, no raw-envelope passthrough, no index signatures — so the
 * PII/secret fields a raw catalog product or promotion may carry cannot escape.
 * Bonus-buy deals reuse the shared {@link BonusBuy} DTO (no index signature) via
 * the promotions normalizer rather than being re-mapped here.
 */

// ─── DTOs (allowlisted output shapes — no index signatures, ever) ────────────

/** A product surfaced by a personalized-promotions feed. Minimal, no PII. */
export interface OfferProductDTO {
  productId: string;
  name: string;
  /** Price in cents, or null when the catalog did not resolve it. */
  price: number | null;
  imageId?: string;
  /** Ids of the bonus-buy deals this product qualifies for (copied, not aliased). */
  bonusBuyIds?: string[];
}

/** `discover` output: personalized promotions plus the products they surface. */
export interface DiscoverDTO {
  promotions: BonusBuy[];
  products: OfferProductDTO[];
}

/** A search-scoped category (department facet). */
export interface CategoryDTO {
  id: string;
  name: string;
  /** Number of matching products in this category, or null when absent. */
  count: number | null;
}

// ─── Pure mappers (exported for redaction/shape tests) ───────────────────────

export function mapOfferProduct(raw: RawCatalogProduct): OfferProductDTO {
  const dto: OfferProductDTO = {
    productId: raw.id ?? "",
    name: raw.name ?? raw.displayName ?? "",
    price: typeof raw.priceWithoutDecimal === "number" ? raw.priceWithoutDecimal : null,
  };
  if (typeof raw.imageId === "string") dto.imageId = raw.imageId;
  if (Array.isArray(raw.bonusBuyIds)) {
    const ids = raw.bonusBuyIds.filter((v): v is string => typeof v === "string");
    if (ids.length > 0) dto.bonusBuyIds = ids;
  }
  return dto;
}

export function mapCategory(raw: RawDepartmentOption): CategoryDTO {
  return {
    id: raw.displayCategoryId ?? raw.id ?? "",
    name: raw.name ?? "",
    count: typeof raw.count === "number" ? raw.count : null,
  };
}

// ─── Orchestration (fetch raw → map to DTOs; commands call only these) ───────

/** Personalized offers ("offers for you") as normalized bonus-buy deals. */
export async function getOffers(api: CheckersAPI = new CheckersAPI()): Promise<BonusBuy[]> {
  const raw = await api.getOffersForYou();
  return normalizeBonusBuys(raw.promotions);
}

/**
 * Personalized promotions ("promotions for you"). Membership is derived from the
 * profile unless `isMember` is supplied (e.g. from a `--member/--no-member` flag).
 */
export async function getDiscover(
  isMember?: boolean,
  api: CheckersAPI = new CheckersAPI()
): Promise<DiscoverDTO> {
  const member = isMember ?? (await api.isXtraSavingsMember());
  const raw = await api.getPromotionsForYou(member);
  const promotions = (raw.bonusBuys ?? [])
    .filter((d): d is NonNullable<typeof d> => Boolean(d) && typeof d.id === "string")
    .map(normalizeBonusBuy);
  const products = (raw.items ?? []).map(mapOfferProduct);
  return { promotions, products };
}

/** Search-scoped categories (department facets) for a query term. */
export async function getCategories(
  query: string,
  api: CheckersAPI = new CheckersAPI()
): Promise<CategoryDTO[]> {
  const raw = await api.getFilterOptions(query);
  return (raw.filterOptions?.departmentOptions ?? []).map(mapCategory);
}
