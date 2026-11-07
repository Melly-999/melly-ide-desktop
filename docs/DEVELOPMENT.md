# Development

Run commands from the verified source root in PowerShell. Quote paths containing spaces.

## Prerequisites and setup

Use Node.js 24.15.0 or newer. Windows builds require the x64 MSVC Rust toolchain, Visual Studio C++ Build Tools, Windows SDK and WebView2. See the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

```powershell
npm ci --ignore-scripts
npm start
```

The allowlisted development server serves `http://127.0.0.1:3000`; it excludes backend files, secrets and Git metadata. `PORT` can select another local port. Raw source public configuration does not activate auth or AI. Do not deploy Convex to typecheck it.

## Core validation

```powershell
npm test
npm run typecheck
node node_modules/typescript/bin/tsc --noEmit -p convex/tsconfig.json
cargo test --offline --manifest-path src-tauri/Cargo.toml
git diff --check
```

Node tests include backup v3, persistence/offline, disk interface, preview separation, native Git contracts, agent queue and terminal disabled states. Some use mocks and source assertions. Rust tests exercise real Windows filesystem fixtures and native internals; their synthetic Git oracles never operate on owner repositories. They are not WebView2 UI acceptance.

Cargo offline commands require a populated cache. Do not install missing tools or fetch dependencies just to label a check PASS. `CARGO_TARGET_DIR` may point outside the repository for evidence/build isolation.

## Chromium regression

The lockfile installs Playwright as a development dependency. Use an installed Google Chrome. Set `CHROME_PATH` if it is outside the standard Windows location. Use a new scratch directory for each QA run so no suite reuses fixtures or profiles from earlier runs.

```powershell
$qa = Join-Path ([System.IO.Path]::GetTempPath()) ("melly-browser-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $qa | Out-Null
$env:CHROME_PATH = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
$env:MEGA08_AUDIT_DIR = Join-Path $qa 'mega08'
$env:MEGA09_AUDIT_DIR = Join-Path $qa 'mega09'
$env:UX02_AUDIT_DIR = Join-Path $qa 'ux02'
$env:MEGA04_AUDIT_DIR = Join-Path $qa 'mega04'
$env:MEGA05_AUDIT_DIR = Join-Path $qa 'mega05'
$env:MEGA07_AUDIT_DIR = Join-Path $qa 'mega07'
$env:M11_AUDIT_DIR = Join-Path $qa 'local-folder'
$env:TEMP = $qa
$env:TMP = $qa

npm run test:browser
npm run test:mega-browser
npm run test:mega08-browser
npm run test:mega09-browser
npm run test:ux02-browser
npm run test:premium-browser
npm run test:mvp01-browser
npm run test:auth-browser
npm run test:ai01-browser
node tests/browser-mega04.cjs
node tests/browser-mega05.cjs
node tests/browser-mega07.cjs
node tests/browser-local-folder.cjs
```

These suites use loopback servers, isolated browser contexts and synthetic data. Tests covering the desktop adapter inject a mock native bridge. Run native WebView2 and Rust IPC checks separately. Auth and AI suites use fixtures.

`npm run test:mvp021-browser` additionally requires the historical v14 shell fixture. Set `MVP021_PREVIOUS_SHELL` to its separately verified source directory. The upgrade scenario requires that historical generation.

## Native source build and local run

```powershell
npm run desktop:prepare
cargo build --locked --target x86_64-pc-windows-msvc --manifest-path src-tauri/Cargo.toml
cargo run --locked --target x86_64-pc-windows-msvc --manifest-path src-tauri/Cargo.toml
```

Desktop preparation stages only the offline-first shell and an empty auth config. Use a fresh desktop-dist directory when moving from a candidate that included the private-preview SDK. The separate private browser preview can bundle that SDK and requires an explicit owner-approved `MELLY_CONVEX_URL` together with the matching dedicated Clerk development settings. Keep these settings in the ignored local configuration. No Tauri CLI installer or package publication is implied. NSIS packaging is a separate internal QA operation using an already installed, reviewed CLI/toolchain.

Use a fresh disposable WebView2 profile for native QA. The owner selects only the synthetic fixture folder in the real dialog. Never automate global SendKeys. Report native IPC isolation, save/conflict, Git preservation, restart and backup results separately from Chromium mocks.

## CI and evidence

The manually dispatched `local-validation.yml` workflow runs only Node tests and both TypeScript checks, with read-only repository permissions and no secrets, deployment or release steps. It has not been run remotely by MEGA-06. A green local command is not a GitHub Actions result. Native/browser validation remains a separate gate.

Keep logs, synthetic fixtures, screenshots, installers and source-preservation manifests outside the repository. Final reports must distinguish implemented, tested, pending-owner, published and deployed states.
