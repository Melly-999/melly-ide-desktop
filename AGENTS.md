# Agent instructions

These instructions apply to coding agents, and to people using them, on this repository.

- Read [CONTRIBUTING.md](CONTRIBUTING.md), the [development guide](docs/DEVELOPMENT.md) and the [security model](docs/product/SECURITY-MODEL.md) before changing code.
- Keep each change focused. Do not commit secrets, `.env` files, browser profiles, QA evidence or anything ignored by `.gitignore`.
- Before proposing a change, run `npm test` and `npm run typecheck`. For native changes, also run `cargo test --locked --manifest-path src-tauri/Cargo.toml`.
- Do not enable command execution, writable agent profiles or paid providers unless that is the reviewed purpose of the change.

## Convex

Before working in `convex/`, run `npx convex ai-files install`. It downloads Convex's current AI guidelines into `convex/_generated/ai/`, which Git ignores, and may add a Convex section to this file and to `CLAUDE.md`. Read the downloaded guidelines first, and do not commit the generated additions.
