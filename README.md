# checkers60-cli

CLI for [Checkers Sixty60](https://www.sixty60.co.za) grocery delivery — search products, manage your cart, track orders, and reorder from the terminal.

Talks directly to the **Sixty60 mobile-app API** (reverse-engineered from the Android app), so there's no browser to drive. Built for humans and AI agents alike.

## Quick Start

```sh
# Clone and install
git clone https://github.com/apex-skyner/checkers60-cli.git
cd checkers60-cli
npm install

# Configure your account (see "Configuration" below)
export CHECKERS60_MOBILE="+27821234567"

# Log in (two-step OTP)
npx tsx src/cli.ts login                  # sends an SMS, prints a reference
npx tsx src/cli.ts otp-verify <ref> 1234  # verify the code from the SMS

# Search for products
npx tsx src/cli.ts search "milk"

# JSON output for scripting/agents
npx tsx src/cli.ts search "bread" --json
```

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

After `otp-verify`, the Sixty60 user id is persisted automatically if it
wasn't already set.

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

## How It Works

Checkers Sixty60 uses OTP-based authentication (phone number + SMS code). The
CLI talks to the same backend the mobile app uses:

1. A **BFF Cognito token** (24h) is fetched automatically — no auth needed.
2. `checkers60 login` sends an OTP SMS and prints a reference.
3. `checkers60 otp-verify <ref> <code>` exchanges the code for a user access
   token + refresh token.
4. The access token auto-refreshes via the refresh token; OTP is never
   triggered automatically.

Tokens are stored in `~/.openclaw/credentials/checkers60.json`.

## Agent Integration

All commands support `--json` for structured output:

```sh
checkers60 search "eggs" --json | jq '.[0]'
checkers60 cart --json
checkers60 status --json
```

## Roadmap

- [x] OTP login (two-step)
- [x] Product search
- [x] Cart management (add, remove, view, clear)
- [x] Order history
- [x] Addresses & cards
- [x] Delivery slots
- [ ] Checkout / place order
- [ ] Rapid reorder
- [ ] OpenClaw skill integration

## Tech

- TypeScript + Node.js (ESM)
- [Commander](https://github.com/tj/commander.js) for the CLI framework
- Direct REST calls to the Sixty60 mobile-app API (token-authenticated)

## License

MIT
