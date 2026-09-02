import { readFileSync, existsSync } from "node:fs";
import { CONFIG } from "./config.js";
import { getDeviceId } from "./runtime.js";
import { request, APIError } from "./http.js";
import {
  withCredentialsLock,
  updateBffTokenLocked,
  updateUserTokensLocked,
  updateOtpResultLocked,
  updateIdentityLocked,
  clearCredentialsStore,
  type CredentialsFile,
  type LockedContext,
} from "./creds-store.js";

export type { CredentialsFile };

/** Read-only load. Degrades to logged-out ({}) on a missing/corrupt file. */
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

/**
 * Delete the saved credentials (used by `logout`). Runs under the credential
 * lock and PRESERVES `device_id` so logout doesn't rotate the installation
 * identity. Returns whether anything was cleared.
 */
export function clearCredentials(): Promise<boolean> {
  return clearCredentialsStore();
}

interface ShopriteTokenResponse {
  response?: {
    accessToken?: string;
    refreshToken?: string;
    expiresIn?: number;
    reference?: string;
  };
}

const NOT_LOGGED_IN =
  "Not logged in. Run: checkers60 otp-trigger, then checkers60 otp-verify <reference> <code>";

/**
 * Manages the three tokens the mobile API needs:
 *  - BFF Cognito JWT (24h, no auth required to obtain)
 *  - user access token (from OTP login, ~1h, auto-refreshes)
 *  - refresh token (long-lived, used to mint new access tokens)
 *
 * All persistence goes through the locked credential store (`creds-store.ts`):
 * field-scoped, atomic, cross-process safe. In-memory fields are adopted from
 * the committed on-disk state returned by each transaction. OTP is NEVER
 * triggered automatically — callers use the explicit two-step
 * `otp-trigger` / `otp-verify` flow.
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
    this.adopt(c);
    // Credentials file overrides env defaults for these identity fields.
    if (c.sixty60_user_id) CONFIG.SIXTY60_USER_ID = c.sixty60_user_id;
    if (c.profile_token) CONFIG.PROFILE_TOKEN = c.profile_token;
  }

  /** Adopt in-memory token fields from committed on-disk state. */
  private adopt(c: CredentialsFile): void {
    this.bffToken = c.bff_token ?? null;
    this.bffExpiry = c.bff_expiry ?? 0;
    this.userToken = c.user_token ?? null;
    this.refreshToken = c.refresh_token ?? null;
    this.userExpiry = c.user_expiry ?? 0;
  }

  /** True if a non-expired user token (or a refresh token) is available. */
  isAuthenticated(): boolean {
    if (this.userToken && Date.now() < this.userExpiry) return true;
    return Boolean(this.refreshToken);
  }

  /**
   * Ensure a valid BFF Cognito JWT inside an existing transaction (no re-lock).
   * Reads fresh disk, refreshes over the network with `ctx.signal`, persists via
   * `updateBffTokenLocked`, and returns the token.
   */
  async getBFFTokenLocked(ctx: LockedContext): Promise<string> {
    const disk = await ctx.read();
    if (disk.bff_token && Date.now() < (disk.bff_expiry ?? 0) - 60_000) {
      return disk.bff_token;
    }

    const res = await request<{ access_token?: string; expires_in?: number }>(
      "POST",
      `${CONFIG.BFF_BASE}/token/dsl`,
      {
        headers: {
          channel: CONFIG.CHANNEL,
          "device-id": getDeviceId(),
          "content-length": "0",
        },
        signal: ctx.signal,
      }
    );
    if (!res.data?.access_token) {
      throw new Error("BFF token request failed");
    }

    const bffToken = res.data.access_token;
    const bffExpiry = Date.now() + (res.data.expires_in ?? 86_400) * 1000;
    const committed = await updateBffTokenLocked(ctx, { bffToken, bffExpiry });
    this.adopt(committed);
    return bffToken;
  }

  /**
   * Get the BFF Cognito JWT (24h lifetime, no auth needed). With a locked `ctx`
   * runs inside the existing transaction; without, opens its own transaction.
   */
  async getBFFToken(ctx?: LockedContext): Promise<string> {
    if (ctx) return this.getBFFTokenLocked(ctx);
    return withCredentialsLock((c) => this.getBFFTokenLocked(c));
  }

  /**
   * Get a valid user access token. Refreshes via the refresh token if needed,
   * but NEVER triggers an OTP. Throws if not logged in.
   *
   * Exact reconciliation sequence (§3.1): acquire the lock, read fresh disk,
   * honor logout (no refresh token → logged out; never resurrect from memory),
   * adopt any still-valid disk token without a network call, otherwise refresh
   * against the authoritative disk refresh token (passing `ctx.signal`) and
   * persist the new triple, keeping the old refresh token when the response
   * omits a new one.
   */
  async getUserToken(): Promise<string> {
    const committed = await withCredentialsLock(async (ctx) => {
      const disk = await ctx.read();

      // Honor logout/deletion: no refresh token on disk → logged out.
      if (!disk.refresh_token) {
        throw new Error(NOT_LOGGED_IN);
      }

      // Adopt a still-valid disk token with no network call — even if it equals
      // memory (never refresh a valid identical token). Never use `updated_at`.
      if (disk.user_token && Date.now() < (disk.user_expiry ?? 0) - 60_000) {
        return disk;
      }

      const baseRefresh = disk.refresh_token;
      const bff = await this.getBFFTokenLocked(ctx);
      const res = await request<ShopriteTokenResponse>(
        "GET",
        `${CONFIG.SHOPRITE_BASE}/tokens?refreshToken=${encodeURIComponent(baseRefresh)}`,
        { headers: this.shopriteHeaders(bff), signal: ctx.signal }
      );
      const r = res.data?.response;
      if (!r?.accessToken) {
        throw new Error("Token refresh failed");
      }

      return updateUserTokensLocked(ctx, {
        userToken: r.accessToken,
        // Never erase a still-valid refresh token when the response omits one.
        refreshToken: r.refreshToken ?? baseRefresh,
        userExpiry: Date.now() + (r.expiresIn ?? 3600) * 1000,
      });
    });

    this.adopt(committed);
    if (!committed.user_token) throw new Error(NOT_LOGGED_IN);
    return committed.user_token;
  }

  /**
   * Step 1 of login: send an OTP SMS to the configured mobile number. Not inside
   * the user-refresh lock; obtains a BFF token via its own transaction.
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
      throw new Error("OTP trigger failed");
    }
    return reference;
  }

  /**
   * Step 2 of login: verify the OTP code and persist the resulting tokens. The
   * network verify runs OUTSIDE the user-refresh lock; the write uses its own
   * transaction (`updateOtpResult` + `updateIdentity`).
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
      throw new Error("OTP verify failed");
    }

    const committed = await withCredentialsLock(async (ctx) => {
      await updateOtpResultLocked(ctx, {
        userToken: r.accessToken ?? null,
        refreshToken: r.refreshToken ?? null,
        userExpiry: Date.now() + (r.expiresIn ?? 3600) * 1000,
      });
      return updateIdentityLocked(ctx, {
        mobile: CONFIG.MOBILE,
        customer_id: CONFIG.SHOPRITE_UUID,
        sixty60_user_id: CONFIG.SIXTY60_USER_ID,
        profile_token: CONFIG.PROFILE_TOKEN,
      });
    });
    this.adopt(committed);
  }

  /** Shoprite DSL auth headers (used for the BFF-token-protected endpoints). */
  shopriteHeaders(bffToken: string): Record<string, string> {
    return {
      authorization: `Bearer ${bffToken}`,
      "x-api-key": CONFIG.X_API_KEY_USER,
      channel: CONFIG.CHANNEL,
      "app-version": CONFIG.APP_VERSION,
      appversion: CONFIG.APP_VERSION_CODE,
      "device-id": getDeviceId(),
    };
  }
}

export { APIError };
