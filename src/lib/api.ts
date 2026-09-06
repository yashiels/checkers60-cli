import { randomBytes } from "node:crypto";
import {
  CONFIG,
  storeIdList,
  storeIdJsonArray,
  type StoreContext,
} from "./config.js";
import { TokenManager, type SessionContext } from "./credentials.js";
import { getDeviceId } from "./runtime.js";
import { request, APIError } from "./http.js";
import type { CartSnapshot, PlanSnapshot } from "./confirm.js";
import {
  normalizeBonusBuys,
  type BonusBuy,
  type RawBonusBuy,
} from "./promotions.js";

export { APIError };
export type { BonusBuy } from "./promotions.js";

// ─── Types ─────────────────────────────────────────────────────────────────

/** Raw product as returned by the catalog API. */
export interface RawCatalogProduct {
  id: string;
  name?: string;
  displayName?: string;
  priceWithoutDecimal?: number; // cents (5999 = R59.99)
  priceFactor?: number;
  storeId?: string;
  serviceOptionId?: string;
  imageId?: string;
  stockOnHand?: number;
  maxPerOrder?: number;
  active?: boolean;
  ranged?: boolean;
  storeProductActive?: boolean;
  promotions?: unknown[];
  [key: string]: unknown;
}

/** Normalized product used throughout the CLI. Prices are in cents. */
export interface Product {
  id: string;
  name: string;
  price?: number; // cents
  priceFactor?: number;
  storeId?: string;
  serviceOptionId?: string;
  imageId?: string;
  stock?: number;
  maxPerOrder?: number;
  active?: boolean;
  /** True when the product is on promotion (derived from the catalog signals). */
  onPromotion?: boolean;
  /** Pre-promotion price in cents, when discounted. */
  oldPrice?: number;
  /** Ids of the bonus-buy deals this product qualifies for. */
  bonusBuyIds?: string[];
  /** Raw discount amount reported by the catalog (cents), when present. */
  discount?: number;
  /** Raw `isOnPromotion` flag from the catalog, preserved verbatim. */
  isOnPromotion?: boolean;
  [key: string]: unknown;
}

export interface CartLineItem {
  id: string;
  productId: string;
  quantity: number;
  price: number; // cents
  priceFactor?: number;
  previousPrice?: number;
  storeId?: string;
  status?: string;
  serviceOptionId?: string;
  [key: string]: unknown;
}

export interface CartState {
  carts: CartEnvelope[];
  cartId: string | null;
  cartVersion: number;
  items: CartLineItem[];
}

interface CartEnvelope {
  item?: {
    id?: string;
    cartVersion?: number;
    serviceOptionId?: string;
    deliveryAddressId?: string;
    lineItems?: CartLineItem[];
  };
}

export interface CartItemInput {
  productId: string;
  quantity: number;
  price: number; // cents
  priceFactor?: number;
  storeId?: string;
  lineItemId?: string;
}

export interface Address {
  _id?: string;
  identifier?: string;
  name?: string;
  fullAddress?: string;
  [key: string]: unknown;
}

export interface OrderTotal {
  cartTotal?: number;
  deliveryFee?: number;
  totalOwing?: number;
  creditApplied?: number;
  requiresCardPayment?: boolean;
  [key: string]: unknown;
}

export interface Order {
  status?: { orderStatus?: string };
  total?: OrderTotal;
  [key: string]: unknown;
}

export interface OrderGroup {
  reference?: string;
  orders?: Order[];
  [key: string]: unknown;
}

export interface UserProfile {
  firstName?: string;
  lastName?: string;
  mobileNumber?: string;
  email?: string;
  [key: string]: unknown;
}

export interface DeliverySlot {
  start?: number | string;
  end?: number | string;
  available?: boolean;
  [key: string]: unknown;
}

export interface PreOrderResult {
  slots: DeliverySlot[];
  asap: boolean;
  totals?: unknown;
  raw?: unknown;
}

// ─── Raw domain envelopes (orders.ts is the normalization boundary) ──────────
// These raw shapes are consumed ONLY by src/lib/orders.ts, which maps them to
// allowlisted DTOs. Commands never import them. Fields are intentionally loose
// (optional, `unknown` for anything PII-bearing) so the mapper stays the single
// place that decides what escapes.

export interface RawUserProductScore {
  productId?: string;
  count?: number;
  score?: number;
}

export interface RawOrderItem {
  productId?: string;
  quantity?: number;
  price?: number;
  name?: string;
  productMinInfo?: { name?: string; displayName?: string };
}

export interface RawCompletedOrder {
  id?: string;
  createdOn?: number;
  serviceOptionId?: string;
  status?: { orderStatus?: string; name?: string };
  orderItems?: RawOrderItem[];
  /** PII-bearing (driver, coords, address) — never read into a DTO. */
  orderDelivery?: unknown;
}

/** Raw personalized-offers envelope (`offers-for-you`): a bonus-buy map. */
export interface RawOffersForYou {
  promotions?: Record<string, RawBonusBuy>;
}

/** Raw personalized-promotions envelope (`promotions/forYou`): deals + products. */
export interface RawPromotionsForYou {
  bonusBuys?: RawBonusBuy[];
  items?: RawCatalogProduct[];
}

/** Raw department facet from `filter/options` (a search-scoped category). */
export interface RawDepartmentOption {
  displayCategoryId?: string;
  id?: string;
  name?: string;
  count?: number;
}

/** Raw `filter/options` envelope — only the department facets are read. */
export interface RawFilterOptions {
  filterOptions?: { departmentOptions?: RawDepartmentOption[] };
}

/** One loyalty card as returned inside the DSL profile. Only membership is derived. */
export interface RawLoyaltyCard {
  active?: boolean;
  theme?: string;
}

export interface RawFirstDeliverySlots {
  allowASAPDelivery?: boolean;
  firstAvailableSlotSixtyMin?: { startTime?: string; endTime?: string } | null;
  firstAvailableSlotOneDay?: { startTime?: string; endTime?: string } | null;
  deliveryFeesAndMinimumOrderValues?: Record<
    string,
    { serviceOption?: string; deliveryFee?: number; minimumOrderValue?: number }
  >;
}

/** Account balances from customer-profile/v2. Amounts are cents (balanceFactor 100). */
export interface RawAccountBalances {
  balanceAmount?: number;
  balanceFactor?: number;
}

/**
 * Membership + wallet slice of the customer-profile/v2 `userProfile`. Only the
 * fields orders.ts maps into a DTO are typed here; the same envelope carries
 * secrets (xtraSavingsAccessToken/IdToken), payment info, email and full-PII
 * addresses that the mapper never reads.
 */
export interface RawCustomerProfile {
  IsXtraSavingsCustomer?: boolean;
  xTraSavingsCardNumber?: string;
  account?: RawAccountBalances;
}

/**
 * One saved payment card from `customers/{userId}/cards`. Only issuer, masked
 * number, expiry and the default flag are ever mapped into a DTO. `token`,
 * `cardholderName`, `cardHasBeenUsed` and `mostRecentlyUsed` are PII/secret and
 * are typed here ONLY to document that orders.ts must never read them.
 */
export interface RawCard {
  issuer?: string;
  maskedCardNumber?: string;
  expiryMonth?: string | number;
  expiryYear?: string | number;
  isDefault?: boolean;
  /** Secret — never mapped into a DTO. */
  token?: string;
  /** PII — never mapped into a DTO. */
  cardholderName?: string;
  cardHasBeenUsed?: boolean;
  mostRecentlyUsed?: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Generate a MongoDB-style ObjectId (matches the app's line-item ids). */
export function objectId(): string {
  const ts = Math.floor(Date.now() / 1000)
    .toString(16)
    .padStart(8, "0");
  return ts + randomBytes(8).toString("hex");
}

/** Normalize a raw catalog product into the CLI's Product shape. */
export function mapCatalogProduct(raw: RawCatalogProduct): Product {
  return {
    id: raw.id,
    name: raw.name ?? raw.displayName ?? "",
    price: raw.priceWithoutDecimal,
    priceFactor: raw.priceFactor ?? 100,
    storeId: raw.storeId,
    serviceOptionId: raw.serviceOptionId,
    imageId: raw.imageId,
    stock: raw.stockOnHand,
    maxPerOrder: raw.maxPerOrder,
    active: Boolean(raw.active && raw.ranged && raw.storeProductActive),
    bonusBuyIds: Array.isArray(raw.bonusBuyIds)
      ? (raw.bonusBuyIds as string[])
      : undefined,
    discount: typeof raw.discount === "number" ? raw.discount : undefined,
    isOnPromotion:
      typeof raw.isOnPromotion === "boolean" ? raw.isOnPromotion : undefined,
    ...derivePromotion(raw),
  };
}

/**
 * The catalog has no `promotions` array (the old code read a field that never
 * exists, so the promo badge never showed). Promotion state comes from
 * `isOnPromotion`, a discounted `oldPrice`, or membership in a bonus-buy deal.
 */
function derivePromotion(raw: RawCatalogProduct): {
  onPromotion?: boolean;
  oldPrice?: number;
} {
  const oldPrice = typeof raw.oldPrice === "number" ? raw.oldPrice : undefined;
  const price = raw.priceWithoutDecimal;
  const bonusBuyIds = raw.bonusBuyIds;
  const onPromotion =
    raw.isOnPromotion === true ||
    (Array.isArray(bonusBuyIds) && bonusBuyIds.length > 0) ||
    (oldPrice !== undefined && typeof price === "number" && oldPrice > price);
  return { onPromotion: onPromotion || undefined, oldPrice };
}

// ─── Client ────────────────────────────────────────────────────────────────

interface CatalogResponse {
  products?: RawCatalogProduct[];
  totalCount?: number;
  bonusBuys?: Record<string, RawBonusBuy>;
}

/** Search results plus the true total match count reported by the catalog. */
export interface SearchResult {
  products: Product[];
  total: number;
  /** Bonus-buy deals attached to this result set (may be empty). */
  deals: BonusBuy[];
}

/** Deals for a query, plus any products the deals search returned. */
export interface DealsResult {
  deals: BonusBuy[];
  products: Product[];
}

/** A raw product together with the deals it qualifies for. */
export interface ProductWithDeals {
  raw?: RawCatalogProduct;
  deals: BonusBuy[];
}

interface CartsResponse {
  carts?: CartEnvelope[];
}

/**
 * Checkers Sixty60 mobile-app API client. Auth is handled by an internal
 * TokenManager; every call resolves the committed session snapshot from disk
 * (fail-fast when logged out or expired — there is no refresh, and OTP is never
 * triggered automatically).
 */
export class CheckersAPI {
  readonly tokens: TokenManager;

  constructor(tokens?: TokenManager) {
    this.tokens = tokens ?? new TokenManager();
  }

  /**
   * Headers required by the sixty60 microservices (orders-api, catalog,
   * returns, payments). Identity comes ENTIRELY from the {@link SessionContext}
   * snapshot — never from the mutable CONFIG singleton. `mobilenumber`/`email`/
   * `x-api-key` are intentionally absent: they are not sent to these endpoints.
   */
  private sixty60Headers(
    session: SessionContext,
    stores?: StoreContext[]
  ): Record<string, string> {
    return {
      authorization: `Bearer ${session.sessionToken}`,
      channel: CONFIG.CHANNEL,
      "channel-os": CONFIG.APP_VERSION,
      "app-version": CONFIG.APP_VERSION,
      appversion: CONFIG.APP_VERSION_CODE,
      "istio-appversion": CONFIG.APP_VERSION_CODE,
      "device-id": getDeviceId(),
      "customer-id": session.uuid,
      userid: session.userId,
      "aws-cf-cd-storeid": storeIdList(stores), // comma-separated
      storeids: storeIdJsonArray(stores), // JSON array
      "istio-storeids": storeIdJsonArray(stores), // JSON array
    };
  }

  /**
   * Resolve the committed session snapshot and fail fast (before any orders-api
   * call) if the session token or its bound identity (userId/uuid) is missing.
   */
  private async session(): Promise<SessionContext> {
    const session = await this.tokens.getSession();
    if (!session.sessionToken || !session.userId || !session.uuid) {
      throw new Error(
        "Missing session identity. Log in again to populate it (checkers60 login)."
      );
    }
    return session;
  }

  private async headers(stores?: StoreContext[]): Promise<Record<string, string>> {
    const session = await this.session();
    return this.sixty60Headers(session, stores);
  }

  // ── Product search (catalog.sixty60.co.za) ──────────────────────────────

  /**
   * Shared catalog `products/filter` search by keyword. Returns the raw catalog
   * envelope (products + totalCount + bonusBuys) so callers can normalize.
   */
  private async filterSearch(
    query: string,
    opts: {
      page?: number;
      pageSize?: number;
      stores?: StoreContext[];
      dealsOnly?: boolean;
    } = {}
  ): Promise<CatalogResponse> {
    const { page = 0, pageSize = 20, stores, dealsOnly = false } = opts;
    const session = await this.session();
    const headers = this.sixty60Headers(session, stores);

    const body = {
      filter: {
        showAllDisplayVariants: false,
        showNotRangedProducts: false,
        productListSource: { search: query },
        paginationOptions: { page, pageSize },
        filterOptions: {
          dealsOnly,
          serviceOptions: [],
          brandOptions: [],
          departmentOptions: [],
          facetOptions: [],
          filterIds: [],
        },
      },
      userContext: {
        storeContexts: stores ?? CONFIG.DEFAULT_STORES,
        userId: session.userId,
        location: CONFIG.USER_LOCATION,
      },
    };

    const t = Date.now();
    const res = await request<CatalogResponse>(
      "POST",
      `${CONFIG.CATALOG_API}/api/v3/products/filter?isCarousel=false&includePromotions=true&promotionChannel=sixty60&isXtraSavings=true&isXtraSavingsMember=true&particularMemberBonusBuyIds=&t=${t}`,
      // The catalog decodes a JSON body; the sibling getProductDetails call
      // uses `json` too. Sending it form-urlencoded returns 400 and broke search.
      { headers, json: body, retry: "safe" }
    );
    return res.data ?? {};
  }

  async searchProducts(
    query: string,
    opts: { page?: number; pageSize?: number; stores?: StoreContext[] } = {}
  ): Promise<SearchResult> {
    const data = await this.filterSearch(query, { ...opts, dealsOnly: false });
    const products = (data.products ?? []).map(mapCatalogProduct);
    return {
      products,
      total: data.totalCount ?? products.length,
      deals: normalizeBonusBuys(data.bonusBuys),
    };
  }

  /**
   * Run a deals-only filter search (`filterOptions.dealsOnly=true`) and return
   * the normalized bonus-buy deals plus any products the search surfaced.
   */
  async getDeals(
    query: string,
    opts: {
      dealsOnly?: boolean;
      page?: number;
      pageSize?: number;
      stores?: StoreContext[];
    } = {}
  ): Promise<DealsResult> {
    const { dealsOnly = true, ...rest } = opts;
    const data = await this.filterSearch(query, { ...rest, dealsOnly });
    return {
      deals: normalizeBonusBuys(data.bonusBuys),
      products: (data.products ?? []).map(mapCatalogProduct),
    };
  }

  /** Shared catalog `products/filter` lookup by product id (one or many). */
  private async productFilter(ids: string[]): Promise<CatalogResponse> {
    if (ids.length === 0) return {};
    const headers = await this.headers();

    const body = {
      filter: {
        showAllDisplayVariants: true,
        showNotRangedProducts: true,
        productListSource: { productIds: ids },
        paginationOptions: { page: 0, pageSize: 50 },
        filterOptions: { dealsOnly: false },
      },
      userContext: { storeContexts: CONFIG.DEFAULT_STORES },
    };

    const res = await request<CatalogResponse>(
      "POST",
      `${CONFIG.CATALOG_API}/api/v3/products/filter?isCarousel=false&includePromotions=true&promotionChannel=sixty60&isXtraSavings=true`,
      { headers, json: body, retry: "safe" }
    );
    return res.data ?? {};
  }

  /** Fetch raw product details by ID (one or many). */
  async getProductDetails(productIds: string | string[]): Promise<RawCatalogProduct[]> {
    const ids = Array.isArray(productIds) ? productIds : [productIds];
    const data = await this.productFilter(ids);
    return data.products ?? [];
  }

  /**
   * Fetch raw products by id together with the bonus-buy deals attached to the
   * same response. Deals are returned whole; callers resolve each product's
   * `bonusBuyIds` against them.
   */
  async getProductsWithDeals(ids: string[]): Promise<DealsResult> {
    const data = await this.productFilter(ids);
    return {
      deals: normalizeBonusBuys(data.bonusBuys),
      products: (data.products ?? []).map(mapCatalogProduct),
    };
  }

  /** Product detail for a single id plus only the deals that product belongs to. */
  async getProductDetail(id: string): Promise<ProductWithDeals> {
    const data = await this.productFilter([id]);
    // Exact match only — never fall back to an unrelated product when the id is absent.
    const raw = data.products?.find((p) => p.id === id);
    const allDeals = normalizeBonusBuys(data.bonusBuys);
    const belongs = new Set(
      Array.isArray(raw?.bonusBuyIds) ? (raw.bonusBuyIds as string[]) : []
    );
    return {
      raw,
      deals: allDeals.filter((d) => belongs.has(d.id)),
    };
  }

  // ── Cart (orders-api.sixty60.co.za) ─────────────────────────────────────

  async getCart(stores?: StoreContext[]): Promise<CartState> {
    const headers = await this.headers(stores);
    const storeContexts = stores ?? CONFIG.DEFAULT_STORES;

    const res = await request<CartsResponse>(
      "POST",
      `${CONFIG.ORDERS_API}/api/v2/carts/user?useProductMinInfoAnnotation=true`,
      { headers, json: { storeContexts }, retry: "safe" }
    );

    const carts = res.data?.carts ?? [];
    const primary =
      carts.find((c) => c.item?.serviceOptionId === "sixty-min-delivery") ?? carts[0];
    return {
      carts,
      cartId: primary?.item?.id ?? null,
      cartVersion: primary?.item?.cartVersion ?? 0,
      items: primary?.item?.lineItems ?? [],
    };
  }

  /**
   * Full multi-cart snapshot for the MUTATION path. Unlike {@link getCart} (a
   * read-only view of the primary cart), this returns EVERY cart with its
   * cartVersion, delivery address, and full raw line items preserved field-for-
   * field — the shape the captured whole-cart `/carts/update` contract must
   * round-trip. `storeContexts` is the configured store set (deterministic,
   * hashed into the plan id).
   */
  async getCarts(stores?: StoreContext[]): Promise<PlanSnapshot> {
    const storeContexts = stores ?? CONFIG.DEFAULT_STORES;
    const headers = await this.headers(stores);
    const res = await request<CartsResponse>(
      "POST",
      `${CONFIG.ORDERS_API}/api/v2/carts/user?useProductMinInfoAnnotation=true`,
      { headers, json: { storeContexts }, retry: "safe" }
    );

    const carts: CartSnapshot[] = (res.data?.carts ?? [])
      .map((c) => c.item)
      .filter((item): item is NonNullable<CartEnvelope["item"]> => !!item?.id)
      .map((item) => ({
        cartId: item.id as string,
        serviceOptionId: item.serviceOptionId ?? "",
        // Absence is preserved as NaN so the confirm guard refuses (never coerced to 0).
        cartVersion: typeof item.cartVersion === "number" ? item.cartVersion : Number.NaN,
        deliveryAddressId: item.deliveryAddressId ?? "",
        lineItems: (item.lineItems ?? []) as unknown as Record<string, unknown>[],
      }));

    const withAddr = carts.find((c) => c.deliveryAddressId);
    return {
      carts,
      deliveryAddressId: withAddr?.deliveryAddressId ?? "",
      storeContexts: storeContexts as unknown[],
    };
  }

  /**
   * Dispatch the captured whole-cart update built EXCLUSIVELY from a fresh
   * snapshot. Sends every cart (both delivery modes), the cart's current address,
   * and the configured store contexts, as JSON (the captured wire encoding —
   * the old form-urlencoded body was the 400 bug). `retry:"never"`: a cart write
   * is never safe to auto-retry. Returns the server's post-write snapshot.
   */
  async commitCartUpdate(snapshot: PlanSnapshot): Promise<PlanSnapshot> {
    const headers = await this.headers();
    const body = {
      carts: snapshot.carts.map((c) => ({
        id: c.cartId,
        serviceOptionId: c.serviceOptionId,
        lineItems: c.lineItems,
      })),
      deliveryAddressId: snapshot.deliveryAddressId,
      storeContexts: snapshot.storeContexts,
    };

    const res = await request<CartsResponse>(
      "POST",
      `${CONFIG.ORDERS_API}/api/v3/carts/update?useProductMinInfoAnnotation=true`,
      { headers, json: body, retry: "never" }
    );

    if (!res.data?.carts) {
      throw new APIError(res.status, "Cart update failed", "", "carts/update");
    }
    const carts: CartSnapshot[] = res.data.carts
      .map((c) => c.item)
      .filter((item): item is NonNullable<CartEnvelope["item"]> => !!item?.id)
      .map((item) => ({
        cartId: item.id as string,
        serviceOptionId: item.serviceOptionId ?? "",
        cartVersion: typeof item.cartVersion === "number" ? item.cartVersion : Number.NaN,
        deliveryAddressId: item.deliveryAddressId ?? "",
        lineItems: (item.lineItems ?? []) as unknown as Record<string, unknown>[],
      }));
    const withAddr = carts.find((c) => c.deliveryAddressId);
    return {
      carts,
      deliveryAddressId: withAddr?.deliveryAddressId ?? snapshot.deliveryAddressId,
      storeContexts: snapshot.storeContexts,
    };
  }

  /**
   * Empty a cart. The whole-cart `/carts/update` contract REJECTS an empty (or
   * all-zero-quantity) line-item list with HTTP 400 ("Failed to update your
   * basket."), so removing the last item / clearing goes through the captured
   * `DELETE /api/v1/carts/{cartId}` instead (verified 200). The server rotates in
   * a fresh empty cart id afterward, so callers must re-read to reconcile.
   * `retry:"never"`.
   */
  async deleteCart(cartId: string): Promise<void> {
    const headers = await this.headers();
    await request(
      "DELETE",
      `${CONFIG.ORDERS_API}/api/v1/carts/${encodeURIComponent(cartId)}`,
      { headers, retry: "never" }
    );
  }

  // ── Addresses & cards (auth.sixty60.co.za) ──────────────────────────────

  /**
   * Delivery addresses come from the customer profile. The dedicated
   * `/customers/{id}/addresses` contract was never captured, so this RE-FETCHES
   * `customer-profile/v2` (Bearer static PROFILE_TOKEN, session token in the
   * path → sensitivePathTail + redirect:manual) and returns its `addresses`.
   * The profile response is not persisted, so each call re-fetches.
   */
  async getAddresses(): Promise<Address[]> {
    const session = await this.session();
    const res = await request<{ userProfile?: { addresses?: Address[] } }>(
      "GET",
      `${CONFIG.AUTH_BASE}/customers/${encodeURIComponent(session.customerId)}/customer-profile/v2/${session.sessionToken}`,
      {
        headers: this.profileHeaders(),
        sensitivePathTail: true,
        redirect: "manual",
        retry: "safe",
      }
    );
    return res.data?.userProfile?.addresses ?? [];
  }

  /**
   * Membership + wallet slice of the customer profile. RE-FETCHES
   * `customer-profile/v2` (same contract as {@link getAddresses}: Bearer static
   * PROFILE_TOKEN, session token in the path → sensitivePathTail + redirect
   * manual) and returns the raw `userProfile`. orders.ts maps only the
   * allowlisted membership/balance fields; the profile is never persisted.
   */
  async getCustomerProfile(): Promise<RawCustomerProfile> {
    const session = await this.session();
    const res = await request<{ userProfile?: RawCustomerProfile }>(
      "GET",
      `${CONFIG.AUTH_BASE}/customers/${encodeURIComponent(session.customerId)}/customer-profile/v2/${session.sessionToken}`,
      {
        headers: this.profileHeaders(),
        sensitivePathTail: true,
        redirect: "manual",
        retry: "safe",
      }
    );
    return res.data?.userProfile ?? {};
  }

  /**
   * Saved payment cards. Captured contract: `GET {AUTH}/customers/{userId}/cards`
   * with the Bearer SESSION token (the session token is in the header, not the
   * path — so no sensitivePathTail/redirect handling). Returns the raw cards;
   * orders.ts maps only the allowlisted issuer/masked/expiry/default fields —
   * token/cardholderName never escape. `retry:"safe"` (a plain read).
   */
  async getCards(): Promise<RawCard[]> {
    const session = await this.session();
    const res = await request<{ cards?: RawCard[]; success?: boolean }>(
      "GET",
      `${CONFIG.AUTH_BASE}/customers/${encodeURIComponent(session.userId)}/cards`,
      { headers: this.authHostHeaders(session), retry: "safe" }
    );
    return res.data?.cards ?? [];
  }

  /** Customer-profile header set: Bearer static PROFILE_TOKEN + base app headers. */
  private profileHeaders(): Record<string, string> {
    return {
      authorization: `Bearer ${CONFIG.PROFILE_TOKEN}`,
      channel: CONFIG.CHANNEL,
      "app-version": CONFIG.APP_VERSION,
      appversion: CONFIG.APP_VERSION_CODE,
      "device-id": getDeviceId(),
    };
  }

  /** Auth-host header set: Bearer SESSION token + base app headers (cards read). */
  private authHostHeaders(session: SessionContext): Record<string, string> {
    return {
      authorization: `Bearer ${session.sessionToken}`,
      channel: CONFIG.CHANNEL,
      "app-version": CONFIG.APP_VERSION,
      appversion: CONFIG.APP_VERSION_CODE,
      "device-id": getDeviceId(),
    };
  }

  // ── Orders (orders-api.sixty60.co.za) ───────────────────────────────────

  async getOrders(activeOnly = true): Promise<OrderGroup[]> {
    const headers = await this.headers();
    const res = await request<{ orderGroups?: OrderGroup[] }>(
      "GET",
      `${CONFIG.ORDERS_API}/api/v1/orders/groups?activeOnly=${activeOnly}`,
      { headers, retry: "safe" }
    );
    return res.data?.orderGroups ?? [];
  }

  /**
   * Purchase-frequency scores for the account's products (the "regulars" feed).
   * `storeIds` is a COMMA-SEPARATED query param (not the JSON storeids header).
   * Returns the raw score list; orders.ts resolves names/prices and maps a DTO.
   */
  async getMyProducts(storeIds?: string): Promise<RawUserProductScore[]> {
    const headers = await this.headers();
    const csv = storeIds ?? storeIdList();
    const res = await request<{ userProductScores?: RawUserProductScore[] }>(
      "GET",
      `${CONFIG.ORDERS_API}/api/v3/orders/my-products?storeIds=${encodeURIComponent(csv)}`,
      { headers, retry: "safe" }
    );
    return res.data?.userProductScores ?? [];
  }

  /** Past (completed) orders — account-scoped. Raw; orders.ts maps to a DTO. */
  async getCompletedOrders(): Promise<RawCompletedOrder[]> {
    const headers = await this.headers();
    const res = await request<{ orders?: RawCompletedOrder[] }>(
      "GET",
      `${CONFIG.ORDERS_API}/api/v1/orders/completed-orders`,
      { headers, retry: "safe" }
    );
    return res.data?.orders ?? [];
  }

  /**
   * Favourite products. Served by the CATALOG host (not orders-api). The element
   * shape was empty in capture, so orders.ts extracts ids defensively and
   * resolves names/prices via the catalog (no PII lives in this response).
   */
  async getFavourites(): Promise<unknown[]> {
    const headers = await this.headers();
    const res = await request<{ favourites?: unknown[] | null }>(
      "GET",
      `${CONFIG.CATALOG_API}/api/v1/products/favourites`,
      { headers, retry: "safe" }
    );
    return res.data?.favourites ?? [];
  }

  /**
   * The set of favourited product ids. Read side of the favourites toggle; used by
   * the mutation gate to compute desired state and to reconcile after a write.
   * Element shape is extracted defensively (id may be a bare string or a
   * `{productId}` object).
   */
  async getFavouriteIds(): Promise<Set<string>> {
    const favourites = await this.getFavourites();
    const ids = new Set<string>();
    for (const f of favourites) {
      if (typeof f === "string") ids.add(f);
      else if (f && typeof f === "object") {
        const pid = (f as { productId?: unknown; id?: unknown }).productId ?? (f as { id?: unknown }).id;
        if (typeof pid === "string") ids.add(pid);
      }
    }
    return ids;
  }

  /**
   * Toggle a product's favourite (Saved Items) flag. Captured contract:
   * `POST /api/v1/products/favourites/{productId}` (catalog host) with body
   * `{isFavourite: true|false}` → 201. Idempotent per-product; `retry:"never"`.
   */
  async setFavourite(productId: string, isFavourite: boolean): Promise<void> {
    const headers = await this.headers();
    await request(
      "POST",
      `${CONFIG.CATALOG_API}/api/v1/products/favourites/${encodeURIComponent(productId)}`,
      { headers, json: { isFavourite }, retry: "never" }
    );
  }

  /**
   * Backup/replacement candidates for a product. Served by the CATALOG host as
   * `POST /api/v1/products/user-alternatives`; the body carries the product ids
   * and store contexts. The response is a map of requested-product-id →
   * alternative product ids. A missing/malformed map is normalized to `{}` so
   * callers never see `undefined`. Only ids are returned here — orders.ts
   * resolves names/prices/images via the catalog and maps an allowlisted DTO.
   */
  async getUserAlternatives(
    productId: string,
    stores?: StoreContext[]
  ): Promise<Record<string, string[]>> {
    const headers = await this.headers(stores);
    const storeContexts = stores ?? CONFIG.DEFAULT_STORES;
    const res = await request<{ alternativeProductIdMap?: Record<string, string[]> }>(
      "POST",
      `${CONFIG.CATALOG_API}/api/v1/products/user-alternatives`,
      { headers, json: { productIds: [productId], storeContexts }, retry: "safe" }
    );
    const map = res.data?.alternativeProductIdMap;
    return map && typeof map === "object" ? map : {};
  }

  /**
   * Return groups for the account. Served by the RETURNS host. Raw; orders.ts
   * maps to an allowlisted DTO (redaction proven via synthetic poison fixtures).
   */
  async getReturns(): Promise<{
    completedReturnGroups?: unknown[];
    inProgressReturnGroups?: unknown[];
  }> {
    const headers = await this.headers();
    const res = await request<{
      returns?: { completedReturnGroups?: unknown[]; inProgressReturnGroups?: unknown[] };
    }>("GET", `${CONFIG.RETURNS_API}/api/v1/return-groups/app/user`, {
      headers,
      retry: "safe",
    });
    return res.data?.returns ?? {};
  }

  /**
   * First available delivery slot per service option. A read-only POST (the app
   * captures it as POST /api/v3/first-delivery-slots) that needs no cart — the
   * body carries the store contexts. Raw; orders.ts maps a per-mode DTO.
   */
  async getFirstDeliverySlots(
    stores?: StoreContext[]
  ): Promise<RawFirstDeliverySlots> {
    const headers = await this.headers(stores);
    const storeContexts = stores ?? CONFIG.DEFAULT_STORES;
    const res = await request<RawFirstDeliverySlots>(
      "POST",
      `${CONFIG.ORDERS_API}/api/v3/first-delivery-slots`,
      { headers, json: { storeContexts }, retry: "safe" }
    );
    return res.data ?? {};
  }

  // ── Discovery & offers (catalog.sixty60.co.za) ──────────────────────────

  /**
   * Personalized offers ("offers for you"). The catalog returns a bonus-buy map
   * under `promotions` (same shape as a search's `bonusBuys`). Raw; discovery.ts
   * normalizes it with the shared bonus-buy normalizer.
   */
  async getOffersForYou(stores?: StoreContext[]): Promise<RawOffersForYou> {
    const session = await this.session();
    const headers = this.sixty60Headers(session, stores);
    const storeContexts = stores ?? CONFIG.DEFAULT_STORES;
    const res = await request<RawOffersForYou>(
      "POST",
      `${CONFIG.CATALOG_API}/api/v1/products/offers-for-you`,
      { headers, json: { storeContexts, userId: session.userId }, retry: "safe" }
    );
    return res.data ?? {};
  }

  /**
   * Personalized promotions ("promotions for you"): bonus-buy deals plus the
   * products they surface. `isXtraSavingsMember` is a required query flag (pass
   * the profile-derived value from {@link isXtraSavingsMember}). Raw; discovery.ts
   * maps deals via the shared normalizer and products to a minimal DTO.
   */
  async getPromotionsForYou(
    isXtraSavingsMember: boolean,
    stores?: StoreContext[]
  ): Promise<RawPromotionsForYou> {
    const session = await this.session();
    const headers = this.sixty60Headers(session, stores);
    const csv = storeIdList(stores);
    const url =
      `${CONFIG.CATALOG_API}/api/v1/retrieve/products/promotions/forYou` +
      `?storeIds=${encodeURIComponent(csv)}` +
      `&userId=${encodeURIComponent(session.userId)}` +
      `&isXtraSavingsMember=${isXtraSavingsMember}`;
    const res = await request<RawPromotionsForYou>("GET", url, { headers, retry: "safe" });
    return res.data ?? {};
  }

  /**
   * Search-scoped filter facets. Only the department facets are read (categories).
   * The body is FLAT (source + storeContexts at the top level — the nested
   * `filter` wrapper used by `/products/filter` returns 400 here). An empty query
   * yields no departments, so callers must pass a real search term.
   */
  async getFilterOptions(
    query: string,
    stores?: StoreContext[]
  ): Promise<RawFilterOptions> {
    const session = await this.session();
    const headers = this.sixty60Headers(session, stores);
    const storeContexts = stores ?? CONFIG.DEFAULT_STORES;
    const res = await request<RawFilterOptions>(
      "POST",
      `${CONFIG.CATALOG_API}/api/v4/products/filter/options`,
      {
        headers,
        json: {
          productListSource: { search: query },
          storeContexts,
          userId: session.userId,
          location: CONFIG.USER_LOCATION,
        },
        retry: "safe",
      }
    );
    return res.data ?? {};
  }

  /**
   * Best-effort Xtra Savings membership, derived from the DSL profile: true when
   * an ACTIVE Checkers/Xtra loyalty card is present. Only a boolean is returned —
   * the PII-bearing profile never escapes this method.
   */
  async isXtraSavingsMember(): Promise<boolean> {
    const profile = await this.getUserProfile();
    const cards = (profile as { loyaltyCards?: { cards?: RawLoyaltyCard[] } } | undefined)
      ?.loyaltyCards?.cards;
    if (!Array.isArray(cards)) return false;
    return cards.some(
      (c) => c?.active === true && /checkers|xtra/i.test(typeof c.theme === "string" ? c.theme : "")
    );
  }

  // ── Delivery slots (via pre-order; orders-api) ──────────────────────────

  /**
   * The mobile app only surfaces delivery slots during pre-order, so slots are
   * tied to the current cart's line items.
   */
  async getDeliverySlots(): Promise<PreOrderResult> {
    const { cartId, cartVersion, items } = await this.getCart();
    if (!cartId || items.length === 0) {
      return { slots: [], asap: false };
    }
    const headers = await this.headers();

    const body = {
      cartsInfo: [
        {
          cartId,
          cart: {
            id: cartId,
            cartVersion,
            updatedOn: Date.now(),
            lineItems: items.map((li) => ({
              id: li.id,
              productId: li.productId,
              storeId: li.storeId ?? CONFIG.DEFAULT_STORES[0].storeId,
              price: li.price,
              previousPrice: li.previousPrice ?? 0,
              priceFactor: li.priceFactor ?? 100,
              quantity: li.quantity,
              specialInstructions: "",
              replacementPreferenceId: "",
              optionSelections: null,
              selectedWeightRange: null,
              missionName: "",
              missionType: "",
              addToBasketType: "pdp_add_to_basket",
              addToBasketJourney: "main_search_results",
              isStockAvailable: true,
              ranged: true,
              isSponsoredProduct: false,
              serviceOptionId: "sixty-min-delivery",
              hasAlcohol: false,
              requiresOver18: false,
            })),
          },
        },
      ],
    };

    const t = Date.now();
    const res = await request<{
      deliverySlots?: Record<string, { slots?: DeliverySlot[]; allowASAPDelivery?: boolean }>;
      totals?: unknown;
    }>("POST", `${CONFIG.ORDERS_API}/api/v3/orders/pre-order?t=${t}&screen=filter`, {
      headers,
      form: body, // app quirk: form-urlencoded JSON body
    });

    const slotData = res.data?.deliverySlots
      ? Object.values(res.data.deliverySlots)[0]
      : undefined;
    return {
      slots: slotData?.slots ?? [],
      asap: slotData?.allowASAPDelivery ?? false,
      totals: res.data?.totals,
      raw: res.data,
    };
  }

  // ── User profile (Shoprite DSL) ─────────────────────────────────────────

  async getUserProfile(): Promise<UserProfile | undefined> {
    const session = await this.session();
    const res = await request<{ response?: { user?: UserProfile } }>(
      "GET",
      `${CONFIG.SHOPRITE_BASE}/users`,
      {
        headers: {
          "x-api-key": CONFIG.X_API_KEY_USER,
          access_token: session.sessionToken,
          channel: CONFIG.CHANNEL,
          "app-version": CONFIG.APP_VERSION,
          appversion: CONFIG.APP_VERSION_CODE,
          "device-id": getDeviceId(),
        },
        retry: "safe",
      }
    );
    return res.data?.response?.user;
  }

  /** Build a catalog image URL for a product image id. */
  imageUrl(imageId: string, size = 156): string {
    return `${CONFIG.CATALOG_API}/v2/files/${imageId}?width=${size}&height=${size}`;
  }
}
