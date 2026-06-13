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

## Product commands

| Command | Description |
|---|---|
| `checkers60 search <query>` | Search for products by name or keyword |
| `checkers60 categories` | Browse top-level product categories |
| `checkers60 trending` | List currently trending products |

## Cart commands

| Command | Description |
|---|---|
| `checkers60 cart` | Show the current cart contents and total |
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
| `checkers60 cards` | List saved payment cards |

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
- The CLI exits non-zero on API errors and prints a human-readable error message to stderr.
