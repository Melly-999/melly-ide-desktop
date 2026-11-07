# GitHub presentation: owner preparation

The README and its media are in this repository. Some parts of the GitHub page live in repository settings instead, and only the owner can change them. Nothing below has been applied.

## Recommended metadata

| Field | Recommendation |
|---|---|
| About description | Local-first Windows coding workspace: explicit-save editing, read-only Git review and approval-gated agent workflows. Experimental alpha. |
| Website | Leave empty until an approved product site exists. |
| Topics | `code-editor`, `ide`, `developer-tools`, `windows`, `tauri`, `rust`, `webview2`, `local-first`, `git`, `ai-agents`, `claude-code`, `codex` |
| Social preview | [`docs/assets/readme/social-preview.png`](../assets/readme/social-preview.png): 1280 × 640 PNG, 367 KB |
| Releases, Packages, Deployments sidebar | Hide Packages and Deployments while they are empty. Keep Releases visible; it stays empty until a binary is approved |
| Pinned repository blurb | Your workspace. Your agents. Your control. A local-first Windows IDE with explicit approvals. |

The description is 137 characters and the blurb is 93. Pinned cards show the About description, so use the blurb as the description instead if you want the tagline on your profile. Neither text claims availability, certification or performance.

## Apply in the GitHub UI

1. **About.** On the repository home page, click the gear next to **About**. Paste the description, leave **Website** empty, add the topics, and uncheck **Packages** and **Deployments** under *Include in the home page*. Save.
2. **Social preview.** Go to **Settings → General → Social preview → Edit → Upload an image** and choose `social-preview.png`.
3. **Private vulnerability reporting.** Go to **Settings → Security → Advanced Security** (named *Code security* on some accounts) and enable **Private vulnerability reporting**. [SECURITY.md](../../SECURITY.md) and the issue chooser point reporters there.
4. **Pin.** On your profile, choose **Customize your pins** and select `melly-ide-desktop`.

Check that the README renders correctly in both light and dark themes before you change settings. These steps do not publish a release or a binary.

## Repository files that shape the page

- [`README.md`](../../README.md) is the landing page. There is no `.github/README.md` overriding it.
- [`.github/ISSUE_TEMPLATE/config.yml`](../../.github/ISSUE_TEMPLATE/config.yml) adds security, getting-started and FAQ links to the new-issue chooser and turns off blank issues.
- The bug report and feature request templates and the pull request template live under [`.github/`](../../.github/).

Provenance for every image: [Media sources](MEDIA-SOURCES.md).
