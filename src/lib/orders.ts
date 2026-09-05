import {
  CheckersAPI,
  type RawCatalogProduct,
  type RawCompletedOrder,
  type RawCustomerProfile,
  type RawFirstDeliverySlots,
  type RawOrderItem,
  type RawUserProductScore,
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
 * Tracking snapshot for one order (`track`). Detailed live ETA (driver
 * position, precise slot) comes from `order-groups-info`, which is 405 on GET
 * and deferred — so ETA/slot are null here and status comes from orders/groups.
 * Driver name/phone/coordinates are NEVER included.
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
 * `checkout --preview` output. A read-only order-totals preview needs the
 * pre-order totals contract, which was NOT captured (pre-order only returns
 * totals for a populated cart, and no write may populate one). So the command
 * emits this fixed deferral — no network call, and absolutely no place-order,
 * tip, or payment. Mirrors the Hyper-slots deferral.
 */
export interface CheckoutPreviewDTO {
  preview: true;
  supported: false;
  message: string;
}

export const CHECKOUT_PREVIEW_DEFERRED_MESSAGE =
  "checkout totals preview — not supported yet (pre-order totals contract not captured)";

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

/** The fixed `checkout --preview` deferral DTO (no network call, no guess). */
export function checkoutPreviewDTO(): CheckoutPreviewDTO {
  return {
    preview: true,
    supported: false,
    message: CHECKOUT_PREVIEW_DEFERRED_MESSAGE,
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
