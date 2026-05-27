import { randomBytes } from "node:crypto";
import {
  CONFIG,
  storeIdList,
  storeIdJsonArray,
  type StoreContext,
} from "./config.js";
import { TokenManager } from "./credentials.js";
import { request, APIError } from "./http.js";

export { APIError };

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
  promotions?: unknown[];
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

export interface Card {
  token?: string;
  issuer?: string;
  maskedCardNumber?: string;
  expiryMonth?: string | number;
  expiryYear?: string | number;
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
    promotions: Array.isArray(raw.promotions) ? raw.promotions : undefined,
  };
}

// ─── Client ────────────────────────────────────────────────────────────────

interface CatalogResponse {
  products?: RawCatalogProduct[];
}

interface CartsResponse {
  carts?: CartEnvelope[];
}

/**
 * Checkers Sixty60 mobile-app API client. Auth is handled by an internal
 * TokenManager; every call lazily resolves a valid user token (refreshing
 * silently, never triggering OTP).
 */
export class CheckersAPI {
  readonly tokens: TokenManager;

  constructor(tokens?: TokenManager) {
    this.tokens = tokens ?? new TokenManager();
  }

  /**
   * Headers required by the sixty60 microservices (orders-api, auth,
   * payments, catalog). All MITM-verified against app v2.0.114.
   */
  private sixty60Headers(
    userToken: string,
    stores?: StoreContext[]
  ): Record<string, string> {
    return {
      authorization: `Bearer ${userToken}`,
      channel: CONFIG.CHANNEL,
      "channel-os": CONFIG.APP_VERSION,
      "app-version": CONFIG.APP_VERSION,
      appversion: CONFIG.APP_VERSION_CODE,
      "istio-appversion": CONFIG.APP_VERSION_CODE,
      "device-id": CONFIG.DEVICE_ID,
      "customer-id": CONFIG.SHOPRITE_UUID,
      userid: CONFIG.SIXTY60_USER_ID,
      mobilenumber: CONFIG.MOBILE,
      email: CONFIG.EMAIL,
      "aws-cf-cd-storeid": storeIdList(stores), // comma-separated
      storeids: storeIdJsonArray(stores), // JSON array
      "istio-storeids": storeIdJsonArray(stores), // JSON array
    };
  }

  private async headers(stores?: StoreContext[]): Promise<Record<string, string>> {
    const user = await this.tokens.getUserToken();
    return this.sixty60Headers(user, stores);
  }

  /** Throws a helpful error when the sixty60 user ID is required but unset. */
  private requireUserId(): string {
    if (!CONFIG.SIXTY60_USER_ID) {
      throw new Error(
        "Missing sixty60 user ID. Set CHECKERS60_USER_ID, or log in again to populate it."
      );
    }
    return CONFIG.SIXTY60_USER_ID;
  }

  // ── Product search (catalog.sixty60.co.za) ──────────────────────────────

  async searchProducts(
    query: string,
    opts: { page?: number; pageSize?: number; stores?: StoreContext[] } = {}
  ): Promise<Product[]> {
    const { page = 0, pageSize = 20, stores } = opts;
    const headers = await this.headers(stores);

    const body = {
      filter: {
        showAllDisplayVariants: false,
        showNotRangedProducts: false,
        productListSource: { search: query },
        paginationOptions: { page, pageSize },
        filterOptions: {
          dealsOnly: false,
          serviceOptions: [],
          brandOptions: [],
          departmentOptions: [],
          facetOptions: [],
          filterIds: [],
        },
      },
      userContext: {
        storeContexts: stores ?? CONFIG.DEFAULT_STORES,
        userId: CONFIG.SIXTY60_USER_ID,
        location: CONFIG.USER_LOCATION,
      },
    };

    const t = Date.now();
    const res = await request<CatalogResponse>(
      "POST",
      `${CONFIG.CATALOG_API}/api/v3/products/filter?isCarousel=false&includePromotions=true&promotionChannel=sixty60&isXtraSavings=true&isXtraSavingsMember=true&particularMemberBonusBuyIds=&t=${t}`,
      { headers, form: body } // app quirk: form-urlencoded JSON body
    );

    return (res.data?.products ?? []).map(mapCatalogProduct);
  }

  /** Fetch raw product details by ID (one or many). */
  async getProductDetails(productIds: string | string[]): Promise<RawCatalogProduct[]> {
    const ids = Array.isArray(productIds) ? productIds : [productIds];
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
      { headers, json: body }
    );
    return res.data?.products ?? [];
  }

  // ── Cart (orders-api.sixty60.co.za) ─────────────────────────────────────

  async getCart(stores?: StoreContext[]): Promise<CartState> {
    const headers = await this.headers(stores);
    const storeContexts = stores ?? CONFIG.DEFAULT_STORES;

    const res = await request<CartsResponse>(
      "POST",
      `${CONFIG.ORDERS_API}/api/v2/carts/user?useProductMinInfoAnnotation=true`,
      { headers, json: { storeContexts } }
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
   * Replace the cart's line items. The API ignores omitted items, so to remove
   * something you must include it with quantity 0.
   */
  async updateCart(
    cartId: string,
    items: CartItemInput[],
    addressId?: string
  ): Promise<CartState> {
    const headers = await this.headers();

    const lineItems = items.map((item) => ({
      id: item.lineItemId ?? objectId(),
      status: "available",
      price: item.price,
      priceFactor: item.priceFactor ?? 100,
      previousPrice: 0,
      productId: item.productId,
      instruction: "",
      quantity: item.quantity,
      specialInstruction: "",
      storeId: item.storeId ?? CONFIG.DEFAULT_STORES[0].storeId,
      replacementPreferenceId: "",
      missionName: "",
      missionType: "",
      addToBasketType: "pdp_add_to_basket",
      addToBasketJourney: "main_search_results",
      serviceOptionId: "sixty-min-delivery",
      isStockAvailable: true,
      requiresOver18: false,
      isSponsoredProduct: false,
      hasAlcohol: false,
      product: null,
    }));

    const body = {
      carts: [{ id: cartId, serviceOptionId: "sixty-min-delivery", lineItems }],
      deliveryAddressId: addressId ?? CONFIG.DEFAULT_ADDRESS_ID,
      storeContexts: CONFIG.DEFAULT_STORES,
    };

    const res = await request<CartsResponse>(
      "POST",
      `${CONFIG.ORDERS_API}/api/v3/carts/update?useProductMinInfoAnnotation=true`,
      { headers, form: body } // app quirk: form-urlencoded JSON body
    );

    if (!res.data?.carts) {
      throw new Error(`Cart update failed: ${JSON.stringify(res.data)}`);
    }
    const cart = res.data.carts[0]?.item;
    return {
      carts: res.data.carts,
      cartId: cart?.id ?? cartId,
      cartVersion: cart?.cartVersion ?? 0,
      items: cart?.lineItems ?? [],
    };
  }

  /** Empty the cart by setting every line item's quantity to 0. */
  async clearCart(cartId: string, addressId?: string): Promise<CartState> {
    const { items } = await this.getCart();
    if (items.length === 0) {
      return { carts: [], cartId, cartVersion: 0, items: [] };
    }
    return this.updateCart(
      cartId,
      items.map((i) => ({
        productId: i.productId,
        quantity: 0,
        price: i.price,
        storeId: i.storeId,
        lineItemId: i.id,
      })),
      addressId
    );
  }

  // ── Addresses & cards (auth.sixty60.co.za) ──────────────────────────────

  async getAddresses(): Promise<Address[]> {
    const userId = this.requireUserId();
    const headers = await this.headers();
    const res = await request<{ items?: Address[] }>(
      "GET",
      `${CONFIG.AUTH_API}/customers/${userId}/addresses`,
      { headers }
    );
    return res.data?.items ?? [];
  }

  async getPaymentCards(): Promise<Card[]> {
    const userId = this.requireUserId();
    const headers = await this.headers();
    const res = await request<{ cards?: Card[] }>(
      "GET",
      `${CONFIG.AUTH_API}/customers/${userId}/cards`,
      { headers }
    );
    return res.data?.cards ?? [];
  }

  // ── Orders (orders-api.sixty60.co.za) ───────────────────────────────────

  async getOrders(activeOnly = true): Promise<OrderGroup[]> {
    const headers = await this.headers();
    const res = await request<{ orderGroups?: OrderGroup[] }>(
      "GET",
      `${CONFIG.ORDERS_API}/api/v1/orders/groups?activeOnly=${activeOnly}`,
      { headers }
    );
    return res.data?.orderGroups ?? [];
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
    const user = await this.tokens.getUserToken();
    const res = await request<{ response?: { user?: UserProfile } }>(
      "GET",
      `${CONFIG.SHOPRITE_BASE}/users`,
      {
        headers: {
          "x-api-key": CONFIG.X_API_KEY_USER,
          access_token: user,
          channel: CONFIG.CHANNEL,
          "channel-os": CONFIG.APP_VERSION,
          "app-version": CONFIG.APP_VERSION,
          appversion: CONFIG.APP_VERSION_CODE,
          "device-id": CONFIG.DEVICE_ID,
          "customer-id": CONFIG.SHOPRITE_UUID,
        },
      }
    );
    return res.data?.response?.user;
  }

  /** Build a catalog image URL for a product image id. */
  imageUrl(imageId: string, size = 156): string {
    return `${CONFIG.CATALOG_API}/v2/files/${imageId}?width=${size}&height=${size}`;
  }
}
