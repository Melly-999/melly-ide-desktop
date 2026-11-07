# Melly IDE project history

## Historical record supplied with UX-02 v4.1

T0 / T0.1 introduced safe simulated execution and explicit guarded Review / Approve / Reject / Cancel. T1 added local IndexedDB persistence. T1.1 added versioned shell caching; T1.2 added v1 backup and selective import. MEGA-01 introduced separate multi-project storage, v2 backups, SHA-verified public GitHub working copies and desktop foundations. These are historical milestone descriptions; see docs/MEGA-01.md for contracts.

## 2026-10-22 — UX-02 / BRAND-02 implementation

Reverified the development checkout and its historical baseline. Inherited dirty work and deleted photos were retained. A verified 179-entry recovery snapshot was saved outside the checkout before edits.

The reference-pack manifest matched every supplied file. The separately attached icon has the same SHA-256 as selected option 2. The original icon bytes remain unchanged under images/brand/. New favicon, Apple touch, PWA and Windows derivatives use that exact image, with no M. No new artwork was generated.

Implemented the approved four functional surfaces: literal Hello World Dashboard; existing editor plus inspection and guarded review; categorized Agents & Tools; disconnected Melly Agent chat with local draft and informational Pro. Replaced fake phone onboarding with optional help, moved legacy tools/demo/backup into More, retained one primary navigation. Kept both IndexedDB contracts, backup formats and approval ownership.

Offline shell generation v8-20261022 and an explicit sanitized preview builder were added. The existing 4174 Python server and Tailscale configuration were not changed. Fresh isolated HTTPS probes against the existing private preview observed intermittent 502 responses for js/app.js, js/chat.js and js/hub.js; later direct requests returned 200 with correct MIME. No exact physical-iPhone installation exception was available. Transport failure is observed; the original device-specific root cause remains unverified.

Baseline run: 102/102 unit tests and typecheck passed. UI 13, offline 9, backup 2, workspace/GitHub 7 and premium 11 browser scenarios passed after rerunning download-dependent baseline suites outside the shell sandbox. Earlier sandbox download cancellations were environmental and remain in the audit trail.

The final unsigned Windows debug build compiled offline and passed a native WebView2 smoke test in a separate test profile: Hello World, orbital header, packaged-desktop status, exact edit/save/reload restoration. See [owner-local evidence path omitted] This establishes local debug behavior, not signing, installation or release acceptance.

Physical iPhone Safari / installed PWA: PENDING USER DEVICE VALIDATION. Existing private HTTPS origin has not been switched to the candidate. Cloud, identity, billing, real AI and execution remain disconnected. No commit, push, deployment, cloud mutation, credential read, or user-data clearing was performed.

Final validation for shell v8: 105 unit tests, 53 unique browser scenarios, typecheck and native isolated WebView2 smoke passed. See UX02-VALIDATION.md for exact commands, evidence paths, prior failed attempts and remaining device/transport limits.


## 2026-10-22 — AUTH-01 local integration; real E2E blocked

Owner reports UX-02 opened on two physical iPhones through the existing private Tailscale HTTPS preview (port 4175). This prior device smoke is owner-reported; complete physical offline and scrolled safe-area regression is not yet proven.

Reverified branch t0-safety-baseline and HEAD 678f6a55c32791fea92958d27e72ca2cbdb93901; preserved inherited dirty/untracked work and four deleted photos. A 198-entry pre-run recovery snapshot was hash-verified outside the checkout. Added official pinned Clerk JS 6.40.0, a vanilla session/client adapter, real SDK modal sign-up/sign-in/sign-out wiring, EN/PL account states and a read-only server-derived Convex identity probe. No React rewrite, durable profile mutation, project upload or data migration was introduced. Account changes/logout close the Convex client and invalidate stale work; server plan is Free and sync stays disabled. Local browser-profile files remain shared independently of cloud accounts.

Shell v11-20261022 includes authored account modules and the fixed opaque safe-area header. SDK/dynamic auth endpoints are excluded from SW cache. The new sanitized preview includes only 49 explicitly allowlisted runtime/static files; public DEV config is validated and injected only at preview build time. Existing 4175/Tailscale preview was not modified.

Final checks: 130/130 Node/emulator tests, typecheck, 61 unique browser scenarios (53 inherited + 8 AUTH-01), repeated 9-case offline suite and isolated native Windows guest save/reload smoke PASS. Browser safe-area tests use simulated insets; physical iPhone confirmation remains pending. Local review and tests resolved lifecycle, modal, notices and keyboard-focus issues. External CodeRabbit review did not run; owner selected local review after automatic approval rejected source disclosure.

Status: AUTH-01 CODE READY / REAL E2E BLOCKED — OWNER SETUP REQUIRED. Owner confirmed there is no dedicated Melly IDE Clerk DEV app/key/issuer/integration. No real authentication, JWT verification or live A/B isolation is claimed. No Convex env/config push, commit, Git push/reset, production deployment, paid resource or browser-data deletion occurred. See AUTH01.md and AUTH01-VALIDATION.md plus [owner-local evidence path omitted] AI-01 and PRO-01 were not started.


## 2026-10-22 — AUTH-01 live E2E resumed

Owner confirmed a dedicated Clerk DEV app at https://glorious-airedale-8089.clerk.accounts.dev and successful Convex DEV sync. Independently read the matching deployment-scoped issuer from [owner DEV deployment] and called its deployed account:identity anonymously: UNAUTHENTICATED. Reproduced application and Convex-specific type checks and 130 baseline tests. Owner clarified the public key had not been saved locally; prepared only public DEV fields in the ignored .env.local without changing existing Convex entries. Added a five-field allowlisted CLI reader and 3 regression tests; 133 tests passed. Account ID is shown only after server confirmation for visible A/B acceptance; shell v12. Real email signup/login/session restore and live A/B tests remain BLOCKED until the owner saves the key and completes the browser flows. No issuer/environment mutation or backend deploy was performed by this continuation. See AUTH01-LIVE-E2E.md for the exact gate and physical-iPhone checklist.


## 2026-10-22 — dedicated DEV key matched; real Clerk candidate opened

Owner confirmed glorious-airedale-8089 as the sole authorized Clerk DEV instance and replaced a wrong-instance key locally. The matching key was verified without printing it. Corrected only the malformed local issuer field; preserved the correct deployment-scoped issuer and existing local values. Built a 49-file configured sanitized candidate, generation v17364889687491188712-20261022, and switched only the owned loopback 4182 server while retaining origin/storage. Real Clerk sign-in/sign-up UI and asset hashes passed isolated smoke checks; no mock was substituted. Sign-up is open for owner entry. Convex integration Active status, actual token audience, real email/account flows and A/B acceptance remain unverified pending owner interaction. Console extraction was blocked by automatic approval review; no logs/session material were collected. No production/backend deployment, Tailscale alteration, commit/push or data clearing occurred.


SDK notice generation was corrected to avoid accumulating prior notices across builds. The repeat-build regression and full 134-test suite passed; stable configured bundle prepared separately without interrupting the owner's active real signup form. Real E2E acceptance remains pending.


## 2026-10-22 — real account A, reload and logout verified

Owner performed real signup/email verification in Chrome and confirmed Clerk Convex integration Active. Agent observed server-confirmed identity, exact ID continuity after reload, real logout removing account/profile, and Guest surviving reload. Original local project/editor buffer remained unchanged; anonymous DEV identity probe denied access after logout. IDs remained private and no tokens/cookies/passwords/codes were collected. Return sign-in A and account B isolation are still pending owner interaction; AUTH-01 remains PARTIAL. The in-app browser is a separate unauthenticated profile and was not used as proof of the owner Chrome session.


## 2026-10-22 — account A return sign-in passed

Observed real return sign-in to A with the same server-confirmed ID, preserved original local project/buffer, and functional primary Review navigation without approvals. Signed A out and confirmed no old profile/ID before B. Switched only the owned loopback 4182 server to the stable configured bundle at the signed-out boundary. B's real signup/sign-in form is open; its identity isolation/reload checks remain pending. No session/credential data was exposed or transferred.


## 2026-10-22 — AUTH-01 real web DEV E2E verified

Owner completed B's real account flow. Agent observed Clerk Signed in, Convex Confirmed by server, a server Account ID different from A, and the same B ID after reload. The earlier Chrome tab also showed B without retaining A's identity. Together with the earlier real A signup/email verification, logout/Guest reload and return sign-in, the web DEV acceptance criteria passed. Raw IDs, passwords, verification codes, JWTs and cookies were not printed or exported.

Original local project selection and exact editor buffer were preserved through both accounts; primary Review navigation passed without approving owner source. Account isolation covers the server-derived read-only identity probe; local browser-profile files remain shared and cloud sync stays disabled. Active dedicated Clerk/Convex DEV integration accepted actual sessions under applicationID convex; raw JWT claims were not inspected.

Final rerun: 134/134 tests, application typecheck and Convex-specific typecheck PASS. Stable configured candidate on existing loopback 4182 passed 49/49 asset hashes, sensitive-path 404s and a fresh anonymous UNAUTHENTICATED probe. Final scope audit found 15 expected continuation files, no unexpected changes, unchanged critical local modules/backend source and empty Git index. Privacy-cropped A screenshot retained; B screenshot capture timed out and is unavailable. Physical iPhone and native configured-auth acceptance remain pending. No commit/push/reset, backend/production deployment, paid resource, Tailscale change or data clearing; AI-01/PRO-01 not started. Exact current evidence: AUTH01-LIVE-E2E.md and live-e2e-20261022-01/final-live-acceptance.json.


## AI-01 local implementation checkpoint — 2026-10-22

AI-01 authenticated server-only OpenRouter boundary, catalog/selection, explicit
context preview/confirmation, non-streaming chat lifecycle, spending ledger and
validated Fix/Refactor proposals are IMPLEMENTED locally and MOCK TESTED.
Existing guarded Review applies changes only after human Approve; Reject/Cancel
and stale-revision guards remain enforced. Tasks/usage are owner-scoped.
No real-provider request, project-content upload, Convex DEV sync, environment
write, paid call, commit/push, deployment or Tailscale change was performed.

UX-02 and AUTH-01 real web DEV acceptance remain historical VERIFIED milestones;
AUTH-01 physical iPhone 7/7 remains OWNER_REPORTED_PASS. Growth Toolkit is complete.
AI-01 live provider, real deployed AI account isolation and physical-device
acceptance remain UNVERIFIED / OWNER ACTION REQUIRED. PRO-01 and paid beta are
not implemented or started. See AI01.md and the external audit
`[owner-local evidence path omitted]` for exact local
checks, screenshots, preservation evidence and the separate owner activation gates.
