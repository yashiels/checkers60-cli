# 🛒 checkers60 — shop Sixty60 without opening the app

CLI for Checkers Sixty60 grocery delivery. Talks directly to the Sixty60 mobile-app API (reverse-engineered from the Android APK) — no browser, no WebDriver, just fast terminal commands.

> **Hero image coming soon** — screenshots are being prepared under `docs/assets/`.

[![CI](https://github.com/yashiels/checkers60-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/yashiels/checkers60-cli/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## Install

```bash
brew install yashiels/tap/checkers60
```

Or download a pre-built binary from the [latest GitHub release](https://github.com/yashiels/checkers60-cli/releases/latest) (macOS arm64 and Linux x64 are provided).

**npm / bun (global):**

```bash
npm install -g checkers60-cli
# or
bun add -g checkers60-cli
```

**Build from source:**

```bash
git clone https://github.com/yashiels/checkers60-cli.git
cd checkers60-cli
npm install && npm run build
# binary: dist/cli.js (requires Node ≥ 20 or Bun)
```

---

## Quick Start

```bash
# 1. Set your mobile number
export CHECKERS60_MOBILE=+27821234567

# 2. Log in (two-step OTP)
checkers60 login                          # sends an SMS to your phone
checkers60 otp-verify <ref> <code>        # e.g. checkers60 otp-verify 4f1a9c2e 1234

# 3. Search for something
checkers60 search "full cream milk"

# 4. Add it to your cart (by search term or product id)
checkers60 add "full cream milk" 2

# 5. Review your cart
checkers60 cart
```

---

## Commands

### Authentication

| Command | Description |
|---------|-------------|
| `login` / `otp-trigger` | Send a login OTP to your phone (step 1 of 2). |
| `otp-verify <ref> <code>` | Verify the OTP and save your session (step 2 of 2). |
| `logout` | Clear saved tokens. |
| `status` | Show login status, token expiry, and cart summary. |

### Products

| Command | Description |
|---------|-------------|
| `search <query>` | Search the catalog. Supports `-p/--page` and `-l/--limit`. |

### Cart

| Command | Description |
|---------|-------------|
| `cart` | Show cart contents. |
| `add <query\|id> [qty]` | Add a product by search term or product id. Default qty: 1. |
| `remove <query\|id>` | Remove a product by name or product id. |
| `clear` | Empty the cart. |

### Account

| Command | Description |
|---------|-------------|
| `addresses` | List saved delivery addresses. |
| `cards` | List saved payment cards. |
| `orders [--all]` | Show orders. Active orders only by default; pass `--all` for history. |
| `profile` | Show your user profile. |
| `slots` | Show available delivery slots for the current cart. |

### Global Flags

| Flag | Description |
|------|-------------|
| `--json` | Output structured JSON (supported on every command). |
| `--no-color` | Disable colored output (also respects the `NO_COLOR` env var). |
| `-q, --quiet` | Suppress non-essential output. |
| `-v, --verbose` | Show extra debug info. |

**Exit codes:** `0` success · `1` runtime failure · `2` invalid usage.

---

## Configuration

The CLI is configured through environment variables. Set them in your shell profile or pass them inline.

| Variable | Required | Description |
|----------|----------|-------------|
| `CHECKERS60_MOBILE` | to log in | Your mobile number, e.g. `+27821234567` |
| `CHECKERS60_USER_ID` | for most commands | Your Sixty60 internal user id (saved automatically after `otp-verify`) |
| `CHECKERS60_SHOPRITE_UUID` | recommended | Shoprite customer UUID |
| `CHECKERS60_EMAIL` | recommended | Account email |
| `CHECKERS60_ADDRESS_ID` | optional | Default delivery address id |
| `CHECKERS60_STORES` | optional | JSON array of store contexts (defaults to Rondebosch, Cape Town) |
| `CHECKERS60_DEVICE_ID` | optional | 16-char hex device id (auto-generated otherwise) |
| `CHECKERS60_OTP_RELAY_URL` | optional | HTTPS endpoint for an SMS-OTP relay (for automation) |
| `CHECKERS60_OTP_RELAY_TOKEN` | optional | Bearer token for the OTP relay |
| `CHECKERS60_CREDS_PATH` | optional | Override the credentials file path (default: `~/.openclaw/credentials/checkers60.json`) |

After a successful `otp-verify`, the Sixty60 user id and auth tokens are persisted to the credentials file and refreshed automatically on each run.

---

## How It Works

checkers60 reverse-engineers the **Checkers Sixty60 Android app** (`za.co.shoprite.sixty60` v2.0.114). All API calls go directly to Sixty60's mobile backend — the same endpoints the app hits.

**Auth flow:**
1. `otp-trigger` → `POST /auth/.../otp` sends an SMS to your phone and returns a reference token.
2. `otp-verify` → `POST /auth/.../verify` exchanges the reference + SMS code for access/refresh tokens, which are saved locally.
3. Subsequent commands attach the `Authorization: Bearer <access_token>` header. Tokens are refreshed transparently when they expire.

**API surface used:**
- `https://auth.sixty60.co.za` — authentication
- `https://dc-app-backend-for-frontend.sixty60.co.za/api/v1` — cart, search, slots
- `https://api.shopritegroup.co.za/dsl/brands/checkers/countries/ZA` — product catalog
- `https://orders-api.sixty60.co.za` — orders
- `https://payments.sixty60.co.za` — saved cards

**JSON everywhere:** every command accepts `--json` and returns newline-friendly structured data, making it easy to pipe into `jq` or use from AI agents and scripts.

---

## Development

```bash
npm install       # install dependencies
npm run build     # compile TypeScript (tsup → dist/)
npm run lint      # type-check (tsc --noEmit)
npm test          # run tests (vitest)
```

**Releases** are fully automated. Go to **Actions → Ship**, pick `patch`, `minor`, or `major` — the workflow bumps `version.env` and `package.json`, compiles standalone binaries with Bun, publishes a GitHub Release, and updates the [Homebrew tap](https://github.com/yashiels/homebrew-tap) automatically.

---

## Disclaimer

Not affiliated with Checkers, Sixty60, or the Shoprite Group. This tool talks to private, undocumented APIs reverse-engineered from the Sixty60 Android app. API behaviour may change without notice. Use at your own risk.

---

## License

MIT — © 2026 [Yashiel Sookdeo](https://github.com/yashiels)
