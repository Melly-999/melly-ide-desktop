# Getting started on Windows

Run every command from the repository root. No installer is published yet, so building from source is currently the only way to try Melly IDE.

## Browser developer view

Install Node.js 24.15.0 or newer. Run these commands from the repository root in PowerShell.

```powershell
node --version
npm ci --ignore-scripts
npm start
```

The server binds `127.0.0.1:3000` by default. Visit `http://127.0.0.1:3000`. Use a fresh browser profile and a disposable project. Browser-local Workspace is separate from native disk folders. Browser mode has no native folder picker, command execution or CLI broker.

For a second local instance, choose a free loopback port:

```powershell
$env:PORT = '31741'
npm start
```

MEGA-SHOWCASE-01 launched the exact `server/dev.mjs` entry used by `npm start` on that alternate port and exercised the frontend with an isolated, clearly labeled MOCK native bridge. That harness is QA-only; ordinary browser mode does not acquire native capabilities.

## Native developer view

Installations require their own authorization. Existing native prerequisites are Windows 11, MSVC Rust, Windows C++ Build Tools/SDK and WebView2. Use the [official Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) and the [existing development guide](../DEVELOPMENT.md).

Use an x64 MSVC developer shell from the same repository root.

```powershell
npm run desktop:prepare
cargo build --locked --target x86_64-pc-windows-msvc --manifest-path src-tauri/Cargo.toml
cargo run --locked --target x86_64-pc-windows-msvc --manifest-path src-tauri/Cargo.toml
```

Preparation writes generated desktop assets. The build produces a developer executable. The local run opens a Windows application profile, so use a disposable profile and synthetic folder for QA. The README's screenshots come from the 0.7.0-alpha.3 Windows Sandbox acceptance run. See [Media sources](../showcase/MEDIA-SOURCES.md) for their provenance.

## Installing a distributed alpha build

Install a 0.7.0-alpha.3 pre-release only if it is published on the repository's Releases page:

1. Download the installer only from the approved release page. Compare its SHA-256 (`Get-FileHash -Algorithm SHA256`) with the hash published on that page before running it.
2. The build is unsigned unless the release page says otherwise. Windows SmartScreen may warn about an unrecognized publisher. Continue only if the hash matches.
3. The NSIS installer installs for the current user under `%LOCALAPPDATA%\Melly IDE`. If no Microsoft Edge WebView2 Runtime is detected, the installer downloads and runs Microsoft's WebView2 bootstrapper, which needs an Internet connection. Installation is fully offline only when WebView2 is already present (Windows 11 normally includes it).
4. Use a disposable test project. The app stores its profile under `%LOCALAPPDATA%\com.melly.ide`.
5. Uninstall from Windows Settings → Apps. Report problems with the repository's bug report template, using synthetic data only.

## Verification

Run these checks with the locked dependencies installed.

```powershell
npm test
npm run typecheck
node node_modules/typescript/bin/tsc --noEmit -p convex/tsconfig.json
```

Typechecking is local. For Rust and Chromium regression commands see the [development guide](../DEVELOPMENT.md).

See [security limits](SECURITY-MODEL.md) before enabling execution or selecting any sensitive folder.
