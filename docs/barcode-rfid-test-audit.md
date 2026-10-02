# Barcode / RFID regression audit — 2026-10-01

## Data paths inspected

| Layer | Actual path and important files |
| --- | --- |
| Native / Flutter bridge | `pda_flutter/android` RFID reader controller publishes string EPC/TID metadata; `lib/services/rfid_service.dart` receives `smarttrace/rfid/events`, buffers reads by frame and invokes `smarttrace/rfid` methods. |
| Routing | `lib/controllers/app_controller.dart`: subscriptions → `_effectiveInputMode` / trigger and barcode routing → scan queue or tracking/transfer/count results → API. |
| UI | `lib/widgets/scan_capture.dart`, `lib/services/scan_payload.dart`, ScanModeToggle and scan/track/transfer/cycle-count/locate/input/registration screens. Cycle-count has its own scanner callback, so controller filtering alone is insufficient. |
| Lookup | `lib/models/state_snapshot.dart` lookup prefers canonical barcode, then current RFID and legacy EPC/TID. |
| Backend | `src/services/rfid.ts`, `routes/rfid.ts`, `services/gate.ts`, `routes/gate.ts`, validators and `services/state.ts`: resolve, binding transactions/audit, gate validation/history, authoritative binding preservation on state sync. |
| Legacy web | `frontend/public/legacy.html`: actual `tagForRfidCode` and `resolveTag` functions, barcode-first resolution and current/legacy RFID lookup. |

No AGENTS.md was found. Read `pda_flutter/CLAUDE.md`. Existing controller, handheld matrix, scan capture/payload, RFID screen logic, gate-form trigger, scan-only screen, backend RFID/gate/state tests were inspected before adding coverage. Existing tests were not removed or weakened.

## Proven regressions fixed

1. Antenna batches could update controller results after selecting Barcode. Guard batch entry with both hardware capability and effective RFID mode.
2. Cycle-count keyboard/scanner capture remained enabled in RFID mode. Disable that separate capture path unless Barcode is selected.
3. Stopped inventory retained frame-buffered reads; switching away and back could deliver previous reads. Clear pending reads immediately when stopping.
4. Malformed SDK events could throw during frame decoding and poison valid reads. Enforce the native string-EPC contract and isolate malformed metadata records. Raw byte arrays are rejected, not guessed as identifiers.
5. Backend resolution of a barcode colliding with another box's RFID depended on DB row order. Prefer exact canonical barcode, consistent with Flutter/web.
6. Legacy web ignored the current `rfid` binding column, checking only legacy EPC/TID. Include all three binding columns.

## Added tests (20)

| Test file | Cases |
| --- | --- |
| `pda_flutter/test/scan_mode_isolation_test.dart` | 6: late RFID in Barcode tracking/transfer/count; Barcode intent in RFID cannot invoke target, queue or API; repeated RFID callback queues once; switch and late read with AIM prefix/terminator normalization; subscription disposal. |
| `pda_flutter/test/rfid_channel_contract_test.dart` | 6: real channel envelopes and metadata; duplicate/multi-tag batch; empty/byte-array/invalid metadata isolation; stop clears buffered reads; disconnect/reconnect status; connection exception; disposal before frame flush. Some scenarios share a test. |
| `pda_flutter/test/cycle_count_mode_test.dart` | 1 widget regression: RFID-selected barcode entry makes zero cycle-count scan API calls, Barcode-selected entry makes one. |
| `backend/tests/scan-resolution-contract.test.ts` | 5 isolated DB integrations: collision precedence; current/legacy aliases, dedup/empty/unknown; explicit case/whitespace contract; repeated gate-in/out creates one history entry each; replacing cannot steal another box's legacy binding. |
| `backend/tests/legacy-scan-contract.test.ts` | 2: executes actual legacy function source in VM (not a rewritten resolver): current/legacy case-insensitive lookup; canonical barcode collision precedence, Code39 wrapping, empty/unknown. |

The requested “RFID selected but Barcode still operates” case is covered by both `scan_mode_isolation_test.dart` (native barcode intent callback and queue/API side effects) and `cycle_count_mode_test.dart` (independent UI scanner capture/API side effect).

Existing RFID tests additionally cover bind/replace/detach/conflicts/audit and stale full-state sync, including preserving detached null bindings. Existing handheld tests cover barcode-only devices and trigger routing.

## Commands and results

Run from `pda_flutter`: `C:\src\flutter\bin\flutter.bat test --no-pub` — 218 passed.

Run from `backend`: `node node_modules/vitest/vitest.mjs run --maxWorkers=2 --minWorkers=1` — 17 files, 572 passed. Integration tests use isolated in-memory PGlite, not the running database.

Targeted runs before full suites: Flutter existing related tests 46 passed; new Flutter tests 13 passed. Backend RFID/gate baseline 43 passed; four related files after changes 50 passed. Regression failures were observed before fixes for cross-mode events, collision resolution and legacy current-binding lookup.

Windows optional Rollup/esbuild binaries were restored in ignored node_modules to execute backend tests; no dependency manifest/lock changes were made for this.

## Remaining risks / ambiguous behavior (not a claim of zero bugs)

- Backend lookup currently uses exact case and whitespace; clients normalize differently. Tests document this discrepancy rather than silently changing identifier semantics.
- Controller batch routing passes EPC to `_onReaderTag`, not TID as a fallback. A box bound only to a different TID may therefore require another screen/path; blanket TID fallback precedence needs an explicit contract.
- `doCommit` has no entry busy guard. Sequential replay is tested; simultaneous HTTP submissions from multiple callers/devices are not proven idempotent by these tests. Gate validation/transaction races require concurrency-specific investigation.
- Method-channel exceptions are tested, but a native method that never returns is not protected by a demonstrated Dart timeout. Start/stop methods swallow exceptions; actual scanner availability/error feedback needs hardware verification.
- Byte arrays are not the Dart bridge's supported EPC contract; actual conversion inside the proprietary SDK/native layer is not simulated here.
- Full legacy DOM/lifecycle and physical scanner/antenna arbitration are not end-to-end browser/device-tested. VM tests cover real resolver code only.
- These tests do not prove permission prompts, radio firmware, RF range, transport stalls, Android ANR, laser suppression, or hardware reconnect behavior. No APK installation or live backend deployment was performed for this audit.

## Manual Zebra acceptance

1. On TC501 and MC3390R select RFID in each scan/track/transfer/count screen. Pull hardware trigger near two bound tags, release, repeat. Verify matching boxes, one queue entry per box, and no barcode laser/data submission.
2. Select Barcode. Read a normal barcode with Enter terminator repeatedly; verify expected route and no RFID antenna result. Repeat ten rapid mode switches with the trigger pressed/released; old reads must not appear in the new mode.
3. Navigate away/back and background/resume during inventory; listeners must not multiply. Disconnect/reconnect reader and test SDK initialization failure and denied permissions; UI must recover or report error without hanging.
4. On TC52 and ordinary Android verify RFID is unavailable and Barcode remains usable; verify actual hardware capabilities, not model name alone.
5. Bind, replace and detach a tag, refresh on a second client, then sync a stale client snapshot. Verify backend bindings and audit log remain authoritative. Try a tag already owned by another box.
6. Gate-in/out repeated reads and repeated submit: verify exactly one movement/history entry; separately exercise concurrent devices because sequential regression tests do not establish distributed idempotency.

## Follow-up hardening

- Reproduced two concurrent `doCommit` invocations producing two Gate API calls. Added an entry busy guard and a regression asserting exactly one call, queue reset and busy cleanup.
- Reproduced an in-flight connection error arriving after service disposal throwing `Cannot add new events after calling close`. Added disposal guards for connect/listen/error callbacks and idempotent disposal. Method-channel regression now passes.
- Added concurrent gate-in/out HTTP integration coverage: one success and one conflict, with two total history movements. Passes on in-memory PGlite; this is not proof of cross-process PostgreSQL transaction behavior.
- Follow-up full runs: Flutter **220 passed**, Backend **573 passed**. New tests across both rounds: **23**.
- Native Kotlin tests attempted with `gradlew.bat testLegacyDebugUnitTest --no-daemon`, IPv4 override, empty JVM arguments/stacktrace and Windows selector override. All fail before tests start: JDK 17 PipeImpl/UnixDomainSockets `Invalid argument: connect` / `Unable to establish loopback connection`. No native test success is claimed. No machine-wide network/security settings were changed.
- Native connect returns its method-channel response immediately and runs reader connection on an executor. A Dart method-call timeout alone would not detect a stalled physical connection; native status watchdog/cancellation needs a separately verified design.
- ADB currently detects one MC33 device (`20214523021458`), not TC501 or TC52. All-model physical acceptance remains outstanding.

Self-recheck: production edits are limited to proven submit/disposal defects; existing tests retained; full suites passed; unresolved TID/case semantics, native build environment and hardware acceptance remain explicitly open. No claim of 100% bug freedom or APK deployment.

## Shared trigger routing — 2026-10-02

The controller previously responded to RFID SDK trigger callbacks in Barcode mode with a toast and no barcode command. A shared trigger now routes to `setBarcodeTrigger` in Barcode mode; RFID mode still routes only to inventory. Release and navigation stop the software barcode trigger. Native rejects a late barcode press once `rfidTriggerMode` is true. Barcode output continues through the existing app-owned DataWedge profile and barcode intent path; this is not an EMDK-only implementation.

Added controller and actual mock-method-channel press/release tests. Updated the existing matrix assertion from the obsolete blocked-trigger toast to positive barcode start/release assertions while retaining the no-inventory assertion. Targeted controller/matrix/gate-form tests: 37 passed. Full Flutter suite: 222 passed. Self-recheck found no additional issue in the edited routing; native/hardware timing is still unverified.

Attempted `flutter build apk --release --flavor legacy --no-pub`; fails before compilation with the existing Java loopback error. This change is not installed on the device, and physical trigger behavior is not yet claimed as verified.
