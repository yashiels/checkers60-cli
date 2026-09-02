/**
 * Child-process worker for the cross-process credential-lock test. Spawned with
 * `node --import tsx`. It mocks the network at the global `fetch` boundary,
 * counts each real token-refresh call by appending to WORKER_COUNTER, then runs
 * the real `TokenManager.getUserToken()` reconciliation under the file lock.
 *
 * Env: CHECKERS60_CREDS_PATH (shared creds file), WORKER_COUNTER (refresh tally
 * file), BARRIER_TS (ms epoch to start together).
 */
import { appendFileSync } from "node:fs";
import { TokenManager } from "../lib/credentials.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    statusText: "OK",
    headers: { "content-type": "application/json" },
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const counterPath = process.env.WORKER_COUNTER as string;

globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
  const url = String(input);
  if (url.includes("/token/dsl")) {
    return jsonResponse({ access_token: "bff-token", expires_in: 86_400 });
  }
  if (url.includes("/tokens?refreshToken=")) {
    // Count a real network refresh and widen the contention window.
    appendFileSync(counterPath, "x");
    await sleep(200);
    return jsonResponse({
      response: {
        accessToken: "user-new",
        refreshToken: "refresh-new",
        expiresIn: 3600,
      },
    });
  }
  throw new Error(`unexpected fetch: ${url}`);
}) as typeof fetch;

async function main(): Promise<void> {
  const barrier = Number(process.env.BARRIER_TS ?? 0);
  while (Date.now() < barrier) await sleep(5);

  const tm = new TokenManager();
  const token = await tm.getUserToken();
  process.stdout.write(
    `${JSON.stringify({ token, userToken: tm.userToken, refreshToken: tm.refreshToken })}\n`
  );
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
