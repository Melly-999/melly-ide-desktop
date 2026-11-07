# Product roadmap

Release status updated 2026-11-07. [MEGA-08](../MEGA-08.md) and [MEGA-09](../MEGA-09.md) describe the implementation milestones. The [older roadmap](../ROADMAP.md) records earlier checkpoints.

| State | Scope | Next evidence |
|---|---|---|
| Implemented and locally tested | Windows shell, folder editing/recovery, palette/quick-open/search, read-only Git, guarded one-shot runner and queue infrastructure | Owner daily workflow review |
| Public Windows alpha | Unsigned NSIS installer and standalone EXE for Windows 11 x64 ([v0.7.0-alpha.3](https://github.com/Melly-999/melly-ide-desktop/releases/tag/v0.7.0-alpha.3)) | Standard-user installation, Defender, UAC, SmartScreen and Mark-of-the-Web acceptance. Code signing remains open |
| Implemented, owner acceptance pending | Actual read-only CLI agent workflow against a real paid provider | Explicit owner authorization and bounded real task acceptance |
| Defined, blocked in production configuration | Writable agent profiles | Owner-approved writable-agent contract and independent security review |
| QA follow-up | Project-frame IPC timeouts; approval dialogs delaying IPC; high-DPI/assistive technology; longer soak/crash/reparse tests | Focused engineering runs with reproducible evidence |
| Not available / separately planned | Interactive terminal, supported beta or stable releases, supported macOS/Linux/native iOS, account-private source sync | Separate scope, implementation and release gates |
| Public GitHub presentation | README, original brand compositions and real 0.7.0-alpha.3 Windows Sandbox captures ([media sources](../showcase/MEDIA-SOURCES.md)) | Review feedback on the alpha |

The public alpha is experimental and carries no support commitment. Provider activation has its own acceptance gate. Roadmap dates are estimates.
