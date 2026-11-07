# Contributing to Melly IDE

Start with [AGENTS.md](AGENTS.md), [Development](docs/DEVELOPMENT.md), [Architecture](docs/ARCHITECTURE.md) and the current [roadmap](docs/ROADMAP.md). Read any scoped instructions before editing. Before Convex work, run `npx convex ai-files install` and read the guidelines it downloads into `convex/_generated/ai/`. They are not committed.

## Before editing

Record the actual repository root, branch, HEAD, remote and dirty/untracked state. The owner's development tree contains substantial inherited uncommitted work; do not stage, rewrite, revert or delete it. Keep each change focused and retain historical evidence.

## Validation

Run focused behavioral tests, `npm test`, `npm run typecheck`, the separate Convex TypeScript check and `git diff --check`. Native changes also require offline Rust tests and a real Windows/WebView2 check. Browser tests use existing Playwright/Chrome installations and external evidence directories. A mock bridge is not native acceptance. See [Development](docs/DEVELOPMENT.md).

Exercise filesystems only with disposable fixtures. Preserve keyboard navigation, responsive layouts, accessibility and reduced-motion behavior. Treat the workspace, disk files and agent job queue as separate state owners.

## Review and publication

Describe the problem, behavior change, tests actually run and limitations. Use the pull request template. Never include secrets, browser profiles, user source backups or private QA artifacts. Follow [SECURITY.md](SECURITY.md) for sensitive reports.

Commits, pushes, PRs, merges, deployment, distribution, credentials, paid inference and enabling execution each need their own authorization. A local integration run grants none of those automatically. Do not claim CI, release, device or provider acceptance without corresponding evidence.

## Licensing of contributions

Melly IDE's original source and documentation use the [Apache License, Version 2.0](LICENSE). The [licensing scope](docs/product/LICENSING.md) identifies generated code, dependencies and artwork separately. Unless you state otherwise in writing, any contribution you intentionally submit is licensed under the same terms, as set out in Section 5 of the license. Submit only work you have the right to license, and say so in the pull request if any part comes from a third party or a generated source.

- Do not copy code, text, images or media from other projects unless their license permits it. Name the source and license in the pull request.
- Keep existing third-party copyright and license notices intact. Do not replace them with Melly IDE headers.
- New source files may start with `SPDX-License-Identifier: Apache-2.0` in the file's comment syntax.
- Do not add a dependency under a non-permissive, source-available or unknown license without owner approval. [Licensing scope](docs/product/LICENSING.md) lists the current exceptions.
- Contributions do not grant rights to the Melly IDE name, logo or icons.
