# Frequently asked questions

**Can I download Melly IDE?** Yes. The [public v0.7.0-alpha.3 pre-release](https://github.com/Melly-999/melly-ide-desktop/releases/tag/v0.7.0-alpha.3) offers an NSIS installer and a standalone EXE for Windows 11 x64. Both are unsigned and experimental, with no automatic updater or support commitment. Setup may download Microsoft's WebView2 bootstrapper if the runtime is missing. [Download and verify](GETTING-STARTED-WINDOWS.md#download-and-install).

**Is it a terminal?** The Windows Command Runner executes a single approved executable with an argument array. It is not a ConPTY interactive terminal.

**Does agent detection mean AI is working?** No. Detection locates a CLI; probing checks version/help compatibility. Real paid-task acceptance is still pending owner verification. The showcase runs no agent task.

**Can agents write my project?** Writable Claude `edit` and Codex `workspace-write` profiles are natively gated. Their definitions are not general availability or authorization.

**Are external tools sandboxed by Melly?** No. They run with user Windows permissions. Job Objects manage process lifetime. Read-only profiles do not guarantee that all reads or network traffic remain in the workspace. [Security model](SECURITY-MODEL.md).

**Does the browser app run native commands?** No. Browser/PWA lacks the Windows broker. The SHOWCASE-01 browser bridge was a labeled MOCK used only for media capture; those images are superseded.

**What do the screenshots show?** The README uses real captures of the unsigned 0.7.0-alpha.3 executable from a Windows Sandbox session with a synthetic project. They show the Local Folder Explorer, a file saved to disk, navigation and search, and the native dialog for enabling execution. The session did not open a Git repository or run an agent job. [Media sources](../showcase/MEDIA-SOURCES.md#readme-media-070-alpha3).

**Is there cloud sync?** Manual backup/transfer and local recovery exist. Account-private source synchronization is not an established capability. Optional auth/backend modules do not activate providers automatically.

**Does it work on macOS, Linux or iPhone?** Windows 11 is the primary verified native target. Browser/PWA is a narrower surface. Physical iPhone acceptance and native iOS distribution are separate pending gates. Supported native macOS/Linux builds are not claimed.

**Why are some older docs different?** MEGA-08/09 added guarded one-shot execution, CLI adapters and navigation after earlier overviews were written. Those files are preserved; the product guides link the newer contracts and disclose conflicts.

**What is the license?** Melly IDE's own code and documentation use the [Apache License 2.0](../../LICENSE). Dependencies, generated Convex files, images and brand assets have their own terms; see [Licensing scope](LICENSING.md). The license does not establish a release or distribution approval.

**Can I sell or fork it?** Apache-2.0 permits commercial use, modification and redistribution, including closed-source derivatives, provided the license text and existing notices are kept and changed files are marked. It grants no trademark rights to the Melly IDE name or logo.

**How do I contribute or report an issue?** Collaboration is owner-coordinated. Read [Contributing](../../CONTRIBUTING.md), [AGENTS.md](../../AGENTS.md) and the [existing reporting policy](../../SECURITY.md). Do not put private projects or credentials in public issues.
