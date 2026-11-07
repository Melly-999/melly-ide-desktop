# Media sources and reproduction

## README media (0.7.0-alpha.3)

The local media in [README.md](../../README.md) lives in [`docs/assets/readme/`](../assets/readme/). There are two kinds, and they are labeled differently on the page.

**Real captures.** Five frames come from the Windows Sandbox acceptance run of the 0.7.0-alpha.3 executable on 2026-11-07. EXE SHA-256 `c1f8eeb3a9797f65223860ea9119e9307c34288adaa7f25b535875dfd505a7a8`, unsigned. The guest was an offline Windows 11 Sandbox (generic `WDAGUtilityAccount`), and the opened folder was a disposable `C:\synthetic-project` with `src/app.ts` and `README.md`. Each frame was cropped to the Melly IDE window only. That removes the Sandbox desktop wallpaper (third-party imagery), the desktop icons and the taskbar. Pixels inside the window were not edited, painted, scaled or reordered. No GIF or recording is used.

| Source frame (SHA-256) | Window crop | Second crop | Used in |
|---|---|---|---|
| `S11c-saved.png` (`6dd03b8e…71e5`) | 138,131 → 1418,1057 | none | `melly-ide-hero.png`, `social-preview.png` |
| `S14-palette.png` (`d30a9f74…5d95`) | 138,131 → 1418,1058 | 280,90 → 990,794 | `showcase-navigation.png` (01) |
| `S13a-quickopen.png` (`54b02137…a617`) | 138,131 → 1418,1058 | 280,90 → 990,420 | `showcase-navigation.png` (02) |
| `S13c-find-in-files.png` (`30d1c291…5559`) | 138,131 → 1418,1058 | 280,90 → 990,420 | `showcase-navigation.png` (03) |
| `S17a-exec-enable-dialog.png` (`94408ebc…5e6f`) | 138,131 → 1418,1057 | 40,120 → 1240,640 | `showcase-approval.png` |

Each frame was reviewed visually for local paths, account names, e-mail addresses, tokens and private content. The only path shown is the synthetic project. The Sandbox used a Polish system locale, so the native dialog buttons read *Tak* / *Nie*. The README says so. The session did not open a Git repository or the Agents tab, so the README shows no Git or Agent Control Center screenshot. Older-build captures are not substituted.

**Brand compositions.** The wordmarks, hero and gallery frames, how-it-works flow, social preview and pillar icons are original HTML/CSS/SVG layouts authored for MEGA-GITHUB-PREMIUM-01. They were rasterized locally with Playwright Chromium at fixed sizes. Re-rendering produced byte-identical PNGs. The only raster brand input is the approved Orbit derivative `images/melly-512.png` (SHA-256 `ec728884…d1e3`). It is placed unmodified on a black rounded tile; it is not regenerated, recolored or remasked. Text uses Source Sans 3 (SIL Open Font License 1.1) and Ubuntu Mono (Ubuntu Font Licence 1.0), rendered from local font files. No external media service, stock image or competitor material was used. PNGs carry no text or EXIF metadata chunks.

The Orbit statements in [Licensing scope](../product/LICENSING.md#name-and-logo) apply to the embedded icon. Like every image in this repository, these files are not licensed under Apache-2.0.

## Withheld historical media

**The native captures and brand compositions below are withheld from the public source** until their media rights are confirmed. This page keeps their provenance. Two capture classes existed in `docs/assets/showcase/`. They must never be confused. None of them is used by the current README.

| Class | Location | Source | Used by README |
|---|---|---|---|
| **Native Windows** (MEGA-SHOWCASE-02, 2026-11-03) | `native/` (withheld) | Real Tauri 2 / WebView2 app, genuine Rust IPC, synthetic disk repository | Withheld from public source |
| Browser with MOCK native bridge (MEGA-SHOWCASE-01, 2026-11-02) | Historical showcase evidence | Actual frontend in Chromium with an in-memory `__TAURI__` MOCK and a visible provenance strip | No, superseded |
| Brand compositions | `brand/` | Original local SVG layouts embedding the existing approved icon | Withheld from public source |

## Native Windows media

Build identity, isolation, capture method and caveats: [Native capture](NATIVE-CAPTURE.md). Hashes of the executable and every served frontend asset: [NATIVE-SOURCE-FINGERPRINT.json](NATIVE-SOURCE-FINGERPRINT.json). The opened repository: [orbit-dashboard-fixture.json](orbit-dashboard-fixture.json).

| Asset | Scene |
|---|---|
| `native-workspace-overview.png` (withheld) | Explorer expanded, three tabs, `approvals.ts` saved on disk (README hero) |
| `native-editor-tabs.png` (withheld) | Explorer hidden with Ctrl+B, three tabs, test file |
| `native-command-palette.png` (withheld) | Command palette filtered to "go to" |
| `native-quick-open.png` (withheld) | Go to File for "appr", 13 files indexed, `.git` skipped |
| `native-find-in-files.png` (withheld) | Find in Files for `APPROVAL_TTL_MS`: 6 matches, 3 files, 23 ms |
| `native-git-diff.png` (withheld) | Read-only Git: 2 modified + 1 untracked, side-by-side diff |
| `native-agent-control-center.png` (withheld) | Execution disabled, disclosures, read-only plan job form |
| `native-workspace-flow.gif` (withheld) | Explorer → component → `approvals.ts` → tab switching |
| `native-navigation-flow.gif` (withheld) | Palette → Go to File → Find in Files → source line |
| `native-git-review.gif` (withheld) | Dev Center → Git → diff → side-by-side → hunk → filter |

Every screenshot and every decoded GIF frame was reviewed visually and scanned with the built-in Windows OCR engine for local paths, account names and e-mail addresses. PNGs were re-encoded without ancillary metadata. The Agent Control Center composition deliberately starts below the CLI detection cards, because those cards print absolute local paths. The writable "Edit files in this folder" profile is present in the job form's native option list as "disabled until the writable-agent contract is accepted"; open option lists are not captured.

## Superseded browser media

The SHOWCASE-01 files in `screenshots/` and `demos/` were rendered from the actual frontend in Chromium with a capture-only MOCK native bridge and a visible **BROWSER DEMO / SYNTHETIC PROJECT / NATIVE BRIDGE MOCK** strip. They prove rendering and interaction over mocked data, not native filesystem, Git, IPC or provider behavior. Their fixture is [synthetic-fixture.json](synthetic-fixture.json) and their served-file hashes are in [SOURCE-FINGERPRINT.json](SOURCE-FINGERPRINT.json). The historical captures are preserved with SHOWCASE-01 evidence outside this source tree.

## Brand sources

The approved orbital icon (Orbit) is AI-assisted owner branding described in [Licensing scope](../product/LICENSING.md#name-and-logo). It is reused from `images/melly-512.png` and derived to a documentation-only icon PNG. It is not regenerated, remasked or installed. Hero and wordmark layouts are original local SVG compositions in midnight, indigo and violet with system typography. PNGs were rasterized locally. No external media service was called.

[Hermes Agent](https://github.com/NousResearch/hermes-agent) was read solely as a repository information-architecture benchmark. No logo, copy, artwork, screenshot or media was copied.

## Historical evidence

The older `docs/assets/screenshots/` directory and its provenance are preserved unchanged. Historical MEGA-09 native QA ran the same executable with synthetic CLI jobs and recorded 26 passing scenarios. SHOWCASE-02 did not rerun that suite; its native session opened a folder, navigated, searched and inspected Git with execution disabled.

## Reproduce safely

The fixtures are self-contained. The capture harness stays in the external MEGA-SHOWCASE-02 evidence package because it references this machine's reviewed executable, Playwright installation and evidence paths. To reproduce: use a separate application identifier or a disposable Windows account, an empty WebView2 user-data folder, the exact synthetic repository and a folder-dialog guard that refuses every other path. Review every output frame before publication. Never select an owner folder or copy a private profile.

The alpha.3 presentation is public in the [GitHub source revision](https://github.com/Melly-999/melly-ide-desktop/tree/653bcee05eb91894be5680df27403be5616dec75). The withheld historical media above has separate provenance.
