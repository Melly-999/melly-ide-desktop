# Windows internal QA distribution

## Current candidate: 0.6.0-rc.1 (MEGA-07)

Product **Melly IDE Windows QA**, identity `com.melly.ide.mega05.qa` (kept, so a QA install upgrades the earlier QA install instead of creating a parallel profile), Windows 11 x64, NSIS current-user installation, unsigned, no updater, not a public release. MEGA-07 changed executable inputs (atomic save, interrupted-save recovery, `folder_version`, `app_diagnostics`, recovery v2, diagnostics UI), so a new version was built; the 0.5.0-rc.1 package below is preserved unchanged.

Installer: `Melly IDE Windows QA_0.6.0-rc.1_x64-setup.exe`, SHA-256 `8c4beb07e338cb14aafd85ce5d3c1d8a1890a97b8aba6e9d47d9c1555b65fb1c`, 3,384,892 bytes.

Trusted release-manifest SHA-256: `c2559dedfc021fcacc0277cb497c420e21d1e4014714c692cda555464bf4b012`.

The package's `Install-MellyIDE.ps1` additionally checks the expected version and that the manifest disables updates and public distribution, and reports Windows build, WebView2 Runtime version and Authenticode status read-only. See `docs/MEGA-07.md` for the behaviour changes.

## Previous candidate: 0.5.0-rc.1 (MEGA-05)

The existing MEGA-05 package is version **0.5.0-rc.1**, product **Melly IDE Windows QA**, identity `com.melly.ide.mega05.qa`, Windows x64, NSIS current-user installation. It is unsigned, has no updater and is not a public release.

Installer filename: `Melly IDE Windows QA_0.5.0-rc.1_x64-setup.exe`.

Installer SHA-256: `c4a6632c3ac32d721edbf5b24c26b48547c3891818a8a29fdd94128a57a5d4f7`.

Trusted release-manifest SHA-256: `fb9a8f38060d7762e56a3efc2af81ccb4eee895f387cc24c2554c7fa7bae5563`.

These values identify the existing external QA package; obtain the full package and trusted checksum from the owner. The included `Install-MellyIDE.ps1` validates manifest identity, exact filename, length and hash; `-VerifyOnly` does not launch installation. Normal installation requires typing `INSTALL` in that verifier. Do not bypass Windows security controls.

An existing system Microsoft Edge WebView2 Runtime is required. Node, Rust, Git and an editor are development tools and are not required by the installed static app. The installer does not download/install WebView2. This sentence describes the historical 0.5.0-rc.1 QA package only. The 0.7.0-alpha.3 installer uses Tauri's `downloadBootstrapper` mode: If no Microsoft Edge WebView2 Runtime is detected, the installer downloads and runs Microsoft's WebView2 bootstrapper, which needs an Internet connection. Installation is fully offline only when WebView2 is already present (Windows 11 normally includes it). Successful verification is not successful installation or launch.

## Source compatibility

MEGA-06 integrates the candidate's application source. Presentation/documentation changes outside the executable do not make the older installer a new release. Compare every shell asset, Rust source, Cargo lockfile and Tauri capability/configuration with the release manifest before claiming compatibility. If those bytes change, rebuild and validate a new internal version while preserving this artifact.

The npm package metadata remains historical `0.2.0-rc.1`; Cargo/Tauri define the native QA version. The QA identifier is deliberately different from the historical production-style identifier, so existing profiles are not silently migrated.

## Pending owner acceptance

Install and launch the verified package on a second physical Windows 11 x64 machine with WebView2. Test disposable project save/conflict handling, preview separation, read-only Git, offline workspace and backup handoff. Keep the original project/profile until recovery is checked. No signing, public distribution, auto-update, real agent execution or terminal activation is authorized by this handoff.
