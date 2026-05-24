import Conf from "conf";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SessionData {
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: "Strict" | "Lax" | "None";
  }>;
  storageState?: Record<string, string>;
  savedAt: string;
  expiresAt?: string;
}

export interface UserConfig {
  /** Sixty60 user profile id */
  profileId?: string;
  /** Saved delivery address id */
  addressId?: string;
  /** Store contexts for API calls */
  storeContexts?: StoreContext[];
  /** User display name */
  displayName?: string;
  /** Customer ID */
  customerId?: string;
}

export interface StoreContext {
  storeId: string;
  serviceOptionIds: string[];
  brandPriority: number;
  hasCapacity: string[];
  distanceFromCustomer: number;
  returnServiceOptionIds?: string[] | null;
  hasReturnCapacity?: string[] | null;
}

const DATA_DIR = join(homedir(), ".checkers60");

export const config = new Conf<UserConfig>({
  projectName: "checkers60",
  cwd: DATA_DIR,
  configName: "config",
  defaults: {},
});

export const SESSION_PATH = join(DATA_DIR, "session.json");
export const COOKIES_PATH = join(DATA_DIR, "cookies.json");
export const BROWSER_STATE_PATH = join(DATA_DIR, "browser-state.json");
export const DATA_DIR_PATH = DATA_DIR;

export function getStoreContexts(): StoreContext[] {
  return config.get("storeContexts") ?? [];
}
