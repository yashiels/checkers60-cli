/**
 * Child-process worker for the cross-process device-id convergence test.
 * Spawned with `node --import tsx`. With no `CHECKERS60_DEVICE_ID` env and no
 * persisted `device_id`, two of these racing on the same creds file must
 * converge to ONE generated id (generation is serialized by the credential
 * lock). Prints the resolved id as JSON.
 *
 * Env: CHECKERS60_CREDS_PATH (shared creds file), BARRIER_TS (ms epoch to start
 * together). CHECKERS60_DEVICE_ID must be UNSET.
 */
import { resolveDeviceId } from "../lib/runtime.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const barrier = Number(process.env.BARRIER_TS ?? 0);
  while (Date.now() < barrier) await sleep(5);

  const deviceId = await resolveDeviceId();
  process.stdout.write(`${JSON.stringify({ deviceId })}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
