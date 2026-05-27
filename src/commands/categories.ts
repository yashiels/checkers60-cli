import chalk from "chalk";

export interface CategoriesOptions {
  json?: boolean;
}

/**
 * The Sixty60 mobile API (v2.0.114) does not expose a standalone category-tree
 * endpoint the way the old website API did — categories are delivered inline
 * with search/landing payloads. Kept as a discoverable stub.
 */
export async function categories(options: CategoriesOptions = {}): Promise<void> {
  const { json = false } = options;

  if (json) {
    process.stdout.write(
      `${JSON.stringify({ supported: false, reason: "not-exposed-by-mobile-api" }, null, 2)}\n`
    );
    return;
  }

  process.stdout.write(
    `${chalk.yellow("Categories aren't exposed by the Sixty60 mobile API.")}\n` +
      `${chalk.dim('   Use search instead, e.g. checkers60 search "fresh produce".')}\n`
  );
}
