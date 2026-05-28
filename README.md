# checkers60 — shop Sixty60 without opening the app

CLI for Checkers Sixty60 grocery delivery. Talks directly to the Sixty60 mobile-app API (reverse-engineered from the Android app) — no browser to drive.

- **OTP login** — two-step phone number + SMS code; tokens persist and auto-refresh
- **Full cart management** — search, add, remove, clear; works for humans and AI agents alike
- **JSON everywhere** — every command supports `--json` for scripting, piping to `jq`, or agent integration

## Install

```bash
brew install yashiels/tap/checkers60  # auto-taps yashiels/tap
```

Direct downloads from the [latest GitHub release](https://github.com/yashiels/checkers60-cli/releases/latest).

Build from source:

```bash
git clone https://github.com/yashiels/checkers60-cli.git
cd checkers60-cli
npm install && npm run build
```

## Quick Start

```bash
# Log in (two-step OTP)
checkers60 login                      # sends an SMS, prints a reference
checkers60 otp-verify <ref> 1234      # verify the code

# Search for products
checkers60 search "milk"

# JSON output for scripting
checkers60 search "bread" --json
```

## Commands

| Command | Description |
|---------|-------------|
| `login` / `otp-trigger` | Send a login OTP to your phone (step 1). |
| `otp-verify <ref> <code>` | Verify the OTP and save your session (step 2). |
| `logout` | Clear saved tokens. |
| `status` | Show login status, token expiry, and cart summary. |
| `search <query>` | Search products. Supports `--page`, `--limit`, `--json`. |
| `cart` | Show cart contents. |
| `add <query\|id> [qty]` | Add a product to the cart by search term or product id. |
| `remove <query\|id>` | Remove a product from the cart by name or product id. |
| `clear` | Empty the cart. |
| `addresses` | List delivery addresses. |
| `cards` | List saved payment cards. |
| `orders [--all]` | Show orders (active by default). |
| `profile` | Show your user profile. |
| `slots` | Show delivery slots for the current cart. |
| `categories` | Not exposed by the mobile API (stub). |
| `trending` | Not exposed by the mobile API (stub). |

All commands support `--json` for structured output.

## Configuration

The CLI reads your account identity from environment variables and stores
auth tokens at `~/.openclaw/credentials/checkers60.json`.

| Variable | Required | Purpose |
|----------|----------|---------|
| `CHECKERS60_MOBILE` | to log in | Mobile number for OTP, e.g. `+27821234567` |
| `CHECKERS60_USER_ID` | for cart/orders/etc. | Sixty60 internal user id |
| `CHECKERS60_SHOPRITE_UUID` | recommended | Shoprite customer UUID |
| `CHECKERS60_EMAIL` | recommended | Account email |
| `CHECKERS60_ADDRESS_ID` | optional | Default delivery address id |
| `CHECKERS60_STORES` | optional | JSON array of store contexts (defaults to Rondebosch) |
| `CHECKERS60_DEVICE_ID` | optional | 16-char hex device id |

After `otp-verify`, the Sixty60 user id is persisted automatically. Tokens are stored in `~/.openclaw/credentials/checkers60.json`.

## Disclaimer

Not affiliated with Checkers or the Shoprite Group. Talks to private, undocumented APIs reverse-engineered from the Sixty60 Android app. Use at your own risk.

## Development

```bash
npm install     # install dependencies
npm run build   # compile TypeScript
npm run lint    # type-check
npm test        # run tests
```

Releases are automated via GitHub Actions. Go to **Actions → Ship**, pick `patch`, `minor`, or `major` — it bumps the version, builds a standalone binary, publishes a GitHub release, and updates the [Homebrew tap](https://github.com/yashiels/homebrew-tap).

## License

MIT — Yashiel Sookdeo
