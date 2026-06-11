# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

(nothing yet)

## [0.1.0] — 2026-06-08

Initial release.

### Added

- **OTP login** — two-step phone-number + SMS-code authentication (`login` / `otp-verify`)
- **Session management** — tokens persist to `~/.openclaw/credentials/checkers60.json` and auto-refresh
- **Product search** — full-text search against the Sixty60 catalog with pagination (`search`)
- **Cart management** — view, add (by search term or product id), remove, and clear (`cart`, `add`, `remove`, `clear`)
- **Delivery** — list delivery addresses and available time slots (`addresses`, `slots`)
- **Payment** — list saved payment cards (`cards`)
- **Orders** — view active and past orders (`orders`, `orders --all`)
- **Profile** — display user profile details (`profile`)
- **Account status** — show login state, token expiry, and cart summary at a glance (`status`)
- **JSON output** — every command supports `--json` for scripting, piping to `jq`, or agent integration
- **Global flags** — `--no-color`, `--quiet`, `--verbose` across all commands
- **Standalone binaries** — compiled with Bun for macOS arm64 and Linux x64; distributed via Homebrew tap and GitHub Releases
- **CI/CD** — GitHub Actions workflows for lint, build, test, versioned release, and automatic Homebrew tap update

[0.1.0]: https://github.com/yashiels/checkers60-cli/releases/tag/v0.1.0
