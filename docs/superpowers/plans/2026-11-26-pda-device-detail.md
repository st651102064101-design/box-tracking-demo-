# PDA Device Detail Implementation Plan

**Goal:** Clicking a PDA tile shows who uses the handheld and its state; the connect QR works.

**Spec:** docs/superpowers/specs/2026-11-26-pda-device-detail-design.md

**Execution:** native, in this session (user: "อนุมัติ ลงมือเลย").

## Global constraints

- Heartbeat adds `employeeId`, `employeeName`; both optional; display only.
- Old apps keep working. Missing values show "—". No database storage.
- `localhost` QR is never generated; ask for the server IP and remember it in the browser.

## Review focus

- Employee signs out → the name disappears at the next report, not stale.
- Device name or employee name containing HTML → shown as text.
- Open detail window follows the 5-second refresh.
- No device ever seen → tile opens the QR as before.
- Typed IP with scheme, port or spaces → normalised; junk refused.

## Tasks

1. Server (`routes/devices.ts`, `tests/devices.test.ts`): keep and return `employeeId`, `employeeName`, `model`, `ipAddress`, `hasIntegratedRfid`, `usesZebraSdk`.
2. App (branch MOBILE_APP_DEMO: `api_client.dart`, `app_controller.dart`, `app_controller_test.dart`): send the signed-in employee; report on sign-in and sign-out.
3. Web (`public/pda-device.js` pure view logic + `tests/pda-device.test.js`, `legacy.html`): detail window, QR address handling.
4. Verify: backend, frontend, `flutter test`; browser; build 90 and install over the app on the TC52.
