import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  COOKIES_PATH,
  BROWSER_STATE_PATH,
  DATA_DIR_PATH,
  config,
  type SessionData,
  type StoreContext,
} from "./config.js";

export function ensureDataDir(): void {
  if (!existsSync(DATA_DIR_PATH)) {
    mkdirSync(DATA_DIR_PATH, { recursive: true });
  }
}

export function saveSession(session: SessionData): void {
  ensureDataDir();
  writeFileSync(COOKIES_PATH, JSON.stringify(session, null, 2));
}

export function loadSession(): SessionData | null {
  if (!existsSync(COOKIES_PATH)) return null;
  try {
    return JSON.parse(readFileSync(COOKIES_PATH, "utf-8"));
  } catch {
    return null;
  }
}

export function saveBrowserState(state: unknown): void {
  ensureDataDir();
  writeFileSync(BROWSER_STATE_PATH, JSON.stringify(state, null, 2));
}

export function loadBrowserState(): unknown | null {
  if (!existsSync(BROWSER_STATE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(BROWSER_STATE_PATH, "utf-8"));
  } catch {
    return null;
  }
}

export function clearSession(): void {
  const fs = await_import_fs();
  for (const p of [COOKIES_PATH, BROWSER_STATE_PATH]) {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  config.clear();
}

export function isSessionValid(): boolean {
  const session = loadSession();
  if (!session) return false;
  // Check if session was saved less than 24h ago (conservative)
  const savedAt = new Date(session.savedAt).getTime();
  const now = Date.now();
  const maxAge = 24 * 60 * 60 * 1000; // 24 hours
  return now - savedAt < maxAge;
}

export function saveUserContext(data: {
  profileId?: string;
  addressId?: string;
  storeContexts?: StoreContext[];
  displayName?: string;
  customerId?: string;
}): void {
  if (data.profileId) config.set("profileId", data.profileId);
  if (data.addressId) config.set("addressId", data.addressId);
  if (data.storeContexts) config.set("storeContexts", data.storeContexts);
  if (data.displayName) config.set("displayName", data.displayName);
  if (data.customerId) config.set("customerId", data.customerId);
}

function await_import_fs() {
  return require("node:fs") as typeof import("node:fs");
}
