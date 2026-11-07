# Getting started on Windows

Melly IDE v0.7.0-alpha.3 is a public, unsigned experimental pre-release for Windows 11 x64. Choose the current-user installer or the standalone executable from the [GitHub release](https://github.com/Melly-999/melly-ide-desktop/releases/tag/v0.7.0-alpha.3).

## Download and install

1. Download the [NSIS installer](https://github.com/Melly-999/melly-ide-desktop/releases/download/v0.7.0-alpha.3/Melly.IDE_0.7.0-alpha.3_x64-setup.exe) or the [standalone EXE](https://github.com/Melly-999/melly-ide-desktop/releases/download/v0.7.0-alpha.3/melly-ide-desktop.exe). Download the [third-party notices and corresponding source archive](https://github.com/Melly-999/melly-ide-desktop/releases/download/v0.7.0-alpha.3/THIRD-PARTY-NOTICES-0.7.0-alpha.3.zip) alongside either executable.
2. Open PowerShell in the download folder. Run the command for your file and compare the result with the corresponding SHA-256 below. If the hash differs, stop.

   ```powershell
   Get-FileHash -Algorithm SHA256 -LiteralPath '.\Melly.IDE_0.7.0-alpha.3_x64-setup.exe'
   Get-FileHash -Algorithm SHA256 -LiteralPath '.\melly-ide-desktop.exe'
   ```

   **NSIS installer SHA-256**

   ```text
   6cbe545412127f18431e416631c033fff9f2b39f4cee34306e2471d59dc3fc6b
   ```

   **Standalone EXE SHA-256**

   ```text
   c1f8eeb3a9797f65223860ea9119e9307c34288adaa7f25b535875dfd505a7a8
   ```

   A match confirms the downloaded bytes against the published hash. It provides no code signature or assurance of software safety. The [checksum companion](https://github.com/Melly-999/melly-ide-desktop/releases/download/v0.7.0-alpha.3/SHA256SUMS.txt) uses the installer's original filename and omits the standalone EXE.

3. Both executables are unsigned. SmartScreen or Smart App Control may warn or block them. Keep Windows security protections enabled and stop if Windows or Defender reports a security alert.
4. Run setup to install for the current user under `%LOCALAPPDATA%\Melly IDE`. Both variants require Microsoft Edge WebView2 Runtime. If it is missing, setup may download and run Microsoft's bootstrapper, which requires internet access. The standalone EXE runs directly once WebView2 is present.
5. Use a disposable project. The app stores its profile under `%LOCALAPPDATA%\com.melly.ide`. Uninstall the NSIS version from **Windows Settings → Apps**. Uninstall keeps your profile unless you select the data-deletion option.

The alpha has no automatic updater or guaranteed support. Report reproducible problems with synthetic data through [GitHub Issues](https://github.com/Melly-999/melly-ide-desktop/issues). Follow the [security reporting policy](../../SECURITY.md) for vulnerabilities.

The binaries were built from [`eedeab979a08fb4ef57ded66e207915c9484f688`](https://github.com/Melly-999/melly-ide-desktop/tree/eedeab979a08fb4ef57ded66e207915c9484f688). The release tag points to `653bcee05eb91894be5680df27403be5616dec75`, which includes later documentation and presentation changes.

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

## Verification

Run these checks with the locked dependencies installed.

```powershell
npm test
npm run typecheck
node node_modules/typescript/bin/tsc --noEmit -p convex/tsconfig.json
```

Typechecking is local. For Rust and Chromium regression commands see the [development guide](../DEVELOPMENT.md).

See [security limits](SECURITY-MODEL.md) before enabling execution or selecting any sensitive folder.
