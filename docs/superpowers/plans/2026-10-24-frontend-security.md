# Frontend security maintenance — 2026-10-24

User approved including the Next.js vulnerability fix in completion of the warehouse simulation.

## Scope and decision

- Update WEB_APP_DEMO and the existing D:/Projects frontend deployment only. Preserve the unrelated dirty work and the deployment's different branding/configuration. No backend, PDA, or database changes.
- Next 14.2.15 has no sufficient 14.x patch for current advisories. Use Maintenance LTS 15.5.28, React/ReactDOM 19 and matching types, avoiding the unrelated Next 16 build-tool/browser migration.
- Patch PostCSS in Next's dependency tree as well as the build tooling. Keep Tailwind 3 and existing styles. Resolve related development-tool audit findings with the smallest compatible dependency changes.
- Fix the separately reproduced simulation startup Escape race: do not focus or interact with the iframe until its view is ready.

## Evidence before changes

- `npm audit --omit=dev`: 4 vulnerable packages (1 critical, 3 high).
- `npm audit`: 11 vulnerable packages (3 critical, 4 high, 4 moderate).
- Compatibility review found no async request APIs, Server Actions, dynamic params, middleware, or server fetch caching that need migration.

## Execution and acceptance

- [x] Update manifests and regenerate lockfiles separately for WEB and deployment.
- [x] Clean install, production/full audit, typecheck, unit tests, production build.
- [x] Browser simulation regression, including Escape during deferred iframe startup.
- [x] Rebuild frontend Docker only; confirm deployed dependency versions.
- [x] Test public authentication shell, normal login/API proxy, real 3D simulation, fullscreen/first-person/restoration and zero API activity while simulating.
- [x] Independent read-only reviews of dependency coupling, CSS compilation and branding boundary.
- Final handoff: commit only scoped changes, push WEB_APP_DEMO and verify the remote SHA. Preserve the pre-existing unstaged loc3d.js edits and scratch files.

## Results and compatibility adjustments

- Full and production dependency audits: zero findings in WEB and deployment lockfiles; runtime Docker audit also zero. Runtime versions: Next 15.5.28, React/ReactDOM 19.3.1, PostCSS 8.5.31, sharp 0.35.5.
- Vitest 4.1.12 replaces the affected Vitest 3/tinypool chain; Vite 7.3.7 addresses its development-server advisories. Literal conditional imports retain both Vitest and standalone Node test support (Vitest 4 cannot resolve the prior expression-based bare import).
- Scoped PostCSS and selector-parser overrides patch Next/Tailwind transitive dependencies without a Tailwind 4 migration. Independent actual stylesheet compilation produced 227 rules with zero warnings; browser smoke verifies computed styles.
- Unit tests: 19/19 passed (14 simulation, 5 branding); standalone Node simulation tests: 14/14; typecheck and WEB production build passed.
- Simulation browser: 14/14 checks including deterministic delayed-module Escape regression; deployed live 3D: 8/8, zero API traffic during simulation and zero runtime errors.
- Authentication shell smoke: WEB build 9/9, deployed Docker 8/8. Includes real login, anonymous API denial, forgot-screen navigation (no OTP sent), compiled styling, assets; WEB also checks English and onboarding guard.
- Real smoke found an existing WEB Login/onboarding crash on the deployment's empty `/api/branding` response. Added boundary defaults with three failing cases before the fix; valid DB branding remains unchanged and HTTP errors still reject. No DB values were altered.
- Frontend-only Docker rebuilt successfully. Backend and DB were not restarted, migrated or seeded. Deployment's existing application files/configuration differences were preserved; only package/lock/Docker install steps and the session race fix were updated there.

Sources: [Next security update](https://nextjs.org/blog/nextjs-security-update-october-14-2026), [Next 15 upgrade guide](https://nextjs.org/docs/app/guides/upgrading/version-15). Audit findings are registry evidence at the verification time, not a guarantee against all future vulnerabilities.
