import {
  CheckersAPI,
  type BonusBuy,
  type CartLineItem,
  type Product,
  type RawCartSavings,
  type RawCatalogProduct,
  type RawCompletedOrder,
  type RawCustomerProfile,
  type RawFirstDeliverySlots,
  type RawMissedDiscount,
  type RawOrderItem,
  type RawPreOrderSlot,
  type RawUserProductScore,
  type PreOrderResult,
} from "./api.js";
import { CONFIG, type StoreContext } from "./config.js";

/**
 * Normalization boundary for the read-only domain commands. Every value a
 * command emits — JSON or human — is rendered from one of the DTOs below and
 * NOTHING else. Mappers copy allowlisted fields field-by-field: no object
 * spreads, no raw-envelope passthrough, no index signatures on any DTO. Raw API
 * envelopes (driver name/phone/coords, addresses, payment tokens, loyalty ids,
 * signed URLs, emails, and unknown fields) therefore cannot escape, even when
 * present in the response — proven by the synthetic "poison" fixtures in the
 * tests.
 */

// ─── DTOs (allowlisted output shapes — no index signatures, ever) ────────────

/** A frequently-bought product (from the purchase-frequency feed). */
export interface RegularDTO {
  productId: string;
  name: string;
  /** Price in cents, or null when the catalog did not resolve the product. */
  price: number | null;
  /** Purchase-frequency score (higher = bought more often/recently). */
  score: number;
  /** Times purchased. */
  count: number;
}

/** One line item of a past/current order — the only order contents emitted. */
export interface OrderItemDTO {
  productId: string;
  name: string;
  quantity: number;
  /** Price in cents at time of order, or null. Preview prices may be stale. */
  price: number | null;
}

/** A completed (past) order, for reorder preview. */
export interface CompletedOrderDTO {
  id: string;
  /** ISO-8601 order date, or null. */
  date: string | null;
  status: string | null;
  itemCount: number;
  items: OrderItemDTO[];
}

/**
 * `reorder --preview` output. Wraps the already-normalized completed order —
 * the `order` field is a `CompletedOrderDTO`, never a raw envelope — plus the
 * preview/stale-price flags. The command renders JSON and human output from
 * this DTO only.
 */
export interface ReorderPreviewDTO {
  preview: boolean;
  pricesMayBeStale: boolean;
  order: CompletedOrderDTO;
}

/** One row of the orders list. */
export interface OrderSummaryDTO {
  reference: string;
  status: string | null;
  /** Total owing in cents, or null. */
  total: number | null;
}

/** Detail for a single order (`orders show`). */
export interface OrderDetailDTO {
  reference: string;
  status: string | null;
  total: number | null;
  itemCount: number;
  items: OrderItemDTO[];
}

/**
 * Tracking snapshot for one order (`track`). Status + one-hour slot come from the
 * captured `orders/groups` read; `track --watch` polls this for status progression.
 *
 * Richer LIVE tracking — the driver's live position and a precise moving ETA — is
 * NOT served by a plain read: the apk bundle shows the app fetches an order-info
 * snapshot from `POST /api/v3/orders/order-groups-info` (it is 405 on GET) and then
 * receives real-time updates over a websocket channel (bundle flag
 * `super-app-enable-websockets`). Both require an order that is actively OUT FOR
 * DELIVERY to capture their request/response and message shapes, so they are
 * intentionally not implemented here rather than guessed. When such a capture is
 * done, wire `getOrderGroupsInfo` (below) + the websocket as the live source; until
 * then `eta`/`slot` stay null. Driver name/phone/coordinates are NEVER included.
 */
export interface TrackDTO {
  reference: string;
  status: string | null;
  eta: string | null;
  slotFrom: string | null;
  slotTo: string | null;
  itemCount: number;
  total: number | null;
}

/** A favourite product (resolved via the catalog). */
export interface FavouriteDTO {
  productId: string;
  name: string;
  price: number | null;
}

/**
 * A backup/alternative product (`backup <productId>`), resolved via the catalog.
 * `imageId` is always present (nullable) so the DTO's key set is fixed.
 */
export interface BackupProductDTO {
  productId: string;
  name: string;
  /** Price in cents, or null when the catalog did not resolve the product. */
  price: number | null;
  /** Catalog image id, or null. */
  imageId: string | null;
}

/**
 * A deferred cart-reads feature. Two of the domain's endpoints have no captured
 * READ-only contract in this app version — `smart-cart/recommendations` is 404
 * on every host, and `carts/have-you-forgotten` only answers a mutation-adjacent
 * POST — so those commands recognize the request but defer (no network call, no
 * guessed body), mirroring `slots --mode hyper`.
 */
export interface DeferredCartDTO {
  feature: "forgotten" | "suggest";
  supported: false;
  message: string;
}

export const CART_FORGOTTEN_DEFERRED_MESSAGE =
  "cart 'have you forgotten' suggestions — no read-only contract captured in this app version";

export const CART_SUGGEST_DEFERRED_MESSAGE =
  "smart-cart recommendations — endpoint not available in this app version";

/** One returned item within a return group. */
export interface ReturnItemDTO {
  productId: string | null;
  name: string;
  quantity: number;
}

/** A return group (`returns` / `returns show`). Contact/photo URLs excluded. */
export interface ReturnGroupDTO {
  id: string;
  reference: string | null;
  status: string | null;
  itemCount: number;
  items: ReturnItemDTO[];
}

/**
 * A saved delivery address. Only id + label + city are emitted — never the
 * unit number, delivery notes, coordinates, street, suburb, or full address.
 */
export interface AddressDTO {
  id: string;
  name: string;
  city: string | null;
}

/**
 * A saved payment card. EXACTLY these five fields are emitted — the card
 * `token` (a payment secret), `cardholderName` (PII), `cardHasBeenUsed` and
 * `mostRecentlyUsed` are never mapped. No index signature.
 */
export interface CardDTO {
  issuer: string | null;
  maskedCardNumber: string | null;
  expiryMonth: string | number | null;
  expiryYear: string | number | null;
  isDefault: boolean;
}

/**
 * Fulfilment mode. Three exist: `sixty-min` (small goods, ≈1hr) and `one-day`
 * (scheduled slot) are SLOT-based; `hyper` (large/bulk goods, Checkers Hyper)
 * uses a delivery ESTIMATE + minimum order value — a contract NOT yet captured,
 * so it is recognized but deferred, never guessed.
 */
export type DeliveryMode = "sixty-min" | "one-day" | "hyper";

export const DELIVERY_MODES: readonly DeliveryMode[] = ["sixty-min", "one-day", "hyper"];

/** Deferred-Hyper notice — the only thing `--mode hyper` emits this increment. */
export const HYPER_DEFERRED_MESSAGE =
  "large-goods (Hyper) delivery — estimate not yet supported";

/**
 * `slots --mode hyper` output. Hyper's estimate contract is not yet captured, so
 * the command emits this fixed deferral notice (no network call). JSON and human
 * output are both rendered from this DTO.
 */
export interface HyperSlotsDTO {
  mode: "hyper";
  supported: false;
  message: string;
}

/** First available delivery slot for one service option. No PII. */
export interface SlotDTO {
  /** Service option id, e.g. "sixty-min-delivery" or "one-day-delivery". */
  mode: string;
  storeId: string | null;
  /** ISO-8601 slot start, or null when none is available. */
  from: string | null;
  /** ISO-8601 slot end, or null. */
  to: string | null;
  available: boolean;
  asap: boolean;
  /** Delivery fee in Rand (as reported by first-delivery-slots), or null. */
  deliveryFee: number | null;
  /** Minimum order value in Rand, or null. */
  minimumOrderValue: number | null;
}

/**
 * Xtra Savings membership status. `memberNumber` is the account's OWN loyalty
 * card number (what identifies the member to themselves) — never the Xtra
 * Savings access/id tokens, which are secrets and never mapped. `lifetimeSavings`
 * has no field in customer-profile/v2 (only feature flags), so it is always null
 * this increment rather than guessed from an uncaptured endpoint.
 */
export interface MembershipDTO {
  isMember: boolean;
  memberNumber: string | null;
  lifetimeSavings: number | null;
}

/**
 * Account wallet balance. `balance` is the API-reported account balance in cents
 * (customer-profile/v2 `account.balanceAmount`, balanceFactor 100), or null when
 * the field is absent — never coerced to 0, so "unknown" is not reported as
 * "empty". Named sub-buckets (voucher, xCash, service-guarantee) are NOT summed
 * in without proven aggregation semantics.
 */
export interface WalletDTO {
  balance: number | null;
  currency: string;
}

/**
 * One line of the order's fee breakdown. Known fee categories are labelled
 * explicitly; any additional server-provided fee is passed through generically
 * (its `name` + `amount` ONLY) so packaging / bag / service / future fees are
 * NEVER silently dropped — and no other field of an uncaptured fee object can
 * escape. `amount` is in integer minor units (cents).
 */
export interface FeeLineDTO {
  name: string;
  amount: number;
}

/** One delivery slot offered for the previewed cart (pre-order). No PII. */
export interface PreviewSlotDTO {
  /** ISO-8601 slot start, or null. */
  from: string | null;
  /** ISO-8601 slot end, or null. */
  to: string | null;
  /** Human slot label (e.g. "2-3 PM"), or null. */
  displayName: string | null;
}

/**
 * `checkout --preview` output: a READ-ONLY totals preview for the current
 * populated cart, derived from the captured pre-order response. Money is in
 * integer CENTS (the pre-order `totals` convention — unlike the RAND figures
 * `first-delivery-slots` reports). Every value stays inside the DTO-allowlist
 * boundary: fields are copied explicitly by name (no spreads, no raw
 * passthrough), and the pre-order's payment block is reduced to method-type
 * strings — card tokens, PANs and cardholder names never escape. An empty cart
 * (pre-order returns no totals) yields `populated: false` and a guidance
 * `message`; a persistent server 400 throws (never a fake-empty preview).
 */
export interface CheckoutPreviewDTO {
  preview: true;
  /** False when the cart is empty (pre-order returned no totals). */
  populated: boolean;
  currency: string;
  /** Goods subtotal in cents (`totals.cartTotal`), or null. */
  subtotal: number | null;
  /** Discount already applied in cents (`totals.discountTotal`), or null. */
  discountTotal: number | null;
  /** Delivery fee in cents (`totals.deliveryFee`), or null. */
  deliveryFee: number | null;
  /** Driver tip already applied in cents (`totals.tipAmount`), or null. */
  tipAmount: number | null;
  /** Total owing in cents (`totals.totalOwing`), or null. */
  totalOwing: number | null;
  /** Total payable in cents (`totals.totalPayable`), or null. */
  total: number | null;
  /** Per-service-option delivery fee breakdown in cents (`detailedDeliveryFees`). */
  fees: FeeLineDTO[];
  /** Whether ASAP delivery is available for the cart. */
  allowASAPDelivery: boolean;
  /** Delivery slots offered for the cart (from the pre-order response). */
  deliverySlots: PreviewSlotDTO[];
  /** Payment METHOD-TYPE ids only (e.g. "ecentric-card") — never card details. */
  availablePaymentMethods: string[];
  /** Example driver-tip presets in cents — tip is chosen in the app, not stored. */
  tipPresetsCents: number[];
  /** Plain-language note that slot + tip are chosen in the app, not stored here. */
  note: string;
  /** Guidance for the empty-cart case; null when totals are present. */
  message: string | null;
}

export const CHECKOUT_EMPTY_CART_MESSAGE =
  "Add items to your cart before previewing checkout totals.";

/** Example driver-tip presets in cents (R10 / R20 / R30 / R50) — the app's fixed set. */
export const CHECKOUT_TIP_PRESETS_CENTS: readonly number[] = [1000, 2000, 3000, 5000];

export const CHECKOUT_SELECTION_NOTE =
  "Delivery slot and driver tip are selected in the app when you pay — this CLI does not store them.";
/**
 * One cart line that qualifies for a bonus-buy deal. Membership only — its
 * presence never implies the deal's buy-threshold is met.
 */
export interface DealCartItemDTO {
  productId: string;
  name: string | null;
  quantity: number;
}

/**
 * One active bonus-buy deal that the current cart TOUCHES. Purely an awareness
 * view: it reports the human `terms`, which cart items qualify, and the OTHER
 * qualifying product ids as eligible OPTIONS (a hint, never "required"). It
 * deliberately carries NO threshold, NO "N-short", NO progress, and NO
 * rand-saved figure — those are not machine-readable on a bonus-buy deal, and
 * completing a deal is the user's job via the gated `add`.
 */
export interface CartDealDTO {
  dealId: string;
  /** Short human heading, e.g. "Buy 2 & Save 20%". */
  title: string;
  /** Full human terms — the buy-quantity and saving live only here, as text. */
  terms: string;
  /** ISO-8601 deal expiry, or null. */
  validUntil: string | null;
  membersOnly: boolean;
  qualifyingItemsInCart: DealCartItemDTO[];
  /** Other qualifying product ids NOT in the cart — labelled options, a hint. */
  eligibleOptionProductIds: string[];
}

/**
 * Server-computed savings ALREADY applied to the current cart. Taken VERBATIM
 * from the cart's `cartSavings` (never computed here) — an aggregate of what the
 * cart has already saved, NOT a per-deal figure and NOT an amount-to-complete.
 * Amounts are integer cents; a non-integer/absent field is reported as null.
 */
export interface CartSavingsDTO {
  productSavings: number | null;
  discountCodesSavings: number | null;
  totalSavings: number | null;
}

/**
 * One server-provided "complete your deal" (missedDiscounts) entry — the app's
 * MissedDiscountSection. Surfaced VERBATIM: EXACTLY these six fields, each copied
 * from the raw entry (or `null`), plus `membersOnly` as a direct boolean
 * projection of `memberType.code`. `discountValue` is deliberately NOT mapped
 * (it is 0/untrustworthy for these deals), so no fabricated saving can escape;
 * the buy-quantity and rand-saving live only inside the description text.
 */
export interface MissedDealDTO {
  promotionId: string | null;
  name: string | null;
  shortDescription: string | null;
  longDescription: string | null;
  /** Direct projection of `memberType.code === 'fox_members'` — not a saving. */
  membersOnly: boolean;
  discountTypeCode: string | null;
}

/**
 * `savings` output: the deals the current cart touches. `cartItemCount` is the
 * number of distinct cart lines. `cartSavings` is the server's verbatim
 * already-applied cart savings (null when the cart reports none). `missedDeals`
 * is the server's authoritative "complete your deal" list for the current cart
 * (empty when none). `message` guides the empty-cart case only.
 */
export interface SavingsDTO {
  cartItemCount: number;
  cartSavings: CartSavingsDTO | null;
  deals: CartDealDTO[];
  missedDeals: MissedDealDTO[];
  message: string | null;
}

export const SAVINGS_EMPTY_CART_MESSAGE =
  "Your cart is empty — add items to see the bonus-buy deals they qualify for.";

// ─── Narrow raw input views (read-only; consumed only by the mappers) ────────

interface RawGroupOrder {
  status?: { orderStatus?: string; name?: string };
  total?: { totalOwing?: number };
  orderItems?: RawOrderItem[];
}

interface RawOrderGroup {
  reference?: string;
  orders?: RawGroupOrder[];
}

interface RawReturnItem {
  productId?: string;
  name?: string;
  quantity?: number;
  productMinInfo?: { name?: string; displayName?: string };
}

interface RawReturnGroup {
  id?: string;
  _id?: string;
  reference?: string;
  returnReference?: string;
  returnStatus?: string;
  status?: string | { name?: string; returnStatus?: string };
  items?: RawReturnItem[];
  returnItems?: RawReturnItem[];
  orderItems?: RawReturnItem[];
}

interface RawAddress {
  _id?: string;
  identifier?: string;
  name?: string;
  city?: string;
}

/** Read-only view of a raw card naming ONLY the allowlisted fields. */
interface RawCardView {
  issuer?: string;
  maskedCardNumber?: string;
  expiryMonth?: string | number;
  expiryYear?: string | number;
  isDefault?: boolean;
}

// ─── Pure mappers (exported for redaction/shape tests) ───────────────────────

export function mapOrderItem(raw: RawOrderItem): OrderItemDTO {
  return {
    productId: raw.productId ?? "",
    name: raw.productMinInfo?.name ?? raw.productMinInfo?.displayName ?? raw.name ?? "",
    quantity: raw.quantity ?? 0,
    price: typeof raw.price === "number" ? raw.price : null,
  };
}

export function mapRegular(
  score: RawUserProductScore,
  product: RawCatalogProduct | undefined
): RegularDTO {
  return {
    productId: score.productId ?? "",
    name: product?.name ?? product?.displayName ?? "",
    price: typeof product?.priceWithoutDecimal === "number" ? product.priceWithoutDecimal : null,
    score: typeof score.score === "number" ? score.score : 0,
    count: typeof score.count === "number" ? score.count : 0,
  };
}

export function mapCompletedOrder(raw: RawCompletedOrder): CompletedOrderDTO {
  const items = (raw.orderItems ?? []).map(mapOrderItem);
  return {
    id: raw.id ?? "",
    date: typeof raw.createdOn === "number" ? new Date(raw.createdOn).toISOString() : null,
    status: raw.status?.orderStatus ?? raw.status?.name ?? null,
    itemCount: items.length,
    items,
  };
}

/** Wrap a normalized completed order as the reorder-preview output DTO. */
export function toReorderPreviewDTO(order: CompletedOrderDTO): ReorderPreviewDTO {
  return {
    preview: true,
    pricesMayBeStale: true,
    order,
  };
}

export function mapOrderSummary(group: RawOrderGroup): OrderSummaryDTO {
  const order = group.orders?.[0];
  return {
    reference: group.reference ?? "",
    status: order?.status?.orderStatus ?? order?.status?.name ?? null,
    total: typeof order?.total?.totalOwing === "number" ? order.total.totalOwing : null,
  };
}

export function mapOrderDetail(group: RawOrderGroup): OrderDetailDTO {
  const order = group.orders?.[0];
  const items = (order?.orderItems ?? []).map(mapOrderItem);
  return {
    reference: group.reference ?? "",
    status: order?.status?.orderStatus ?? order?.status?.name ?? null,
    total: typeof order?.total?.totalOwing === "number" ? order.total.totalOwing : null,
    itemCount: items.length,
    items,
  };
}

export function mapTrack(group: RawOrderGroup): TrackDTO {
  const order = group.orders?.[0];
  return {
    reference: group.reference ?? "",
    status: order?.status?.orderStatus ?? order?.status?.name ?? null,
    eta: null,
    slotFrom: null,
    slotTo: null,
    itemCount: (order?.orderItems ?? []).length,
    total: typeof order?.total?.totalOwing === "number" ? order.total.totalOwing : null,
  };
}

export function mapFavourite(product: RawCatalogProduct): FavouriteDTO {
  return {
    productId: product.id ?? "",
    name: product.name ?? product.displayName ?? "",
    price: typeof product.priceWithoutDecimal === "number" ? product.priceWithoutDecimal : null,
  };
}

export function mapBackupProduct(product: RawCatalogProduct): BackupProductDTO {
  return {
    productId: product.id ?? "",
    name: product.name ?? product.displayName ?? "",
    price: typeof product.priceWithoutDecimal === "number" ? product.priceWithoutDecimal : null,
    imageId: typeof product.imageId === "string" ? product.imageId : null,
  };
}

/** The fixed `cart forgotten` deferral DTO (no network call, no guess). */
export function forgottenDeferredDTO(): DeferredCartDTO {
  return { feature: "forgotten", supported: false, message: CART_FORGOTTEN_DEFERRED_MESSAGE };
}

/** The fixed `cart suggest` deferral DTO (no network call, no guess). */
export function suggestDeferredDTO(): DeferredCartDTO {
  return { feature: "suggest", supported: false, message: CART_SUGGEST_DEFERRED_MESSAGE };
}

function mapReturnItem(raw: RawReturnItem): ReturnItemDTO {
  return {
    productId: raw.productId ?? null,
    name: raw.productMinInfo?.name ?? raw.productMinInfo?.displayName ?? raw.name ?? "",
    quantity: raw.quantity ?? 0,
  };
}

export function mapReturnGroup(raw: RawReturnGroup): ReturnGroupDTO {
  const status =
    typeof raw.status === "string"
      ? raw.status
      : (raw.status?.name ?? raw.status?.returnStatus ?? raw.returnStatus ?? null);
  const items = (raw.items ?? raw.returnItems ?? raw.orderItems ?? []).map(mapReturnItem);
  return {
    id: raw.id ?? raw._id ?? "",
    reference: raw.reference ?? raw.returnReference ?? null,
    status,
    itemCount: items.length,
    items,
  };
}

export function mapAddress(raw: RawAddress): AddressDTO {
  return {
    id: raw._id ?? raw.identifier ?? "",
    name: raw.name ?? "",
    city: raw.city ?? null,
  };
}

export function mapCard(raw: RawCardView): CardDTO {
  return {
    issuer: typeof raw.issuer === "string" ? raw.issuer : null,
    maskedCardNumber: typeof raw.maskedCardNumber === "string" ? raw.maskedCardNumber : null,
    expiryMonth:
      typeof raw.expiryMonth === "string" || typeof raw.expiryMonth === "number"
        ? raw.expiryMonth
        : null,
    expiryYear:
      typeof raw.expiryYear === "string" || typeof raw.expiryYear === "number"
        ? raw.expiryYear
        : null,
    isDefault: raw.isDefault === true,
  };
}

export function mapMembership(raw: RawCustomerProfile): MembershipDTO {
  return {
    isMember: raw.IsXtraSavingsCustomer === true,
    memberNumber:
      typeof raw.xTraSavingsCardNumber === "string" && raw.xTraSavingsCardNumber.length > 0
        ? raw.xTraSavingsCardNumber
        : null,
    lifetimeSavings: null,
  };
}

export function mapWallet(raw: RawCustomerProfile): WalletDTO {
  const balance = raw.account?.balanceAmount;
  return {
    balance: typeof balance === "number" ? balance : null,
    currency: "ZAR",
  };
}

// ── checkout preview mapper (pre-order response → allowlisted DTO) ────────────
// Every value is pulled by explicit key (never a spread), money is coerced to
// integer cents, and the raw envelope is never passed through. The payment
// block is reduced to method-type strings so card tokens/PANs/holder names in
// its nested `options` can never escape.

/**
 * Read a value as integer minor units (cents). The app's money convention is
 * integer cents everywhere, so anything that is NOT a safe integer (a decimal,
 * a string, NaN) is rejected as null rather than rounded — a non-integer means
 * our unit assumption is wrong, and a wrong number is worse than "unknown".
 */
function toCents(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function firstCents(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const c = toCents(obj[k]);
    if (c !== null) return c;
  }
  return null;
}

function firstString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return null;
}

/**
 * Per-service-option delivery fees (`detailedDeliveryFees`, e.g.
 * `{"sixty-min-delivery": 3700}`) as cents fee lines. Only integer-cents values
 * are kept; the service-option key is the label.
 */
function extractDeliveryFees(fees: Record<string, unknown> | undefined): FeeLineDTO[] {
  if (!fees || typeof fees !== "object") return [];
  const lines: FeeLineDTO[] = [];
  for (const [name, value] of Object.entries(fees)) {
    const amount = toCents(value);
    if (amount !== null) lines.push({ name, amount });
  }
  return lines;
}

/** Allowlisted preview slots: start/end/displayName only (pre-order slots carry no PII). */
function extractPreviewSlots(slots: RawPreOrderSlot[]): PreviewSlotDTO[] {
  return slots.map((s) => ({
    from: typeof s.start === "string" ? s.start : null,
    to: typeof s.end === "string" ? s.end : null,
    displayName:
      typeof s.displayName === "string"
        ? s.displayName
        : typeof s.displayNameShort === "string"
          ? s.displayNameShort
          : null,
  }));
}

/**
 * The payment block reduced to its METHOD-TYPE strings only (e.g.
 * "ecentric-card"). The nested `options` object carries masked PANs, issuer,
 * expiry and other card detail — none of which is read here, so no card
 * information can escape through the preview. De-duplicated, order preserved.
 */
function extractPaymentMethods(payment: unknown): string[] {
  if (!payment || typeof payment !== "object") return [];
  const arr = (payment as { availablePaymentMethods?: unknown }).availablePaymentMethods;
  if (!Array.isArray(arr)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of arr) {
    const type =
      entry && typeof entry === "object"
        ? (entry as { type?: unknown }).type
        : entry;
    if (typeof type === "string" && type.length > 0 && !seen.has(type)) {
      seen.add(type);
      out.push(type);
    }
  }
  return out;
}

/**
 * Map a populated pre-order response to the allowlisted preview DTO. Every money
 * field is integer cents, read by explicit key; slots and payment methods enter
 * only through their allowlisting extractors (never raw).
 */
export function mapCheckoutPreview(pre: PreOrderResult): CheckoutPreviewDTO {
  const t = (pre.totals && typeof pre.totals === "object" ? pre.totals : {}) as Record<
    string,
    unknown
  >;
  return {
    preview: true,
    populated: true,
    currency: firstString(t, ["currency", "currencyCode"]) ?? "ZAR",
    subtotal: firstCents(t, ["cartTotal"]),
    discountTotal: firstCents(t, ["discountTotal"]),
    deliveryFee: firstCents(t, ["deliveryFee"]),
    tipAmount: firstCents(t, ["tipAmount"]),
    totalOwing: firstCents(t, ["totalOwing"]),
    total: firstCents(t, ["totalPayable", "totalOwing"]),
    fees: extractDeliveryFees(pre.detailedDeliveryFees),
    allowASAPDelivery: pre.asap === true,
    deliverySlots: extractPreviewSlots(pre.slots ?? []),
    availablePaymentMethods: extractPaymentMethods(pre.payment),
    tipPresetsCents: [...CHECKOUT_TIP_PRESETS_CENTS],
    note: CHECKOUT_SELECTION_NOTE,
    message: null,
  };
}

/** Empty-cart preview: no totals, a clean "add items first" guidance message. */
export function emptyCheckoutPreview(): CheckoutPreviewDTO {
  return {
    preview: true,
    populated: false,
    currency: "ZAR",
    subtotal: null,
    discountTotal: null,
    deliveryFee: null,
    tipAmount: null,
    totalOwing: null,
    total: null,
    fees: [],
    allowASAPDelivery: false,
    deliverySlots: [],
    availablePaymentMethods: [],
    tipPresetsCents: [...CHECKOUT_TIP_PRESETS_CENTS],
    note: CHECKOUT_SELECTION_NOTE,
    message: CHECKOUT_EMPTY_CART_MESSAGE,
  };
}

const MODE_SERVICE_OPTION: Record<string, string> = {
  "sixty-min": "sixty-min-delivery",
  "one-day": "one-day-delivery",
};

/** Map a `--mode` alias to a service option id, or undefined for "all modes". */
export function resolveServiceOption(mode: string | undefined): string | undefined {
  if (!mode) return undefined;
  return MODE_SERVICE_OPTION[mode] ?? mode;
}

/** The fixed `--mode hyper` deferral DTO (no network call, no guess). */
export function hyperSlotsDTO(): HyperSlotsDTO {
  return {
    mode: "hyper",
    supported: false,
    message: HYPER_DEFERRED_MESSAGE,
  };
}

export function mapFirstDeliverySlots(
  raw: RawFirstDeliverySlots,
  stores: StoreContext[],
  serviceOption?: string
): SlotDTO[] {
  const fees = raw.deliveryFeesAndMinimumOrderValues ?? {};
  const build = (mode: string, slot: { startTime?: string; endTime?: string } | null | undefined): SlotDTO => {
    const fee = fees[mode];
    const store = stores.find((s) => (s.serviceOptionIds ?? []).includes(mode));
    return {
      mode,
      storeId: store?.storeId ?? null,
      from: slot?.startTime ?? null,
      to: slot?.endTime ?? null,
      available: Boolean(slot?.startTime),
      asap: mode === "sixty-min-delivery" ? raw.allowASAPDelivery === true : false,
      deliveryFee: typeof fee?.deliveryFee === "number" ? fee.deliveryFee : null,
      minimumOrderValue: typeof fee?.minimumOrderValue === "number" ? fee.minimumOrderValue : null,
    };
  };

  const all: SlotDTO[] = [
    build("sixty-min-delivery", raw.firstAvailableSlotSixtyMin),
    build("one-day-delivery", raw.firstAvailableSlotOneDay),
  ];
  return serviceOption ? all.filter((s) => s.mode === serviceOption) : all;
}

// ─── Orchestration (fetch raw → map to DTOs; commands call only these) ───────

/** Extract a product id from a favourites entry of unknown shape (no PII). */
function extractFavouriteId(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object") {
    const o = entry as { productId?: unknown; id?: unknown; product?: { id?: unknown } };
    if (typeof o.productId === "string") return o.productId;
    if (typeof o.id === "string") return o.id;
    if (o.product && typeof o.product.id === "string") return o.product.id;
  }
  return undefined;
}

export async function getRegulars(
  topN = 20,
  api: CheckersAPI = new CheckersAPI()
): Promise<RegularDTO[]> {
  const scores = (await api.getMyProducts())
    .filter((s) => typeof s.productId === "string" && s.productId.length > 0)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, topN);
  if (scores.length === 0) return [];
  const products = await api.getProductDetails(scores.map((s) => s.productId as string));
  const byId = new Map(products.map((p) => [p.id, p]));
  return scores.map((s) => mapRegular(s, byId.get(s.productId as string)));
}

export async function getCompletedOrders(
  api: CheckersAPI = new CheckersAPI()
): Promise<CompletedOrderDTO[]> {
  return (await api.getCompletedOrders()).map(mapCompletedOrder);
}

/**
 * Preview a past order's line items by id. Account-scoped: completed-orders only
 * returns the caller's own orders, so a ref that isn't in the list yields null
 * (the IDOR guard is inherent — no cross-account id can resolve).
 */
export async function getReorderPreview(
  ref: string,
  api: CheckersAPI = new CheckersAPI()
): Promise<CompletedOrderDTO | null> {
  const found = (await api.getCompletedOrders()).find((o) => o.id === ref);
  return found ? mapCompletedOrder(found) : null;
}

export async function getOrderSummaries(
  all = false,
  api: CheckersAPI = new CheckersAPI()
): Promise<OrderSummaryDTO[]> {
  const groups = (await api.getOrders(!all)) as unknown as RawOrderGroup[];
  return groups.map(mapOrderSummary);
}

/** IDOR guard: only groups from the account's own list can be shown. */
async function findOwnGroup(
  ref: string,
  api: CheckersAPI
): Promise<RawOrderGroup | undefined> {
  const groups = (await api.getOrders(false)) as unknown as RawOrderGroup[];
  return groups.find((g) => g.reference === ref);
}

export async function getOrderDetail(
  ref: string,
  api: CheckersAPI = new CheckersAPI()
): Promise<OrderDetailDTO | null> {
  const group = await findOwnGroup(ref, api);
  return group ? mapOrderDetail(group) : null;
}

export async function getTrack(
  ref: string,
  api: CheckersAPI = new CheckersAPI()
): Promise<TrackDTO | null> {
  const group = await findOwnGroup(ref, api);
  return group ? mapTrack(group) : null;
}

export async function getFavourites(
  api: CheckersAPI = new CheckersAPI()
): Promise<FavouriteDTO[]> {
  const ids = (await api.getFavourites())
    .map(extractFavouriteId)
    .filter((id): id is string => Boolean(id));
  if (ids.length === 0) return [];
  return (await api.getProductDetails(ids)).map(mapFavourite);
}

/**
 * Backup/alternative products for one product id. Only the alternatives the API
 * associates with THIS product are used (`alternativeProductIdMap[productId]` —
 * never a flatten across other products' recommendations). The source id itself
 * is dropped (it is never its own backup), ids are deduplicated, their catalog
 * details fetched, then mapped back in the API's original order; catalog rows
 * for unrequested ids are ignored.
 */
export async function getBackups(
  productId: string,
  api: CheckersAPI = new CheckersAPI()
): Promise<BackupProductDTO[]> {
  const map = await api.getUserAlternatives(productId);
  const raw = Array.isArray(map[productId]) ? map[productId] : [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const id of raw) {
    if (typeof id === "string" && id.length > 0 && id !== productId && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  if (ids.length === 0) return [];
  const products = await api.getProductDetails(ids);
  const byId = new Map(products.map((p) => [p.id, p]));
  return ids
    .filter((id) => byId.has(id))
    .map((id) => mapBackupProduct(byId.get(id) as RawCatalogProduct));
}

function collectReturnGroups(raw: {
  completedReturnGroups?: unknown[];
  inProgressReturnGroups?: unknown[];
}): ReturnGroupDTO[] {
  const groups = [
    ...(raw.inProgressReturnGroups ?? []),
    ...(raw.completedReturnGroups ?? []),
  ] as RawReturnGroup[];
  return groups.map(mapReturnGroup);
}

export async function getReturns(
  api: CheckersAPI = new CheckersAPI()
): Promise<ReturnGroupDTO[]> {
  return collectReturnGroups(await api.getReturns());
}

/** IDOR guard: return detail is resolved from the account's own returns list. */
export async function getReturnDetail(
  id: string,
  api: CheckersAPI = new CheckersAPI()
): Promise<ReturnGroupDTO | null> {
  const found = collectReturnGroups(await api.getReturns()).find((r) => r.id === id);
  return found ?? null;
}

export async function getAddresses(
  api: CheckersAPI = new CheckersAPI()
): Promise<AddressDTO[]> {
  const raw = (await api.getAddresses()) as unknown as RawAddress[];
  return raw.map(mapAddress);
}

export async function getCards(
  api: CheckersAPI = new CheckersAPI()
): Promise<CardDTO[]> {
  const raw = (await api.getCards()) as unknown as RawCardView[];
  return raw.map(mapCard);
}

export async function getSlots(
  mode: string | undefined,
  api: CheckersAPI = new CheckersAPI()
): Promise<SlotDTO[]> {
  const raw = await api.getFirstDeliverySlots();
  return mapFirstDeliverySlots(raw, CONFIG.DEFAULT_STORES, resolveServiceOption(mode));
}

export async function getMembership(
  api: CheckersAPI = new CheckersAPI()
): Promise<MembershipDTO> {
  return mapMembership(await api.getCustomerProfile());
}

export async function getWallet(
  api: CheckersAPI = new CheckersAPI()
): Promise<WalletDTO> {
  return mapWallet(await api.getCustomerProfile());
}

/**
 * Read-only checkout totals preview for the current populated cart, from the
 * captured pre-order response (`getDeliverySlots`) — totals, per-cart delivery
 * slots, delivery fees and available payment methods, all read-only (no
 * place-order, no cart mutation). An empty cart (no totals) yields the
 * empty-cart preview. A persistent server error (e.g. 400) PROPAGATES as a typed
 * error — it is never swallowed into a fake-empty preview.
 */
export async function getCheckoutPreview(
  api: CheckersAPI = new CheckersAPI()
): Promise<CheckoutPreviewDTO> {
  const pre = await api.getDeliverySlots();
  const { totals } = pre;
  if (!totals || typeof totals !== "object" || Object.keys(totals).length === 0) {
    return emptyCheckoutPreview();
  }
  return mapCheckoutPreview(pre);
}

// ── cart deal awareness (savings) ────────────────────────────────────────────
// Read-only view of the bonus-buy deals the current cart touches. A safe
// awareness surface ONLY: it never computes a threshold, an "items to add", a
// progress figure, or a rand saving — a bonus-buy's buy-quantity and saving live
// solely in its human `terms` text (discountValue is 0 for the complex type).

/** Catalog products/filter caps a single request at this many rows. */
const PRODUCT_FILTER_PAGE_SIZE = 50;

/**
 * Map the cart's raw `cartSavings` to the allowlisted DTO, VERBATIM. Each field
 * is copied only when it is a safe integer (cents); anything else becomes null,
 * and an absent/empty envelope yields null — never a fabricated figure.
 */
export function mapCartSavings(raw: RawCartSavings | undefined): CartSavingsDTO | null {
  if (!raw || typeof raw !== "object") return null;
  const productSavings = toCents(raw.productSavings);
  const discountCodesSavings = toCents(raw.discountCodesSavings);
  const totalSavings = toCents(raw.totalSavings);
  if (productSavings === null && discountCodesSavings === null && totalSavings === null) {
    return null;
  }
  return { productSavings, discountCodesSavings, totalSavings };
}

/**
 * True when a deal is live: explicitly active, on sixty60, and inside its
 * validity window. A boundary that is present but invalid (normalized to `null`)
 * fails CLOSED — a deal whose window can't be verified is never surfaced. An
 * absent boundary (`undefined`) is unbounded on that side.
 */
export function isDealActive(deal: BonusBuy, now: number): boolean {
  if (!deal.active || !deal.availableOnSixty60) return false;
  if (deal.startDate === null || deal.endDate === null) return false;
  if (typeof deal.startDate === "number" && now < deal.startDate) return false;
  if (typeof deal.endDate === "number" && now > deal.endDate) return false;
  return true;
}

/**
 * Whether a product's article number is in the deal's qualifying article set.
 * A deal lists article numbers with a trailing unit code (e.g. "10139271EA")
 * while the catalog `articleNumber` is the bare digit core ("10139271"), so an
 * entry also matches when that trailing unit suffix is removed. Exact match is
 * still honoured first; empty values never match.
 */
function articleInSet(article: string | undefined, memberArticleNumbers: string[]): boolean {
  if (!article) return false;
  for (const entry of memberArticleNumbers) {
    if (entry === article) return true;
    const core: string = entry.replace(/[A-Za-z]+$/, "");
    if (core.length > 0 && core === article) return true;
  }
  return false;
}

/** True when this cart line's product belongs to the deal's qualifying set. */
function lineTouchesDeal(
  line: CartLineItem,
  product: Product | undefined,
  deal: BonusBuy
): boolean {
  if (product?.bonusBuyIds?.includes(deal.id)) return true;
  if (deal.memberProductIds.includes(line.productId)) return true;
  return articleInSet(product?.articleNumber, deal.memberArticleNumbers);
}

/**
 * Build a {@link CartDealDTO} from a normalized deal and the cart lines that
 * qualify for it. Qualifying items are aggregated by productId (quantities
 * summed); eligible options are the deal's OTHER member product ids, stably
 * de-duplicated, with every in-cart product removed — ids only, as a hint.
 */
export function mapCartDeal(
  deal: BonusBuy,
  lines: CartLineItem[],
  names: Map<string, string>
): CartDealDTO {
  const byProduct = new Map<string, DealCartItemDTO>();
  for (const line of lines) {
    const existing = byProduct.get(line.productId);
    if (existing) {
      existing.quantity += line.quantity;
    } else {
      byProduct.set(line.productId, {
        productId: line.productId,
        name: names.get(line.productId) ?? null,
        quantity: line.quantity,
      });
    }
  }
  const inCart = new Set(byProduct.keys());
  const eligible: string[] = [];
  const seen = new Set<string>();
  for (const id of deal.memberProductIds) {
    if (!inCart.has(id) && !seen.has(id)) {
      seen.add(id);
      eligible.push(id);
    }
  }
  return {
    dealId: deal.id,
    title: deal.title,
    terms: deal.description,
    validUntil: deal.validUntil ?? null,
    membersOnly: deal.membersOnly,
    qualifyingItemsInCart: [...byProduct.values()],
    eligibleOptionProductIds: eligible,
  };
}

/**
 * Map one raw `missedDiscounts` entry to the allowlisted {@link MissedDealDTO},
 * field-by-field. Every string is copied only when it is genuinely a string
 * (else null); `discountValue` and every unknown/PII field are dropped. Nothing
 * is computed — the buy-quantity/saving stay inside the human description text.
 */
export function mapMissedDeal(raw: RawMissedDiscount): MissedDealDTO {
  return {
    promotionId: typeof raw.promotionId === "string" ? raw.promotionId : null,
    name: typeof raw.name === "string" ? raw.name : null,
    shortDescription: typeof raw.shortDescription === "string" ? raw.shortDescription : null,
    longDescription: typeof raw.longDescription === "string" ? raw.longDescription : null,
    membersOnly: raw.memberType?.code === "fox_members",
    discountTypeCode: typeof raw.discountType?.code === "string" ? raw.discountType.code : null,
  };
}

/**
 * De-duplicate missed deals by a non-empty `promotionId`, keeping the first
 * occurrence in order. Entries with no usable id (null or empty string) are
 * conservatively preserved individually — collapsing them by a shared empty key
 * could drop distinct deals.
 */
export function dedupeMissedDeals(deals: MissedDealDTO[]): MissedDealDTO[] {
  const seen = new Set<string>();
  const out: MissedDealDTO[] = [];
  for (const d of deals) {
    if (d.promotionId) {
      if (seen.has(d.promotionId)) continue;
      seen.add(d.promotionId);
    }
    out.push(d);
  }
  return out;
}

/** Split a list into fixed-size chunks (in order). */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * The deals the current cart touches, as an allowlisted {@link SavingsDTO}.
 * Read-only: reads the cart, then resolves its products' bonus-buy deals via the
 * catalog. Cart products are fetched in <=50-id batches (the catalog's page cap)
 * so a large cart is never silently truncated; deals are de-duplicated by id.
 * `now` is injectable for deterministic active-window tests.
 */
export async function getCartSavings(
  api: CheckersAPI = new CheckersAPI(),
  now: number = Date.now()
): Promise<SavingsDTO> {
  const state = await api.getCart();
  const lines = state.items;
  if (lines.length === 0) {
    return {
      cartItemCount: 0,
      cartSavings: null,
      deals: [],
      missedDeals: [],
      message: SAVINGS_EMPTY_CART_MESSAGE,
    };
  }

  const uniqueIds = [...new Set(lines.map((l) => l.productId))];
  const productById = new Map<string, Product>();
  const dealById = new Map<string, BonusBuy>();
  for (const ids of chunk(uniqueIds, PRODUCT_FILTER_PAGE_SIZE)) {
    const { products, deals } = await api.getProductsWithDeals(ids);
    for (const p of products) if (!productById.has(p.id)) productById.set(p.id, p);
    for (const d of deals) if (!dealById.has(d.id)) dealById.set(d.id, d);
  }

  const names = new Map<string, string>();
  for (const p of productById.values()) {
    if (p.name) names.set(p.id, p.name);
  }

  const activeDeals = [...dealById.values()].filter((d) => isDealActive(d, now));
  const cartDeals: CartDealDTO[] = [];
  for (const deal of activeDeals) {
    const qualifying = lines.filter((l) =>
      lineTouchesDeal(l, productById.get(l.productId), deal)
    );
    if (qualifying.length > 0) cartDeals.push(mapCartDeal(deal, qualifying, names));
  }

  const rawMissed = await api.getCartMissedDiscounts(state.cartId ?? "");
  const missedDeals = dedupeMissedDeals(rawMissed.map(mapMissedDeal));

  return {
    cartItemCount: lines.length,
    cartSavings: mapCartSavings(state.cartSavings),
    deals: cartDeals,
    missedDeals,
    message: null,
  };
}
