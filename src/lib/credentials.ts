import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import { dirname } from "node:path";
import { CONFIG } from "./config.js";
import { request, APIError } from "./http.js";

/**
 * Shape of the on-disk credentials file
 * (~/.openclaw/credentials/checkers60.json).
 */
export interface CredentialsFile {
  bff_token?: string | null;
  bff_expiry?: number;
  user_token?: string | null;
  refresh_token?: string | null;
  user_expiry?: number;
  mobile?: string;
  customer_id?: string;
  sixty60_user_id?: string;
  profile_token?: string;
  updated_at?: string;
}

export function loadCredentials(): CredentialsFile {
  try {
    if (existsSync(CONFIG.CREDS_PATH)) {
      return JSON.parse(readFileSync(CONFIG.CREDS_PATH, "utf8")) as CredentialsFile;
    }
  } catch {
    // treat unreadable/corrupt credentials as absent
  }
  return {};
}

/** Delete the saved credentials file (used by `logout`). */
export function clearCredentials(): boolean {
  if (existsSync(CONFIG.CREDS_PATH)) {
    unlinkSync(CONFIG.CREDS_PATH);
    return true;
  }
  return false;
}

interface ShopriteTokenResponse {
  response?: {
    accessToken?: string;
    refreshToken?: string;
    expiresIn?: number;
    reference?: string;
  };
}

/**
 * Manages the three tokens the mobile API needs:
 *  - BFF Cognito JWT (24h, no auth required to obtain)
 *  - user access token (from OTP login, ~1h, auto-refreshes)
 *  - refresh token (long-lived, used to mint new access tokens)
 *
 * OTP is NEVER triggered automatically — callers must use the explicit
 * two-step `otp-trigger` / `otp-verify` flow.
 */
export class TokenManager {
  bffToken: string | null = null;
  bffExpiry = 0;
  userToken: string | null = null;
  refreshToken: string | null = null;
  userExpiry = 0;

  constructor() {
    this.load();
  }

  private load(): void {
    const c = loadCredentials();
    this.bffToken = c.bff_token ?? null;
    this.bffExpiry = c.bff_expiry ?? 0;
    this.userToken = c.user_token ?? null;
    this.refreshToken = c.refresh_token ?? null;
    this.userExpiry = c.user_expiry ?? 0;
    // Credentials file overrides env defaults for these identity fields.
    if (c.sixty60_user_id) CONFIG.SIXTY60_USER_ID = c.sixty60_user_id;
    if (c.profile_token) CONFIG.PROFILE_TOKEN = c.profile_token;
  }

  save(): void {
    // Merge with any existing file to preserve unknown fields.
    const existing = loadCredentials();
    const creds: CredentialsFile = {
      ...existing,
      bff_token: this.bffToken,
      bff_expiry: this.bffExpiry,
      user_token: this.userToken,
      refresh_token: this.refreshToken,
      user_expiry: this.userExpiry,
      mobile: CONFIG.MOBILE || existing.mobile,
      customer_id: CONFIG.SHOPRITE_UUID || existing.customer_id,
      sixty60_user_id: CONFIG.SIXTY60_USER_ID || existing.sixty60_user_id,
      profile_token: CONFIG.PROFILE_TOKEN,
      updated_at: new Date().toISOString(),
    };
    const dir = dirname(CONFIG.CREDS_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(CONFIG.CREDS_PATH, JSON.stringify(creds, null, 2));
  }

  /** True if a non-expired user token (or a refresh token) is available. */
  isAuthenticated(): boolean {
    if (this.userToken && Date.now() < this.userExpiry) return true;
    return Boolean(this.refreshToken);
  }

  /** Get the BFF Cognito JWT (24h lifetime, no auth needed). */
  async getBFFToken(): Promise<string> {
    if (this.bffToken && Date.now() < this.bffExpiry - 60_000) return this.bffToken;

    const res = await request<{ access_token?: string; expires_in?: number }>(
      "POST",
      `${CONFIG.BFF_BASE}/token/dsl`,
      {
        headers: {
          channel: CONFIG.CHANNEL,
          "device-id": CONFIG.DEVICE_ID,
          "content-length": "0",
        },
      }
    );
    if (!res.data?.access_token) {
      throw new Error(`BFF token request failed: ${JSON.stringify(res.data)}`);
    }

    this.bffToken = res.data.access_token;
    this.bffExpiry = Date.now() + (res.data.expires_in ?? 86_400) * 1000;
    this.save();
    return this.bffToken;
  }

  /**
   * Get a valid user access token. Refreshes via the refresh token if needed,
   * but NEVER triggers an OTP. Throws if no refresh token is available.
   */
  async getUserToken(): Promise<string> {
    if (this.userToken && Date.now() < this.userExpiry - 60_000) return this.userToken;

    if (this.refreshToken) {
      const bff = await this.getBFFToken();
      const res = await request<ShopriteTokenResponse>(
        "GET",
        `${CONFIG.SHOPRITE_BASE}/tokens?refreshToken=${encodeURIComponent(this.refreshToken)}`,
        { headers: this.shopriteHeaders(bff) }
      );
      const r = res.data?.response;
      if (r?.accessToken) {
        this.userToken = r.accessToken;
        this.refreshToken = r.refreshToken ?? this.refreshToken;
        this.userExpiry = Date.now() + (r.expiresIn ?? 3600) * 1000;
        this.save();
        return this.userToken;
      }
    }

    throw new Error(
      "Not logged in. Run: checkers60 otp-trigger, then checkers60 otp-verify <reference> <code>"
    );
  }

  /**
   * Step 1 of login: send an OTP SMS to the configured mobile number.
   * Returns the reference needed for verification.
   */
  async triggerOtp(): Promise<string> {
    if (!CONFIG.MOBILE) {
      throw new Error(
        "No mobile number configured. Set CHECKERS60_MOBILE (e.g. +27821234567)."
      );
    }
    const bff = await this.getBFFToken();
    const res = await request<ShopriteTokenResponse>(
      "GET",
      `${CONFIG.SHOPRITE_BASE}/users/loginbymobile?mobileNumber=${encodeURIComponent(CONFIG.MOBILE)}`,
      { headers: this.shopriteHeaders(bff) }
    );
    const reference = res.data?.response?.reference;
    if (!reference) {
      throw new Error(`OTP trigger failed: ${JSON.stringify(res.data)}`);
    }
    return reference;
  }

  /**
   * Step 2 of login: verify the OTP code against the reference from step 1
   * and persist the resulting user + refresh tokens.
   */
  async verifyOtp(reference: string, otp: string): Promise<void> {
    if (!CONFIG.MOBILE) {
      throw new Error(
        "No mobile number configured. Set CHECKERS60_MOBILE (e.g. +27821234567)."
      );
    }
    const bff = await this.getBFFToken();
    const res = await request<ShopriteTokenResponse>(
      "POST",
      `${CONFIG.SHOPRITE_BASE}/otp/loginbymobile/verify`,
      {
        headers: this.shopriteHeaders(bff),
        json: {
          target: { type: "SMS", identifier: CONFIG.MOBILE, reference },
          otp,
        },
      }
    );
    const r = res.data?.response;
    if (!r?.accessToken) {
      throw new Error(`OTP verify failed: ${JSON.stringify(res.data)}`);
    }
    this.userToken = r.accessToken;
    this.refreshToken = r.refreshToken ?? null;
    this.userExpiry = Date.now() + (r.expiresIn ?? 3600) * 1000;
    this.save();
  }

  /** Shoprite DSL auth headers (used for the BFF-token-protected endpoints). */
  shopriteHeaders(bffToken: string): Record<string, string> {
    return {
      authorization: `Bearer ${bffToken}`,
      "x-api-key": CONFIG.X_API_KEY_USER,
      channel: CONFIG.CHANNEL,
      "app-version": CONFIG.APP_VERSION,
      appversion: CONFIG.APP_VERSION_CODE,
      "device-id": CONFIG.DEVICE_ID,
    };
  }
}

export { APIError };
