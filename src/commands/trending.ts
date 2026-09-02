import chalk from "chalk";

export interface TrendingOptions {
  json?: boolean;
}

/**
 * Deprecated. The Sixty60 mobile API has no popular-/trending-searches endpoint
 * equivalent to the old website API, so this command is on its way out. Kept as
 * a discoverable, honest stub for one release.
 */
export async function trending(options: TrendingOptions = {}): Promise<void> {
  const { json = false } = options;

  if (json) {
    process.stdout.write(
      `${JSON.stringify({ supported: false, deprecated: true }, null, 2)}\n`
    );
    return;
  }

  process.stdout.write(
    `${chalk.yellow("`trending` is deprecated — the Sixty60 mobile API has no trending endpoint. Use `search` instead.")}\n`
  );
}
