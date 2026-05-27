import chalk from "chalk";
import { TokenManager } from "../lib/credentials.js";
import { CONFIG } from "../lib/config.js";
import { startSpinner } from "../lib/output.js";

export interface OtpTriggerOptions {
  json?: boolean;
}

/**
 * Step 1 of login. Sends an OTP SMS to CHECKERS60_MOBILE and prints the
 * reference needed for verification. Never auto-verifies.
 */
export async function otpTrigger(options: OtpTriggerOptions = {}): Promise<void> {
  const { json = false } = options;
  const spinner = json ? null : startSpinner(`Sending OTP to ${CONFIG.MOBILE || "(unset)"}…`);

  const tokens = new TokenManager();
  const reference = await tokens.triggerOtp();
  spinner?.stop();

  if (json) {
    process.stdout.write(`${JSON.stringify({ reference }, null, 2)}\n`);
    return;
  }

  process.stdout.write(`\n${chalk.green("📱 OTP sent")} to ${chalk.bold(CONFIG.MOBILE)}\n`);
  process.stdout.write(`${chalk.dim("   Reference: ")}${chalk.cyan(reference)}\n\n`);
  process.stdout.write(
    `${chalk.dim("   Next: ")}checkers60 otp-verify ${chalk.cyan(reference)} ${chalk.yellow("<code>")}\n\n`
  );
}

export interface OtpVerifyOptions {
  json?: boolean;
}

/** Step 2 of login. Verifies the OTP and saves the resulting tokens. */
export async function otpVerify(
  reference: string,
  code: string,
  options: OtpVerifyOptions = {}
): Promise<void> {
  const { json = false } = options;
  const spinner = json ? null : startSpinner("Verifying OTP…");

  const tokens = new TokenManager();
  await tokens.verifyOtp(reference, code);
  spinner?.stop();

  if (json) {
    process.stdout.write(
      `${JSON.stringify({ loggedIn: true, expiresAt: new Date(tokens.userExpiry).toISOString() }, null, 2)}\n`
    );
    return;
  }

  process.stdout.write(`\n${chalk.green("✅ Logged in!")}\n`);
  process.stdout.write(
    `${chalk.dim(`   Token valid until ${new Date(tokens.userExpiry).toLocaleString()}`)}\n`
  );
  if (!CONFIG.SIXTY60_USER_ID) {
    process.stdout.write(
      `${chalk.yellow("   Tip: set CHECKERS60_USER_ID to enable addresses, cards and orders.")}\n`
    );
  }
  process.stdout.write(`\n${chalk.dim('   Try: checkers60 search "milk"')}\n\n`);
}
