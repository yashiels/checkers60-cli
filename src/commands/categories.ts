import chalk from "chalk";

export interface CategoriesOptions {
  json?: boolean;
}

/**
 * Category browsing exists in the Sixty60 backend but isn't wired up here yet:
 * the endpoint host is still TBD (a guessed path returned a Microsoft auth
 * page). This is honestly "not yet mapped", NOT "impossible".
 */
export async function categories(options: CategoriesOptions = {}): Promise<void> {
  const { json = false } = options;

  if (json) {
    process.stdout.write(
      `${JSON.stringify({ supported: false, reason: "endpoint-not-yet-mapped" }, null, 2)}\n`
    );
    return;
  }

  process.stdout.write(
    `${chalk.yellow("Category browsing isn't wired up yet (endpoint host still TBD).")}\n` +
      `${chalk.dim('   Use search in the meantime, e.g. checkers60 search "fresh produce".')}\n`
  );
}
