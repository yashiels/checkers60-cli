import { readFileSync, existsSync } from "node:fs";
import { CONFIG } from "./config.js";
import { getDeviceId } from "./runtime.js";
import { request, APIError } from "./http.js";
import {
  withCredentialsLock,
  updateBffTokenLocked,
  updateSessionLocked,
  clearCredentialsStore,
  readCredentials,
  type CredentialsFile,
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

/**
 * An immutable snapshot of the committed session identity, built from ONE disk
 * read. Every header builder AND request body that needs identity reads from
 * this snapshot — never from the mutable CONFIG singleton — so a concurrent
 * account switch can never cross-mix ids within a single call.
 */
export interface SessionContext {
  /** sixty60 session token (1h) — bearer for orders/catalog/returns/payments. */
  sessionToken: string;
  /** sixty60 internal userId (Mongo id) — the `userid` header + search body. */
  userId: string;
  /** Shoprite customer UUID — the `customer-id` header. */
  uuid: string;
  mobile: string;
  /** DSL customerId (e.g. `000C3V55`) — used to re-fetch the customer profile. */
  customerId: string;
}

const NOT_LOGGED_IN =
  "Not logged in. Run: checkers60 otp-trigger, then checkers60 otp-verify <reference> <code>";

/** Local expiry skew: treat a session as expired this long before its real deadline. */
const EXPIRY_SKEW_MS = 60_000;

/** Minimum acceptable session lifetime (seconds). Sub-skew sessions are unusable. */
const MIN_SESSION_LIFETIME_S = 60;

/**
 * Validate the server-reported lifetime and compute an absolute expiry timestamp.
 * Accepts `expiresIn` ONLY when it is a finite number strictly greater than 60s,
 * and only when `now + expiresIn*1000` is a finite, safe integer (no overflow).
 * Throws otherwise — the caller must fail login with NO commit (never default).
 */
export function computeSessionExpiry(expiresIn: unknown, now = Date.now()): number {
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn)) {
    throw new Error("Login failed: server returned an invalid session lifetime.");
  }
  if (expiresIn <= MIN_SESSION_LIFETIME_S) {
    throw new Error("Login failed: session lifetime too short to use.");
  }
  const expiry = now + expiresIn * 1000;
  if (!Number.isFinite(expiry) || !Number.isSafeInteger(expiry)) {
    throw new Error("Login failed: computed session expiry is out of range.");
  }
  return expiry;
}

/**
 * Manages the two tokens the sixty60 mobile API needs:
 *  - BFF Cognito JWT (24h, client-credentials, no user) — obtained from
 *    `POST {BFF_BASE}/token/dsl`; used only to authorize the login endpoints.
 *  - the sixty60 SESSION token (1h, no refresh token) — the bearer for
 *    catalog/orders/returns/payments and the `access_token` for the DSL profile.
 *
 * Login is a fixed sequence run against the BFF (OTP verify → session token),
 * BFF /users/verify (customerId), the auth-host customer profile (internal
 * userId), and the DSL /users lookup (shoprite uuid + a customerId cross-check).
 * ALL network calls run OUTSIDE the credential lock; only the final atomic
 * commit runs inside it. There is no refresh flow — an expired session is a
 * logged-out state and requires a fresh OTP login.
 */
export class TokenManager {
  bffToken: string | null = null;
  bffExpiry = 0;
  sessionToken: string | null = null;
  sessionExpiry = 0;

  constructor() {
    this.load();
  }

  private load(): void {
    this.adopt(loadCredentials());
  }

  /** Adopt in-memory token fields from committed on-disk state. */
  private adopt(c: CredentialsFile): void {
    this.bffToken = c.bff_token ?? null;
    this.bffExpiry = c.bff_expiry ?? 0;
    this.sessionToken = c.session_token ?? null;
    this.sessionExpiry = c.session_expiry ?? 0;
  }

  /**
   * True only when a non-expired SESSION token exists. Legacy DSL fields
   * (`user_token`/`refresh_token`) never make this true.
   */
  isAuthenticated(): boolean {
    return Boolean(this.sessionToken && Date.now() < this.sessionExpiry);
  }

  /** True when `c` holds a still-valid (non-skew) BFF token. */
  private bffTokenFresh(c: CredentialsFile): boolean {
    return Boolean(c.bff_token && Date.now() < (c.bff_expiry ?? 0) - EXPIRY_SKEW_MS);
  }

  /**
   * Get the BFF Cognito JWT (24h lifetime, no user auth). The `/token/dsl`
   * network fetch is performed WITHOUT holding the credentials lock, so it can
   * never block other credential operations for the request duration:
   *   1. check fresh disk under a brief lock (no network);
   *   2. release, then fetch `/token/dsl` unlocked;
   *   3. reacquire, re-check (adopt a token another process wrote meanwhile),
   *      else atomically persist the fetched one.
   */
  async getBFFToken(): Promise<string> {
    const cached = await withCredentialsLock(async (ctx) => {
      const disk = await ctx.read();
      if (this.bffTokenFresh(disk)) {
        this.adopt(disk);
        return disk.bff_token as string;
      }
      return null;
    });
    if (cached) return cached;

    // Fetch OUTSIDE the lock.
    const res = await request<{ access_token?: string; expires_in?: number }>(
      "POST",
      `${CONFIG.BFF_BASE}/token/dsl`,
      {
        headers: {
          channel: CONFIG.CHANNEL,
          "device-id": getDeviceId(),
          "content-length": "0",
        },
      }
    );
    if (!res.data?.access_token) {
      throw new Error("BFF token request failed");
    }
    const bffToken = res.data.access_token;
    const bffExpiry = Date.now() + (res.data.expires_in ?? 86_400) * 1000;

    return withCredentialsLock(async (ctx) => {
      const disk = await ctx.read();
      if (this.bffTokenFresh(disk)) {
        // Another process fetched while we were unlocked — adopt the fresher one.
        this.adopt(disk);
        return disk.bff_token as string;
      }
      const committed = await updateBffTokenLocked(ctx, { bffToken, bffExpiry });
      this.adopt(committed);
      return bffToken;
    });
  }

  /**
   * Build the committed session identity from a SINGLE disk read
   * (disk-authoritative, like the old getUserToken reconciliation): no session
   * token on disk → logged out; honor a 60s expiry skew; throw NOT_LOGGED_IN on
   * expiry. There is NO refresh — an expired session is a logged-out state.
   */
  async getSession(): Promise<SessionContext> {
    const disk = await readCredentials(CONFIG.CREDS_PATH);
    if (!disk.session_token) {
      throw new Error(NOT_LOGGED_IN);
    }
    if (Date.now() >= (disk.session_expiry ?? 0) - EXPIRY_SKEW_MS) {
      throw new Error(NOT_LOGGED_IN);
    }
    this.adopt(disk);
    return {
      sessionToken: disk.session_token,
      userId: disk.sixty60_user_id ?? "",
      uuid: disk.shoprite_uuid ?? "",
      mobile: disk.mobile ?? "",
      customerId: disk.customer_uid ?? "",
    };
  }

  /**
   * Step 1 of login: send an OTP SMS to the configured mobile number, via the
   * BFF `users/loginbymobile` endpoint. Returns the reference for verification.
   */
  async triggerOtp(): Promise<string> {
    if (!CONFIG.MOBILE) {
      throw new Error(
        "No mobile number configured. Set CHECKERS60_MOBILE (e.g. +27821234567)."
      );
    }
    const bff = await this.getBFFToken();
    const res = await request<{ response?: { reference?: string } }>(
      "GET",
      `${CONFIG.BFF_BASE}/users/loginbymobile?mobileNumber=${encodeURIComponent(CONFIG.MOBILE)}`,
      { headers: this.bffHeaders(bff) }
    );
    const reference = res.data?.response?.reference;
    if (!reference) {
      throw new Error("OTP trigger failed");
    }
    return reference;
  }

  /**
   * Step 2 of login: verify the OTP and resolve the full session identity, then
   * commit it atomically. Every network call runs OUTSIDE the credential lock;
   * only the single `updateSessionLocked` commit is inside it.
   *
   * a. `POST {BFF}/otp/loginbymobile/verify` → session token + lifetime.
   * b. `GET  {BFF}/users/verify`             → customerId (`response.uid`).
   * c. `GET  {AUTH}/customers/{cid}/customer-profile/v2/{session}` → internal userId.
   * d. `GET  {SHOPRITE}/users`               → shoprite uuid; customerId cross-check.
   * e. validate lifetime BEFORE any commit; reject on any invalid value.
   * f. commit session_token/expiry/userId/customer_uid/shoprite_uuid/mobile and
   *    NULL the legacy DSL fields — one atomic patch.
   */
  async verifyOtp(reference: string, otp: string): Promise<void> {
    if (!CONFIG.MOBILE) {
      throw new Error(
        "No mobile number configured. Set CHECKERS60_MOBILE (e.g. +27821234567)."
      );
    }
    const mobile = CONFIG.MOBILE;
    const bff = await this.getBFFToken();

    // (a) OTP verify → session token + lifetime.
    const verifyRes = await request<{
      response?: { accessToken?: string; expiresIn?: number };
    }>("POST", `${CONFIG.BFF_BASE}/otp/loginbymobile/verify`, {
      headers: this.bffHeaders(bff),
      json: { target: { type: "SMS", identifier: mobile, reference }, otp },
    });
    const sessionToken = verifyRes.data?.response?.accessToken;
    if (!sessionToken) {
      throw new Error("OTP verify failed");
    }

    // (e) Validate the lifetime BEFORE any further work / commit — no default.
    const sessionExpiry = computeSessionExpiry(verifyRes.data?.response?.expiresIn);

    // (b) BFF users/verify → customerId (response.uid; response.result is a boolean).
    const uidRes = await request<{ response?: { uid?: string; result?: boolean } }>(
      "GET",
      `${CONFIG.BFF_BASE}/users/verify`,
      { headers: this.bffVerifyHeaders(bff, mobile) }
    );
    const customerId = uidRes.data?.response?.uid;
    if (!customerId) {
      throw new Error("Login failed: could not resolve customer id.");
    }

    // (c) Customer profile → internal userId. Session token is in the URL PATH,
    // so redact the trailing segment and reject redirects (credential-bearing URL).
    const profileRes = await request<{ userProfile?: { id?: string } }>(
      "GET",
      `${CONFIG.AUTH_BASE}/customers/${encodeURIComponent(customerId)}/customer-profile/v2/${sessionToken}`,
      {
        headers: this.profileHeaders(),
        sensitivePathTail: true,
        redirect: "manual",
      }
    );
    const userId = profileRes.data?.userProfile?.id;
    if (!userId) {
      throw new Error("Login failed: could not resolve user id.");
    }

    // (d) DSL /users → shoprite uuid + customerId cross-check.
    const usersRes = await request<{
      response?: { user?: { uuid?: string; customerId?: string } };
    }>("GET", `${CONFIG.SHOPRITE_BASE}/users`, {
      headers: this.dslUsersHeaders(sessionToken),
    });
    const dslUser = usersRes.data?.response?.user;
    const shopriteUuid = dslUser?.uuid;
    if (!shopriteUuid) {
      throw new Error("Login failed: could not resolve customer uuid.");
    }
    if (dslUser?.customerId !== customerId) {
      // Identity mismatch across sources — abort with NO commit (no partial write).
      throw new Error("Login aborted: customer identity mismatch across services.");
    }

    // (f) One atomic commit; network is done, so only this touches the lock.
    const committed = await withCredentialsLock((ctx) =>
      updateSessionLocked(ctx, {
        sessionToken,
        sessionExpiry,
        userId,
        customerId,
        shopriteUuid,
        mobile,
      })
    );
    this.adopt(committed);
  }

  // ── BFF / auth-host header builders (exact per-endpoint capture, §9.6) ─────

  /** Base BFF headers shared by every BFF endpoint (channel + app version + device). */
  private baseBffHeaders(): Record<string, string> {
    return {
      channel: CONFIG.CHANNEL,
      "app-version": CONFIG.APP_VERSION,
      appversion: CONFIG.APP_VERSION_CODE,
      "device-id": getDeviceId(),
    };
  }

  /** `GET /users/loginbymobile` and `POST /otp/loginbymobile/verify`: Bearer {bff} + base. */
  bffHeaders(bffToken: string): Record<string, string> {
    return { authorization: `Bearer ${bffToken}`, ...this.baseBffHeaders() };
  }

  /** `GET /users/verify`: Bearer {bff} + mobilenumber + channel-os + base. */
  private bffVerifyHeaders(bffToken: string, mobile: string): Record<string, string> {
    return {
      authorization: `Bearer ${bffToken}`,
      mobilenumber: mobile,
      "channel-os": CONFIG.APP_VERSION,
      ...this.baseBffHeaders(),
    };
  }

  /** Customer-profile call: Bearer static PROFILE_TOKEN + base (no session in headers). */
  private profileHeaders(): Record<string, string> {
    return { authorization: `Bearer ${CONFIG.PROFILE_TOKEN}`, ...this.baseBffHeaders() };
  }

  /** DSL `GET /users`: access_token: {session} + x-api-key + base. NO Bearer, NO mobilenumber. */
  private dslUsersHeaders(sessionToken: string): Record<string, string> {
    return {
      access_token: sessionToken,
      "x-api-key": CONFIG.X_API_KEY_USER,
      ...this.baseBffHeaders(),
    };
  }
}

export { APIError };
