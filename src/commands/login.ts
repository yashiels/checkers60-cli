import { chromium, type BrowserContext, type Page } from "playwright";
import ora from "ora";
import chalk from "chalk";
import {
  saveSession,
  saveBrowserState,
  loadBrowserState,
  saveUserContext,
  ensureDataDir,
} from "../lib/session.js";
import { BROWSER_STATE_PATH, type StoreContext } from "../lib/config.js";
import { existsSync } from "node:fs";

const CHECKERS_URL = "https://www.checkers.co.za";
const LOGIN_URL = `${CHECKERS_URL}/login`;

export interface LoginOptions {
  headless?: boolean;
}

export async function login(options: LoginOptions = {}): Promise<void> {
  const { headless = false } = options;
  const spinner = ora();

  ensureDataDir();

  spinner.start("Launching browser…");

  // Reuse browser state if available (keeps WAF tokens alive)
  const existingState = existsSync(BROWSER_STATE_PATH)
    ? loadBrowserState()
    : undefined;

  const browser = await chromium.launch({
    headless,
    args: ["--disable-blink-features=AutomationControlled"],
  });

  const context = await browser.newContext({
    ...(existingState ? { storageState: existingState as any } : {}),
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
    locale: "en-ZA",
    timezoneId: "Africa/Johannesburg",
  });

  const page = await context.newPage();

  try {
    spinner.text = "Navigating to Checkers…";
    await page.goto(CHECKERS_URL, { waitUntil: "networkidle", timeout: 30_000 });

    // Check if already logged in
    const isLoggedIn = await checkLoggedIn(page);

    if (isLoggedIn) {
      spinner.succeed("Already logged in!");
    } else {
      spinner.stop();
      console.log(
        chalk.yellow(
          "\n📱 A browser window has opened. Please log in with your phone number and OTP.\n"
        )
      );
      console.log(
        chalk.dim("   Waiting for you to complete login…\n")
      );

      // Navigate to login if not there
      if (!page.url().includes("/login")) {
        await page.goto(LOGIN_URL, { waitUntil: "networkidle", timeout: 30_000 });
      }

      // Wait for login to complete (user enters phone + OTP)
      // We detect login success by watching for the profile/auth state to appear
      await page.waitForFunction(
        () => {
          const auth = localStorage.getItem("[EasyPeasyStore][0][auth]");
          if (!auth) return false;
          try {
            const parsed = JSON.parse(auth);
            return parsed?.data?.isAuthenticated === true;
          } catch {
            return false;
          }
        },
        { timeout: 300_000 } // 5 min for user to complete OTP
      );

      spinner.start("Login detected!");
      spinner.succeed("Login successful!");
    }

    // Extract session data
    spinner.start("Saving session…");

    // Get cookies
    const cookies = await context.cookies();
    const checkersCookies = cookies.filter(
      (c) =>
        c.domain.includes("checkers.co.za") ||
        c.domain.includes("sixty60.co.za") ||
        c.domain.includes("awswaf.com")
    );

    // Save cookies
    saveSession({
      cookies: checkersCookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        expires: c.expires,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: c.sameSite as "Strict" | "Lax" | "None",
      })),
      savedAt: new Date().toISOString(),
    });

    // Save full browser state for next login (WAF tokens, localStorage etc)
    const storageState = await context.storageState();
    saveBrowserState(storageState);

    // Extract user context from localStorage
    const userContext = await page.evaluate(() => {
      const auth = localStorage.getItem("[EasyPeasyStore][0][auth]");
      const delivery = localStorage.getItem(
        "[EasyPeasyStore][0][deliveryAddressStore]"
      );

      const result: Record<string, unknown> = {};

      if (auth) {
        try {
          const parsed = JSON.parse(auth);
          const profile = parsed?.data?.sixty60Profile;
          const userProfile = parsed?.data?.userProfile;
          if (profile) {
            result.profileId = profile.id;
            result.displayName = profile.firstName;
            result.storeContexts = profile.storeContexts;
          }
          if (userProfile) {
            result.customerId = userProfile.customerId;
          }
        } catch {}
      }

      if (delivery) {
        try {
          const parsed = JSON.parse(delivery);
          const addr = parsed?.data?.data?.deliveryAddress;
          if (addr) {
            result.addressId = addr._id || addr.identifier;
            result.addressName = addr.name;
            result.fullAddress = addr.fullAddress;
          }
          // Also grab store contexts from delivery store if not already set
          if (!result.storeContexts) {
            result.storeContexts = parsed?.data?.data?.storeContexts;
          }
        } catch {}
      }

      return result;
    });

    // Save user context to config
    saveUserContext({
      profileId: userContext.profileId as string,
      addressId: userContext.addressId as string,
      storeContexts: userContext.storeContexts as StoreContext[],
      displayName: userContext.displayName as string,
      customerId: userContext.customerId as string,
    });

    spinner.succeed("Session saved!");

    // Summary
    console.log("");
    console.log(chalk.green("✅ Logged in and ready to shop!"));
    if (userContext.displayName) {
      console.log(chalk.dim(`   User: ${userContext.displayName}`));
    }
    if (userContext.addressName) {
      console.log(
        chalk.dim(`   Delivery: ${userContext.addressName}`)
      );
    }
    if (userContext.fullAddress) {
      console.log(
        chalk.dim(`   Address: ${userContext.fullAddress}`)
      );
    }
    const storeCount = (userContext.storeContexts as unknown[])?.length ?? 0;
    if (storeCount > 0) {
      console.log(chalk.dim(`   Stores: ${storeCount} nearby`));
    }
    console.log("");
    console.log(
      chalk.dim('   Try: checkers60 search "milk"')
    );
  } finally {
    await browser.close();
  }
}

async function checkLoggedIn(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => {
      const auth = localStorage.getItem("[EasyPeasyStore][0][auth]");
      if (!auth) return false;
      try {
        const parsed = JSON.parse(auth);
        return parsed?.data?.isAuthenticated === true;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}
