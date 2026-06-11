# AGENTS.md — checkers60

Checkers Sixty60 grocery CLI. TypeScript, talks directly to the Sixty60 mobile-app API (reverse-engineered Android APK).

## Directory Structure

```
.
├── .github/
│   └── workflows/
│       ├── ci.yml              # Lint + test on push to main
│       ├── release-impl.yml    # Reusable release implementation
│       └── ship.yml            # Version bump + GitHub Release + Homebrew tap
├── docs/
│   └── assets/                 # Static docs assets
├── src/
│   ├── __tests__/
│   │   ├── format.test.ts      # Output formatting tests
│   │   └── http.test.ts        # HTTP client tests
│   ├── commands/
│   │   ├── add.ts              # Add item to cart
│   │   ├── addresses.ts        # List delivery addresses
│   │   ├── cards.ts            # List payment cards
│   │   ├── cart.ts             # View cart
│   │   ├── categories.ts       # Browse categories
│   │   ├── clear.ts            # Clear cart
│   │   ├── login.ts            # OTP login initiation
│   │   ├── logout.ts           # Clear stored credentials
│   │   ├── orders.ts           # View orders
│   │   ├── profile.ts          # Show user profile
│   │   ├── remove.ts           # Remove item from cart
│   │   ├── search.ts           # Search products
│   │   ├── slots.ts            # List delivery slots
│   │   ├── status.ts           # Account status overview
│   │   └── trending.ts         # Trending products
│   ├── lib/
│   │   ├── api.ts              # Sixty60 API client (all endpoints)
│   │   ├── config.ts           # App configuration constants
│   │   ├── credentials.ts      # Token storage + refresh logic
│   │   ├── errors.ts           # Typed error classes
│   │   ├── format.ts           # Table/human-readable output helpers
│   │   ├── http.ts             # Authenticated HTTP wrapper
│   │   └── output.ts           # --json / --quiet output routing
│   └── cli.ts                  # Commander entry point, registers all commands
├── .gitignore
├── .prettierrc                 # Prettier formatting config
├── AGENTS.md                   # This file
├── CHANGELOG.md
├── LICENSE
├── Makefile                    # Standard make targets (ci, lint, test, build, fmt, clean)
├── README.md
├── package.json
├── tsconfig.json
└── version.env                 # Current version string (used by ship.yml)
```

## Build / Test / Lint

```bash
make install   # npm install (idempotent)
make fmt       # prettier --write . (format all files)
make lint      # tsc --noEmit (type-check only, no emit)
make test      # vitest run
make build     # tsup → dist/ (ESM + DTS)
make ci        # lint + test (what CI runs)
make clean     # rm -rf dist
```

Run `make ci` before every commit. It is the gate for CI.

## Key Design Decisions

- **Direct API** — calls the Sixty60 mobile-app REST API reverse-engineered from the Android APK. No browser automation, no Playwright, no scraping.
- **OTP login** — two-step: `login` sends an OTP to the user's phone, `otp-verify` (or the prompted flow) completes auth. Access + refresh tokens are cached to `~/.openclaw/credentials/checkers60.json` and auto-refreshed on expiry.
- **TSup build** — emits ESM (`dist/cli.js`) with `.d.ts` types. Configured via the `build` script in `package.json`; no separate `tsup.config` file.
- **Commander CLI** — `src/cli.ts` is the root Commander program. Each command lives in `src/commands/` and is registered there.
- **JSON output** — every data command exposes `--json`. Use `output.ts` helpers (`printJson` / `printTable`) to route output; never `console.log` raw objects in commands.

## Constraints

- **No browser automation** — do not add Playwright, Puppeteer, or any browser-based auth.
- **Do not change the OTP auth flow** — the two-step phone + SMS code flow is intentional; do not simplify or replace it.
- **Credentials path is `~/.openclaw/credentials/checkers60.json`** — do not change this path or the token schema without updating `credentials.ts` and docs.
- **Keep `--json` on every data command** — scripting and agent integration depend on it.
- **No `console.log` in commands** — use `output.ts` helpers so `--quiet` and `--json` flags work correctly.

## CI

| Workflow      | Trigger                    | What it does                                      |
|---------------|----------------------------|---------------------------------------------------|
| `ci.yml`      | Push / PR to `main`        | `tsc --noEmit` + `vitest run`                     |
| `ship.yml`    | Manual `workflow_dispatch`  | Version bump, GitHub Release, Homebrew tap update |

Run CI locally with:
```bash
make ci
```
