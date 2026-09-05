---
name: checkers60
description: Order groceries from Checkers Sixty60 via CLI. Search products, manage cart, view orders and delivery slots.
---

# checkers60

CLI tool for Checkers Sixty60 grocery delivery — search products, manage a cart, browse categories, view orders, and check delivery slots.

## Install

```sh
brew install yashiels/tap/checkers60
```

Requires Node.js ≥ 20. After install, the `checkers60` binary is available on your `PATH`.

## Credentials

Place your session credentials in:

```
~/.openclaw/credentials/checkers60.json
```

The file should contain the token fields written by the OTP login flow (`otp-trigger` → `otp-verify`). The CLI reads this path automatically — no environment variable or flag needed.

## Auth commands

| Command | Description |
|---|---|
| `checkers60 status` | Show current auth status (logged in / token expiry) |
| `checkers60 otp-trigger` | Send a one-time password to your registered phone number |
| `checkers60 otp-verify <ref> <code>` | Verify the OTP and save tokens to credentials file |
| `checkers60 logout` | Clear saved tokens from the credentials file |

> **Safety note:** `otp-trigger` sends a live SMS. Never call it automatically or in a loop — only trigger it explicitly when the user asks to log in.

> **Session lifetime (important):** login yields a short-lived **~1 hour** session token. There is **no refresh** — when it expires, any command returns exit `3` (auth) and `checkers60 status` shows the session expired. Recovery is a fresh OTP login (steps above); the CLI never auto-refreshes and never auto-triggers an OTP. An expired session is a logged-out state.

## Headless / agent usage

**Once logged in, everything is headless.** Shopping, cart, orders, slots — all read the saved tokens from the credentials file and need no interaction. Run them freely.

**Login is the one interactive step, and an agent CANNOT complete it alone.** The OTP arrives by SMS to the user's phone, out of band — the agent has no way to read it. When `checkers60 status` shows a missing or expired token, the agent MUST:

1. Run `checkers60 otp-trigger` (this fires one live SMS — run it exactly once).
2. **Stop and ask the user to paste the code from the SMS.** Do not guess, retry, or re-trigger.
3. Run `checkers60 otp-verify <ref> <code>` with the reference from step 1 and the code the user gives you.

Use `--json` on `otp-trigger`/`otp-verify` when driving this programmatically so you can parse the `reference` and confirm `loggedIn`.

> The `CHECKERS60_OTP_RELAY_URL` / `CHECKERS60_OTP_RELAY_TOKEN` env vars are reserved for a future SMS-to-HTTPS relay but are **not yet wired into the CLI** — there is no auto-fetch of the OTP today. Always fall back to asking the user.

## JSON output & exit codes (headless)

Every command accepts `--json` for machine-readable output. You can also set it
globally for a whole session with the `CHECKERS60_JSON` environment variable
(any truthy value, e.g. `CHECKERS60_JSON=1`); `--json` on the command line ORs
with it. In JSON mode all spinners and incidental log lines are suppressed, so
stdout carries **only** the JSON payload.

**Errors are JSON too.** On failure in JSON mode the CLI writes exactly one
object to **stdout** and exits non-zero:

```json
{"error": "Authentication failed (HTTP 401).", "code": 3, "status": 401}
```

`status` is present only for server responses. The `error` string is always a
clean summary — it never contains the raw API response body.

Exit codes are stable and safe to branch on:

| Code | Meaning |
|---|---|
| `0` | success |
| `1` | generic runtime failure |
| `2` | invalid usage (unknown command/option, missing argument) |
| `3` | authentication (not logged in, HTTP 401/403) |
| `4` | network (timeout, DNS failure, connection reset) |

A `code: 3` from any command is the signal to run the OTP login flow above.
`--help` and `--version` always print normally, even in JSON mode.

## Product commands

| Command | Description |
|---|---|
| `checkers60 search <query>` | Search for products by name or keyword |
| `checkers60 deals <query>` | List bonus-buy deals ("buy N & save X") for a search term |
| `checkers60 show <id>` | Product detail plus any bonus-buy deals it belongs to |
| `checkers60 categories` | Not wired up yet — category endpoint host is still TBD; use `search` |
| `checkers60 trending` | Deprecated — the mobile API has no trending endpoint; use `search` |

### Bonus-buy deals

Deals are "buy these together and save" promotions (e.g. *Buy 2 & Save 20%*). The
buy-quantity threshold and the saving live only in each deal's human `title`/
`description` text — there is **no clean numeric threshold field** — so the CLI
never fabricates "X of N" progress. `deals` and `show --json` return the
normalized deal (`title`, `description`, `validUntil`, `membersOnly`,
`memberProductIds`, raw `discountTypeCode`/`offerTypeCode`). `membersOnly: true`
means Xtra-Savings members only.

## Cart commands

| Command | Description |
|---|---|
| `checkers60 cart` | Show the current cart contents and total |
| `checkers60 cart --deals` | Show which cart items qualify for which bonus-buy deal (membership only, no count) |
| `checkers60 add <target> [qty]` | Add a product to the cart; `target` is a product ID or search term; `qty` defaults to 1 |
| `checkers60 remove <target>` | Remove a product from the cart by ID or search term |
| `checkers60 clear` | Empty the entire cart |

## Delivery commands

| Command | Description |
|---|---|
| `checkers60 slots` | List available delivery time slots |
| `checkers60 addresses` | List saved delivery addresses |

## Account commands

| Command | Description |
|---|---|
| `checkers60 orders` | Show recent orders and their status |
| `checkers60 profile` | Display the authenticated user's profile |
| `checkers60 cards` | Not available yet — the payment-cards contract is unverified and disabled |

## Typical flow

```sh
# 1. Log in (only needed once, or when token expires)
checkers60 otp-trigger
checkers60 otp-verify <ref> <code>

# 2. Find and add items
checkers60 search "milk"
checkers60 add 12345 2         # add product ID 12345, qty 2

# 3. Review cart and delivery options
checkers60 cart
checkers60 slots
checkers60 addresses

# 4. Review orders after checkout
checkers60 orders
```

## Notes

- All commands require valid credentials in `~/.openclaw/credentials/checkers60.json`. Run the OTP flow if `checkers60 status` shows an expired or missing token.
- `otp-trigger` must only be invoked when the user explicitly asks to log in. Do not auto-trigger it in scripts or on credential errors.
- The CLI exits non-zero on API errors. In human mode the message goes to stderr; in `--json` mode a single `{"error","code","status?"}` object goes to stdout. See the exit-code table above.
