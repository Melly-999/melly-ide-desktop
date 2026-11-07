# Changelog

This log describes local source milestones. Entries do not establish commits, hosted CI, deployment or public releases.

## Unreleased — documentation

- Redesign the README as a product landing page with original Orbit brand compositions and real 0.7.0-alpha.3 Windows Sandbox captures of a synthetic project. Provenance is in [Media sources](docs/showcase/MEDIA-SOURCES.md).
- Add a 1280 × 640 social preview image, an issue chooser with security and getting-started links, and owner steps for repository settings in [GitHub presentation](docs/showcase/GITHUB-PRESENTATION.md).
- No application, native, installer or release change.

## 0.7.0-alpha.3 — unsigned pre-release build

- Unsigned Windows x64 EXE and current-user NSIS installer built locally with a CycloneDX SBOM, third-party notice archive and source manifest.
- Static and automated validation passed. A Windows Sandbox smoke test (administrator context, offline) passed for the app, install, reinstall and uninstall. Standard-user, Defender, UAC and SmartScreen acceptance and code signing remain open.
- The installer uses WebView2 `downloadBootstrapper`: if WebView2 is missing, it downloads Microsoft's bootstrapper (Internet required).
- Orbit branding is documented as AI-assisted and owner-directed. The historical MIT notice is preserved.

## Unreleased — MEGA-06

- Integrate the verified MEGA-05 file deltas into the preserved authoritative working tree.
- Redesign the README and add architecture, development, security, contribution and Windows QA guidance.
- Add issue/PR templates and a manually dispatched validation workflow; no remote run is claimed.
- Supply an owner-controlled directory migration handoff outside the repository.

## 0.5.0-rc.1 — internal Windows QA candidate

- Existing UTF-8 disk file editing with explicit Save, byte-version conflict detection and local recovery.
- Isolated native Live Preview, native read-only Git inspection and metadata-only agent jobs.
- Terminal execution stays disabled. No live agent executor or paid inference is activated.
- Current-user unsigned NSIS candidate; existing WebView2 Runtime required, no updater.

The release identity is defined by Cargo/Tauri, while npm package metadata remains at historical `0.2.0-rc.1`. Earlier milestones are retained in [Project History](docs/PROJECT-HISTORY.md) and dated feature documents.
