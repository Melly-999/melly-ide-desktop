# Melly IDE roadmap

## Current local checkpoint — MEGA-06

This checkpoint describes the integrated working tree, not a pushed commit or public release. Native version: 0.5.0-rc.1. The detailed validation record is maintained in the owner's external MEGA-06 evidence package.

| State | Scope | Next acceptance |
|---|---|---|
| Implemented locally | IndexedDB workspace, backup v3, offline shell | Retain regression coverage and physical-device boundaries. |
| Implemented locally | Windows folder Explorer, explicit UTF-8 disk save and conflict/recovery | Native integration acceptance passed; crash/rollback hardening remains. |
| Implemented locally | Separate native preview, read-only Git | Maintain IPC isolation; extend egress and hostile-path tests. |
| Implemented locally | Agent metadata queue, terminal disabled gate | No executor or command execution enabled. |
| In progress | Second-machine installation and repository migration | Local integration/native acceptance passed; verified owner migration handoff supplied. |
| Planned / separately gated | Provider acceptance, account-private sync, live agents, terminal runtime | Explicit authorization, bounded permissions and cost controls. |
| Planned | Billing, native iOS/TestFlight and public distribution | Legal/provenance, signing, device and service acceptance. |

Recommended MEGA-07: close Windows distribution and recovery/security acceptance before expanding execution privileges. See [Windows QA](WINDOWS-QA.md), [Security](../SECURITY.md) and [Architecture](ARCHITECTURE.md).

## Historical roadmap records

The dated material below is preserved verbatim. Earlier run counts, predictions and acceptance statements are historical; the current table above defines this checkpoint's scope.

---

# Melly IDE — Roadmap v4.0: od zaakceptowanego UI do przychodów i App Store
**Data:** 22.10.2026  
**Definicja RUN:** jeden duży, zintegrowany run programistyczny z własnymi bramkami akceptacji i rzeczywistym QA. To jednostka planowania, nie gwarancja zakończenia w jednej sesji, szczególnie przy logowaniach i limitach modeli. 
**Stan wejściowy:** UX i Windows lokalnie zweryfikowane do v3.4 wg raportów, ale z iPhone screenshotami istotnych błędów; Convex DEV utworzony, Clerk/Cortex live nieukończone; AI/ceny/iOS native niegotowe.

## Siedem dużych przyszłych runów (od dziś)

| Nr | Run / zakres | Namacalny cel i bramka akceptacji | Zależności / ryzyko |
|---:|---|---|---|
| **1** | **UX-02 / v4.0 — Visual Implementation & iPhone Fix** | Cztery ekrany wg zaakceptowanej referencji; **nowa ikona orbitalna nr 2 (bez M)**; Dashboard literalnie `Hello World`; iOS safe-area, jeden system nawigacji, naprawa SW i prywatnego preview, wszystkie regresje. Weryfikacja fizycznego iPhone przez użytkownika. | Brak potrzeby Clerk; test na realnym urządzeniu użytkownika |
| **2** | **CLOUD-01 — Real Auth, Synced Projects & Private GitHub** | Osobny Clerk DEV + `CLERK_JWT_ISSUER_DOMAIN`, rzeczywiste Convex dev auth/tenant isolation, Cortex scoped memories, bezpieczne GitHub App i prywatne repo; kontrola konfliktów cross-device. | Interaktywne konto/zgody, Free limits, sekrety tylko w vault/env |
| **3** | **AI-01 — Real AI Coding & Agent Queue** | OpenRouter streaming i limitowanie kosztów, repo context, realne propozycje zmian, test evidence/approve, queue, autoryzowane PR. Jeden kompletny przepływ repo → task → AI → diff → review → zatwierdzony PR. | Cloud/auth, API keys i limit wydatków |
| **4** | **REVENUE-01 — Freemium + Pro / Windows Paid Beta** | Billing, egzekwowane serwerowo limity, onboarding konta, prawo do usunięcia danych, polityki prywatności, release Windows beta, monitoring kosztu na zaakceptowane zadanie. Pierwsze rzeczywiste płatne piloty po kwalifikacji. | Licencje/pochodzenie kodu, regulamin, realny popyt |
| **5** | **IOS-01 — Native iOS + TestFlight** | Mac/Xcode, Tauri iOS, WebKit persistence, Apple login/payment requirements, permissions/microphone, signed device build, real testers przez TestFlight. | Dostęp do macOS, Apple Developer, sprzęt iOS |
| **6** | **STORE-01 — Apple App Store 1.0** | Review zgodności, StoreKit/subscription, metadane, screenshoty, prywatność i review Apple; faktyczna publikacja dopiero po zatwierdzeniu przez Apple. | Apple Review / external delay; nie gwarantować daty |
| **7** | **CAPABILITY-01 — Rozszerzony Agent/Tools Suite** | Biblioteka Skills, Commands, scheduler Automations, MCP connectors, Voice, zdalny Terminal tylko w izolowanym środowisku, Live Preview, kontrolowana integracja Klaus/MellyCore i dopuszczone integracje aplikacji. | Może być częściowo rozwijane równolegle w runs 3–5, lecz pełny zakres nie może blokować pierwszych przychodów lub App Store |

> Liczba runów nie równa się liczbie ukończonych mega-milestone'ów w poprzedniej roadmapie; v4.0 rozpisuje zaległe prace MEGA-01 jako pierwszy run, a pozostałe weryfikowalne cele na kolejne wykonania. Jeśli integracja chmurowa ma blokery, niezależne zadania z następnych etapów można prowadzić osobno z testami.

## Ile runów do konkretnych efektów? (liczone od teraz)

| Osiągnięcie | Minimalna planowana liczba dużych runów | Kryterium „osiągnięte” |
|---|---:|---|
| Zatwierdzony ekran Home z **Hello World**, wygląd premium, Code/Review, Agents, Agent Chat | **1** | Realna aplikacja, wizualny QA, zachowany edytor i dane |
| Usunięcie nachodzącej godziny/baterii i fałszywych makiet | **1** | Potwierdzenie na fizycznym iPhonie |
| Prywatna PWA z realnym offline na iPhonie | **1**, warunkowo | Offline cold/reload po instalacji SW i kontrola na rzeczywistym iOS |
| Logowanie Clerk i synchronizacja Convex między urządzeniami | **2** | Live DEV auth + dwa urządzenia + test konfliktów i odmowy dostępu |
| Pamięć Cortex z rzeczywistymi przestrzeniami i uprawnieniami | **2** | DEV write/read/delete i cross-tenant denial |
| Prywatne repozytoria GitHub | **2** | Realna autoryzacja GitHub App i bezpieczny read |
| Prawdziwy czat OpenRouter, wybór modeli | **3** | Realne bezpieczne wywołania z kosztami/limitami |
| AI edytuje repo, pokazuje diff i tworzy PR po zgodzie | **3** | Repo → task → approve → PR z dowodami |
| Agent Task Queue z prawdziwymi statusami | **3** | Autoryzowane wykonanie i dowody, bez fake telemetry |
| Pierwszy płacący użytkownik (cel, nie obietnica) | **4** do gotowości płatnej bety | Prawdziwe płatności i dostarczona wartość, faktyczna sprzedaż zależy od klientów |
| Windows instalator/beta dla użytkowników | **4** | Build/install/smoke + zgodność/licencje/podpis jeśli dostępny |
| Własna aplikacja iOS przez TestFlight | **5** | Weryfikowany build na urządzeniu + zewnętrzna beta |
| Publiczny Apple App Store | **6** do złożenia gotowej wersji, faktyczna akceptacja zewnętrzna | Apple zatwierdzi i opublikuje aplikację |
| Pełniejsza biblioteka Skills/Commands/Automations/MCP | **7** | Realne uprawnienia, scheduler i testy produkcyjne |
| Voice + Live Preview + bezpieczny Remote Terminal + Klaus/MellyCore | **7** pełny zakres | Osobna walidacja połączeń, urządzeń i ograniczeń iOS |

## Priorytety biznesowe
**P0** — interfejs iOS, prawdziwe zapisy, bezpieczeństwo, offline i jeden wyraźny workflow AI przy repozytorium.  
**P1** — prywatny GitHub, synchronizacja, przychód Free/Pro, monitoring kosztów, TestFlight.  
**P2** — pełniejsze możliwości agentów i integracji; dodawać modułami, nie jako warunek pierwszej sprzedaży.

## Zasady dotyczące inspirowania się zrzutami innych aplikacji
Na załączonych referencjach widać onboarding, agent chat, listy narzędzi, Skills, Commands, Favorites, Automations, integracje oraz Pro. Możemy zaimplementować **porównywalne kategorie możliwości**, ale nie kopiować nazw, artworku, cudzych status barów, screenshotów, tekstów, logotypów lub dokładnej kompozycji konkretnego produktu.

**Ograniczenia iOS:** aplikacja nie ma pełnego swobodnego dostępu do całego systemu, innych aplikacji ani ich ekranów. Funkcje Screen Awareness / system-wide automations muszą opierać się na zgodnych API i jawnych zezwoleniach, albo działać z poziomu dopuszczonych sesji zdalnych; żadne obejście sandboxu/App Store Review.

**Płatności:** nie obiecuj „Unlimited Prompts & Agents” bez twardej kalkulacji kosztów OpenRouter i limitów. Wczesny paywall jest wyłącznie demonstracyjny, dopóki realny backend billing nie istnieje.

## Utrzymanie roadmapy
Po każdym mega-runie przepisz **wyłącznie jego stan** jako VERIFIED / PARTIAL / BLOCKED / NOT STARTED wraz z dowodem testów, datą, faktycznym source hash, kosztem jeśli znany, ograniczeniami przeglądarek i ryzykiem dla następnego etapu. Nie zmieniaj statusu wyłącznie na podstawie deklaracji agenta. Zadbaj o pełny backup oraz legalne źródło codebase przed publicznym release.

## Doprecyzowanie BRAND-02 (v4.1)
- W runie 1 trzeba zastąpić monogram M zatwierdzonym orbitalnym wariantem 2 na wszystkich powierzchniach, przy zachowaniu dotychczasowych danych.
- Priorytet użytkownika: funkcjonalne i intuicyjne UI → kluczowy AI/GitHub workflow → realne logowanie → zakup Pro → TestFlight/App Store. Prace nad loginem i Pro można planować równolegle, lecz nie oznaczać UI scaffoldu jako działającej płatności.
- Liczniki od obecnego stanu: **1** run do docelowego wyglądu; **2** do realnego logowania/synchronizacji po konfiguracji Clerk; **3** do podstawowego AI Coding; **4** do płatnej bety (przy zewnętrznych bramkach); **5** do TestFlight; **6** do zgłoszenia do App Store (+ Apple Review); **7** do pełniejszego ekosystemu narzędzi i agentów.


## Repository evidence update — 2026-10-22

Run 1 UX-02: IMPLEMENTED / PARTIAL acceptance. Source is local and uncommitted at HEAD 678f6a55c32791fea92958d27e72ca2cbdb93901 with shell v8-20261022. Four real surfaces and exact icon are implemented. Browser and native evidence are under [owner-local evidence path omitted] Physical iPhone and the operator switch to the new private bundle remain pending; no deployment was performed. Do not mark this run physically verified until owner-device evidence is recorded.

Runs 2–7: NOT STARTED by this run. No auth, cloud, billing, provider, native iOS, App Store or cross-app activation is implied. Revenue requires real payments, enforced limits, license review and delivered value; it is not established by this UI.


## AUTH-01 evidence update — 2026-10-22 (current gate)

This section supersedes only the earlier current-status statement that auth had not started. Historical UX-02 and seven-run planning above remain historical planning.

| Milestone | Current evidence-bound state | Remaining gate |
|---|---|---|
| UX-02 / BRAND-02 | IMPLEMENTED locally; owner reports preview smoke on two iPhones | Physical offline, scrolled portrait/landscape safe areas and PWA reopen still require device QA |
| AUTH-01 / real Clerk + Convex identity | VERIFIED — real web DEV E2E | A signup/verification, sign-in/out/reload, distinct B identity and reload, anonymous denial; physical iPhone/native auth remain separate |
| AUTH-01 safe-area correction | IMPLEMENTED; browser simulated-inset and native guest regressions passed, shell v12 | Owner Safari and installed-PWA confirmation |
| Project sync / Cortex / private GitHub | Separate unverified future gates | No project sync or private GitHub activation in AUTH-01 |
| AI-01 / real OpenRouter coding chat | NOT STARTED | Separate authorized run with provider/cost/security gates |
| PRO-01 / real billing and entitlements | NOT STARTED | Separate audited billing run; no paid status from client flags |

Current evidence: 130 Node/emulator tests; 61 unique browser scenarios plus offline rerun; typecheck and isolated Windows guest smoke passed. These are local tests, not live auth or physical iPhone acceptance. Current source remains uncommitted at base HEAD 678f6a55c32791fea92958d27e72ca2cbdb93901. Exact owner configuration and two-device checklist: AUTH01.md; test evidence: AUTH01-VALIDATION.md and [owner-local evidence path omitted] Existing Tailscale/4175 was preserved. Stop after AUTH-01; do not automatically advance to AI-01 or PRO-01.


## AUTH-01 live continuation — current gate, 2026-10-22

Dedicated Clerk DEV application: owner-confirmed; Frontend API reachable. Convex DEV [owner DEV deployment]: issuer independently matched and deployed anonymous account:identity rejected with UNAUTHENTICATED. Public key: awaiting owner save to CLERK_PUBLISHABLE_KEY in ignored .env.local. Convex integration audience and real A/B email/session/isolation tests remain UNVERIFIED. Status remains BLOCKED — PUBLIC DEV KEY / OWNER E2E REQUIRED, not real E2E VERIFIED. Current local suite: 133/133; application and Convex-specific typechecks pass; 31 core browser regressions and 8 final adapter browser scenarios pass. Physical iPhone auth/offline/scrolled safe areas still require owner QA. See AUTH01-LIVE-E2E.md. AI-01 / PRO-01 not started.


## AUTH-01 configured DEV candidate — current gate, 2026-10-22

Public configuration VERIFIED: exact glorious-airedale-8089 Clerk DEV key/issuer match, unchanged [owner DEV deployment] issuer, 49-file sanitized candidate on existing loopback 4182, real Clerk forms and hashes verified. Convex integration dashboard status and actual JWT audience remain pending; real signup/verification, sign-in/out, reload and A/B identities require owner browser interaction. No real E2E VERIFIED claim. See AUTH01-LIVE-E2E.md and configured-smoke-02.json. Physical iPhone acceptance and routing remain separate owner gates; Tailscale/4175 unchanged.


## AUTH-01 real account-A gate — 2026-10-22

PARTIAL REAL E2E: actual Chrome account A confirmed by Convex, same server ID after reload, real logout and Guest-after-reload verified; local project/buffer preserved and anonymous access denied. Convex integration Active is owner-confirmed and actual token audience compatibility is established by server acceptance under applicationID convex. Return sign-in A and account B isolation remain PENDING. Physical iPhone QA remains separate and unverified. No commit/push, production deployment or Tailscale change.


## AUTH-01 A lifecycle passed — 2026-10-22

A's real signup/session confirmation, reload, logout, guest reload and explicit return sign-in with the same server ID passed. Local project/buffer preserved and Review navigation works. Final stable configured candidate is active on loopback 4182; B's signup/verification, distinct server identity and reload remain PENDING. AUTH-01 is not yet fully VERIFIED. Physical iPhone QA remains owner-only; Tailscale unchanged.


## Current acceptance — real web DEV E2E verified, 2026-10-22

**AUTH-01 web DEV E2E VERIFIED.** Real A email signup/verification, sign-in/out, reload and return sign-in passed; B returned a different Convex-confirmed ID and restored the same B ID after reload. The earlier Chrome tab now shows B, with no A identity. Anonymous access is rejected. Original local project/editor data is preserved and Review navigation passed. This supersedes the earlier blocked/partial checkpoints above.

Final regression: 134/134 Node/emulator tests and both typechecks PASS; sanitized candidate 49/49 hashes and private-path denial PASS. Physical iPhone safe areas/offline/keyboard and native configured auth remain unverified. Source remains uncommitted; Tailscale/4175 unchanged. Project sync, AI-01 and PRO-01 remain outside this completed web-auth scope. See AUTH01-LIVE-E2E.md and AUTH01-VALIDATION.md for evidence.

## AUTH-01 and Growth Toolkit evidence reconciliation — 2026-10-22

AUTH-01 real web DEV E2E remains VERIFIED based on the existing live E2E
acceptance in `docs/AUTH01-LIVE-E2E.md`. The record covers owner-assisted
real authentication with server-confirmed identity, A/B identity distinction
and reload/logout behavior while preserving the local editor. This update
does not claim a new live test run.

The owner reports 7/7 physical iPhone checks passed. Record this as
OWNER_REPORTED_PASS — 7/7, supplied on 2026-10-22. The aggregate result was
not independently executed or replayed by this agent. The individual check
names, device/iOS matrix and tested candidate were not provided with that
statement, so this update does not infer unlisted device or native coverage.

| Gate | Current evidence-bound state |
|---|---|
| AUTH-01 Web DEV | VERIFIED — existing recorded real live E2E acceptance |
| Physical iPhone checks | OWNER_REPORTED_PASS — 7/7; per-check/device/candidate metadata not provided |
| Growth Toolkit research | COMPLETED — evidence-backed research report prepared on 2026-10-22 |
| Growth Toolkit follow-up preparation | COMPLETED — local workflow/skill proposals, demo storyboard, three post drafts, landing/signup outline and roadmap proposal prepared; unpublished |
| Configured native authentication | Separate unverified gate; no completion implied by the iPhone aggregate |
| Local projects | Browser-profile storage; no account-private cloud project sync claim |
| Project sync / Cortex / private GitHub | Existing separate roadmap gates; unchanged by this update |
| AI-01 | FUTURE IMPLEMENTATION WORK — NOT STARTED by this update; requires a separate authorized run |
| PRO-01 | FUTURE IMPLEMENTATION WORK — NOT STARTED by this update; requires a separate authorized run |
| Paid beta / REVENUE-01 | FUTURE IMPLEMENTATION WORK — no paid-beta readiness, purchase or release established |

Growth Toolkit evidence is in
`[owner-local evidence path omitted]`
and its `follow-up\` package. Completion here describes research and local
draft preparation; it does not establish publication, signup activation,
customer outreach or product availability.

This section updates the current evidence summary; earlier pending-device
entries remain historical checkpoints. This reconciliation changes
documentation only. No application runtime, auth/Convex configuration,
PWA, billing, Tailscale routing, deployment, commit, push or merge was performed.
Native distribution, TestFlight, App Store availability and production
acceptance are not established by these results.


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
