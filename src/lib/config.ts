import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Static + environment-derived configuration for the Checkers Sixty60
 * MOBILE APP API (Android app `za.co.shoprite.sixty60` v2.0.114).
 *
 * Every host, key and header value here was reverse-engineered from MITM
 * captures of the real app. The companion reference implementation lives at
 * ~/.openclaw/workspace/skills/checkers60/api-client.js and is the source of
 * truth for endpoints, headers and body formats.
 */

export interface StoreContext {
  storeId: string;
  serviceOptionIds: string[];
  brandPriority: number;
  hasCapacity: string[];
  distanceFromCustomer: number;
  returnServiceOptionIds?: string[] | null;
  hasReturnCapacity?: string[] | null;
}

export interface UserLocation {
  latitude: number;
  longitude: number;
}

/**
 * Default store contexts — MITM-captured from the v2.0.114 geo-lookup for the
 * Rondebosch (Cape Town) area. Override with CHECKERS60_STORES (a JSON array).
 */
const DEFAULT_STORES: StoreContext[] = [
  {
    storeId: "5d3b1d78e2f18700089552a8",
    serviceOptionIds: ["sixty-min-delivery"],
    brandPriority: 5,
    hasCapacity: ["sixty-min-delivery"],
    distanceFromCustomer: 0.16532704784337177,
    returnServiceOptionIds: null,
    hasReturnCapacity: null,
  },
  {
    storeId: "68badc92c485d435f1cb35b5",
    serviceOptionIds: ["sixty-min-delivery"],
    brandPriority: 12,
    hasCapacity: ["sixty-min-delivery"],
    distanceFromCustomer: 0.16532704784337177,
    returnServiceOptionIds: null,
    hasReturnCapacity: null,
  },
  {
    storeId: "5d3b1d53e2f1870008949951",
    serviceOptionIds: ["sixty-min-delivery"],
    brandPriority: 1,
    hasCapacity: ["sixty-min-delivery"],
    distanceFromCustomer: 0.16532704784337177,
    returnServiceOptionIds: null,
    hasReturnCapacity: null,
  },
  {
    storeId: "60dc2d30c1f98d8e2a812b9e",
    serviceOptionIds: ["one-day-delivery"],
    brandPriority: 2,
    hasCapacity: ["sixty-min-delivery", "one-day-delivery"],
    distanceFromCustomer: 6.873961778384581,
    returnServiceOptionIds: null,
    hasReturnCapacity: ["one-day-collection"],
  },
];

function loadStores(): StoreContext[] {
  const raw = process.env.CHECKERS60_STORES;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed as StoreContext[];
    } catch {
      // fall through to defaults on malformed env
    }
  }
  return DEFAULT_STORES;
}

const env = process.env;

/**
 * Mutable config singleton. A few fields (SIXTY60_USER_ID, PROFILE_TOKEN) may
 * be overridden at runtime from the saved credentials file by the TokenManager.
 */
export const CONFIG = {
  // ── Service hosts ────────────────────────────────────────────────────────
  SHOPRITE_BASE: "https://api.shopritegroup.co.za/dsl/brands/checkers/countries/ZA",
  BFF_BASE: "https://dc-app-backend-for-frontend.sixty60.co.za/api/v1",
  ORDERS_API: "https://orders-api.sixty60.co.za",
  AUTH_API: "https://auth.sixty60.co.za",
  PAYMENTS_API: "https://payments.sixty60.co.za",
  CATALOG_API: "https://catalog.sixty60.co.za",

  // ── App API keys (public client keys embedded in the APK) ────────────────
  X_API_KEY_PUBLIC: "5y2GIJ8RoP8dm5FxUtsBZ66OfvAZ8Njh3Pjaj9WF",
  X_API_KEY_USER: "HbFTqw6RLe4T3gbgGLb7X2qM08viEJlN3Amyq40z",
  PROFILE_TOKEN: "G5tmYwwRnpfPmtJ3HT7VYV7C4x86NGDz",

  // ── App identity ─────────────────────────────────────────────────────────
  CHANNEL: "super-app",
  APP_VERSION: "Android 2.0.114 (1778865226)",
  APP_VERSION_CODE: "1778865226",
  DEVICE_ID: env.CHECKERS60_DEVICE_ID || "e0ce1cc2565366d7",
  USER_AGENT: "okhttp/4.12.0",

  // ── User identity (from env; two distinct IDs) ───────────────────────────
  SHOPRITE_UUID: env.CHECKERS60_SHOPRITE_UUID || "", // Shoprite customer UUID
  SIXTY60_USER_ID: env.CHECKERS60_USER_ID || "", // sixty60 internal user ID
  MOBILE: env.CHECKERS60_MOBILE || "", // e.g. '+27...'
  EMAIL: env.CHECKERS60_EMAIL || "",
  FIRST_NAME: env.CHECKERS60_FIRST_NAME || "",
  LAST_NAME: env.CHECKERS60_LAST_NAME || "",

  // ── User location (Cape Town default) ────────────────────────────────────
  USER_LOCATION: { latitude: -33.9645921, longitude: 18.4695059 } as UserLocation,

  // ── Stores & address ─────────────────────────────────────────────────────
  DEFAULT_STORES: loadStores(),
  DEFAULT_ADDRESS_ID: env.CHECKERS60_ADDRESS_ID || "698c4f79d84d00735d939233",

  // ── OTP relay (optional SMS-to-HTTPS relay) ──────────────────────────────
  OTP_RELAY_URL: env.CHECKERS60_OTP_RELAY_URL || "",
  OTP_RELAY_TOKEN: env.CHECKERS60_OTP_RELAY_TOKEN || "otp-relay-k1a4n-2026",

  // ── Credentials path ─────────────────────────────────────────────────────
  CREDS_PATH:
    env.CHECKERS60_CREDS_PATH ||
    join(homedir(), ".openclaw", "credentials", "checkers60.json"),
};

export function getStoreContexts(): StoreContext[] {
  return CONFIG.DEFAULT_STORES;
}

/** Store IDs as a comma-separated string (aws-cf-cd-storeid header). */
export function storeIdList(stores?: StoreContext[]): string {
  return (stores ?? CONFIG.DEFAULT_STORES).map((s) => s.storeId).join(",");
}

/** Store IDs as a JSON array string (storeids / istio-storeids headers). */
export function storeIdJsonArray(stores?: StoreContext[]): string {
  return JSON.stringify((stores ?? CONFIG.DEFAULT_STORES).map((s) => s.storeId));
}
