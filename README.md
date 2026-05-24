# checkers60-cli

CLI for [Checkers Sixty60](https://www.checkers.co.za) grocery delivery — search products, manage your cart, track orders, and reorder from the terminal.

Built for humans and AI agents alike.

## Quick Start

```sh
# Clone and install
git clone https://github.com/apex-skyner/checkers60-cli.git
cd checkers60-cli
npm install

# Install Playwright browser
npx playwright install chromium

# Log in (opens browser for phone + OTP auth)
npx tsx src/cli.ts login

# Search for products
npx tsx src/cli.ts search "milk"

# JSON output for scripting/agents
npx tsx src/cli.ts search "bread" --json
```

## Commands

| Command | Description |
|---------|-------------|
| `login` | Log in via browser (phone + OTP). Saves session cookies locally. |
| `logout` | Clear saved session and config. |
| `status` | Show login status, delivery address, nearby stores. |
| `search <query>` | Search products. Supports `--page`, `--limit`, `--sort`, `--json`. |
| `slots` | Show available delivery time slots. |
| `categories` | Browse product categories/departments. |
| `trending` | Show popular/trending searches. |

## How It Works

Checkers Sixty60 uses OTP-based authentication (phone number + SMS code). The CLI handles this via Playwright:

1. `checkers60 login` opens a real Chromium browser
2. You enter your phone number and OTP on the Checkers website
3. The CLI captures your session cookies and store configuration
4. Subsequent commands use these cookies to make direct API calls — fast, no browser needed

Session data is stored in `~/.checkers60/`.

## Agent Integration

All commands support `--json` for structured output:

```sh
checkers60 search "eggs" --json | jq '.products[0]'
checkers60 status --json
checkers60 slots --json
```

## Roadmap

- [x] Login (Playwright OTP flow)
- [x] Product search
- [x] Delivery slots
- [x] Categories
- [ ] Cart management (add, remove, view)
- [ ] Order history
- [ ] Rapid reorder
- [ ] Deals/specials
- [ ] OpenClaw skill integration

## Tech

- TypeScript + Node.js (ESM)
- [Playwright](https://playwright.dev/) for browser-based auth
- [Commander](https://github.com/tj/commander.js) for CLI framework
- Direct REST API calls to checkers.co.za (cookie-authenticated)

## License

MIT
