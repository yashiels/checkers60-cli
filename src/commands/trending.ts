import chalk from "chalk";

export interface TrendingOptions {
  json?: boolean;
}

/**
 * The Sixty60 mobile API (v2.0.114) has no popular-/trending-searches endpoint
 * equivalent to the old website API. Kept as a discoverable stub.
 */
export async function trending(options: TrendingOptions = {}): Promise<void> {
  const { json = false } = options;

  if (json) {
    process.stdout.write(
      `${JSON.stringify({ supported: false, reason: "not-exposed-by-mobile-api" }, null, 2)}\n`
    );
    return;
  }

  process.stdout.write(
    `${chalk.yellow("Trending searches aren't exposed by the Sixty60 mobile API.")}\n`
  );
}
