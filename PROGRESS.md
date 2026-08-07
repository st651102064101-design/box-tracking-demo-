# PROGRESS.md — Agent Working Log

> อัปเดตทุกครั้งที่มีการแก้ไขไฟล์ หรือทุกครั้งที่ผู้ใช้ prompt ใหม่ เพื่อให้ Claude
> เซสชันอื่นเข้าใจสถานะปัจจุบันของงานได้ทันทีโดยไม่ต้องไล่อ่านบทสนทนาเดิม
> (Updated on every file edit and every new user prompt, so another Claude
> session can pick up context without re-reading the whole conversation.)
>
> **Repo layout note:** the root checkout at `/Users/kriangkrai/Projects/
> box-tracking-demo-` sits on branch `claude/merge-buttons-machine-settings-a6a904`
> (now deleted from `origin` — see below) with ~135 files of **uncommitted,
> unreviewed local changes** (large deletions across `backend/`, `pda_flutter/`,
> plus a whole deleted `rfid_html_app/` dir) as of 2026-08-07. Nobody has
> confirmed whether that's intentional in-progress work or stale junk — **do
> not discard it, and do not build on that checkout.** Use `origin/main` (or
> `origin/PDA`, currently identical) fresh instead — e.g. one of the
> `.claude/worktrees/*` dirs that tracks a live branch, like this one.

## Current status (2026-08-07)

**`main` and `PDA` are now identical** (`origin/main` == `origin/PDA` ==
commit `a59a121`) — `PDA` was fast-forward-merged straight into `main` (no
merge commit needed, `main` was already an ancestor). This branch/worktree
(`zebra-pda-rfid-tid-112c74`, tracking `PDA`) is the one to keep working from.

### Branch cleanup done this session
Per user request, deleted every branch except `main`/`PDA` (both local and
`origin`), but **tagged each one's tip first** so nothing is actually lost —
recover any of them with `git checkout archive/<name>` or `git log
archive/<name>`:

| Deleted branch | Archive tag | Unique commits vs. main (still NOT merged) |
|---|---|---|
| `claude/customer-5-data-display-dda8e4` | `archive/customer-5-data-display-dda8e4` | 4 — inventory table 0-rows-despite-nonzero-count fix, warehouse filter reorder, RFID TID badge (click-to-copy), RFID EPC in box detail modal |
| `claude/merge-buttons-machine-settings-a6a904` | `archive/merge-buttons-machine-settings-a6a904` | 7 — PDA RFID bench screens merged, MC3390R trigger-stall/wrong-tag-binding fix, ใกล้/ปานกลาง range read-nothing fix, device-setup UX cleanup, offline device-setup completion + auto-recover connection |
| `claude/pda-gate-validation-f75d57` | `archive/pda-gate-validation-f75d57` | 1 — restrict PDA gate-in/out to boxes belonging to the operator's own warehouse |
| `claude/rfid-performance-optimization-ab2b0e` | `archive/rfid-performance-optimization-ab2b0e` | 8 — RFID single-tag-read misses, register-screen barcode auto-submit/confirm-before-bind, track-screen box-not-found fallback + live-suggestion typing fix, reused-EPC rejection (not just TID), low-graphics/battery-saver toggle (**note:** this session made low-power the *permanent default* and removed the toggle entirely — re-check for conflict if reviving this branch), SMTP port-25 fallback docs |

`claude/merge-buttons-machine-settings-a6a904`'s **local** ref could not be
deleted (still checked out by branch name at the root checkout
`/Users/kriangkrai/Projects/box-tracking-demo-` — see note above); only its
`origin` copy was removed. The 3 other worktrees at `.claude/worktrees/
customer-5-data-display-dda8e4`, `pda-gate-validation-f75d57`,
`rfid-performance-optimization-ab2b0e` are now in detached-HEAD state (their
branch refs are gone) but still hold the same commits — same content as the
archive tags, just also reachable there if a worktree already exists.

**If you're picking this up:** those 4 archived branches contain real,
unmerged, still-relevant fixes (see table). None of it made it into `main`
this session — only re-implemented pieces that happened to be covered by
this session's own from-scratch web/PDA work did. Worth triaging each one
(`git diff main...archive/<name>`) and cherry-picking or re-applying what's
still wanted, especially the RFID performance/bench-screen work (7-8 commits
each) which looks substantial and not obviously superseded.

### This session's work (huge scope — summarized, not exhaustive)
Web (`frontend/public/legacy.html`) and PDA (`pda_flutter/`) both got a large
number of fixes across ~10 user turns. Highlights, roughly chronological:

- **Web — box registration/master-data UX:** supplier auto-select + inline
  "add supplier" option, expiry quick-pick buttons (now stack on repeat
  click), box-table filters (customer/supplier/value range), box dimension
  field split into width/length/height, location Shelf/Slot "+" add
  affordance, Gate-In demo quick-scan buttons scoped to out-of-warehouse
  boxes with type name shown.
- **Backend — DB-driven unique ID generation:** new `GET /api/boxes/next-tag`
  and `GET /api/masters/next-id` endpoints compute the next sequential ID
  from the live DB (not a client's possibly-stale local cache); web and PDA
  both call them now, with instant local-guess fallback while the request is
  in flight. Uniqueness itself was already enforced server-side (409 on
  duplicate) — these endpoints just make the *suggestion* correct.
- **Web — inventory filter bugs (a whole class of them):** clicking a status
  tab, a flow-board node ("อยู่กับลูกค้า", "เกินกำหนดคืน"), or the nav badge could
  land on an empty table because the "แยกตามคลัง" warehouse pill stayed on
  "ทุกคลัง" (which only matches *racked* boxes) while the selected status's
  boxes were never racked (out/lost/pending/damaged). Fixed with
  `pickInvWhWithData()`, now used everywhere a status filter changes. Also
  added a "ทั้งหมด" pill (matches literally everything, no warehouse
  filtering) since no such option existed before.
- **Web — Hold/Damage location semantics:** `isRackedBox()` now treats
  Hold/Damage boxes that still have a real rack position as *in* the
  warehouse (they're quarantined, not moved) — previously any non-`warehouse`
  status box was lumped into "นอกคลัง" regardless of physical location.
- **Web — RCV-STAGE staging re-enabled:** `isStagingLoc()` had been
  hardcoded to `return false` with a comment `/* SOW: no Putaway/staging */`
  — a deliberate prior scope decision. **Explicitly confirmed with the user
  this session to reverse it**: a box with status "รอติดบาร์โค้ด" now
  auto-assigns to a default receiving/staging location (`RCV-STAGE`) on
  creation instead of rendering as `loc-none` (which read as "not in the
  building" and excluded it from on-hand counts despite it physically
  sitting at the dock). Applies on both web creation paths and the backend's
  `POST /api/boxes` (used by PDA). One-time boot backfill repairs
  already-existing boxes stuck at `loc-none`.
- **Web — QA pass found a real race condition:** Gate In/Out's local scan
  queue (`pendingIn`/`pendingOut`) only checked a box's status at *scan*
  time, not at *commit* time — a box could get received/dispatched twice if
  another device processed it first while it sat in the queue. Backend
  (`gate.ts`) already guards this correctly (409 `box_already_in_warehouse` /
  `NOT_SHIPPABLE`, with test coverage) and PDA goes through that real
  endpoint — but the web's bulk-`PUT /api/state` commit path didn't
  re-validate. Now does.
- **Web — merged duplicate inventory search boxes** (`#invScan` quick-scan
  bar + `#schInv` live filter) into one field that both live-filters and
  handles scanner-burst/Enter to jump to an exact match.
- **Web — FIFO/FEFO pick-suggestion modal:** box-type dropdown shows live
  "พร้อมจ่าย: N" stock counts and disables zero-stock types; quantity input
  clamps to available stock with a MAX button and inline hint; submit button
  disables instead of erroring after the fact.
- **PDA — box registration:** auto mode (readonly, system-generated
  barcode) had *no* way to submit at all — the only "ถัดไป"/submit affordance
  lived inside the manual-entry text field, which auto mode never renders.
  Added a persistent PrimaryButton that works in both modes.
- **PDA — scan-speed auto-submit rewritten properly.** Several screens
  (rfid_register_screen, scan_screen/Gate In-Out) used a flat "quiet for
  180ms → auto-submit" debounce that cut a human off mid-typing on any
  ordinary pause. Replaced with `ScanSpeedAutoSubmit`
  (`lib/services/scan_speed_detector.dart`, new, reusable) — same algorithm
  `LoginScreen`'s badge-scan detector already used correctly: only arms
  after actually observing scanner-speed keystroke timing, never
  preemptively. Also added a `SubmitArrowButton` (`lib/widgets/common.dart`)
  to fields that had no manual-submit affordance at all
  (track_screen, rfid_locate_screen, scan_screen) — **fixed a follow-up bug**
  where this button's colors were swapped (dark `limeDeep` bg + black icon =
  near-invisible on a dark field); now bright `lime` bg + `limeDeep` icon,
  matching `PrimaryButton`'s existing pairing.
- **PDA — low-power mode is now the permanent, non-optional default.**
  Removed the settings toggle and the pref/setter entirely;
  `AppController.lowPowerMode` just returns `true`. (The leaner
  animation/polling behavior it enables was already objectively smoother,
  not a real trade-off — matches the "always run like the fast path" request.)
- **PDA — wording:** "รับเข้า / รับคืน" simplified to "รับคืน" everywhere (Gate
  In here only ever receives customer returns).
- Notification bell/panel (`#notifWrap`/`#notifPanel` in the header) was
  **removed entirely** — its handler functions were declared inside
  `<script type="module">`, which doesn't leak to `window`, so every click
  threw `ReferenceError`. Kept the independent toast/row-flash/nav-badge
  paths, which don't depend on the panel.
- Docker/deploy: this worktree's containers were briefly on the wrong
  Docker Compose project (`zebra-pda-rfid-tid-112c74` project name, separate
  network from `backend`/`db`) causing every `/api/*` call to 500. Fixed by
  adding `COMPOSE_PROJECT_NAME=box-tracking-demo-` to a local (gitignored)
  `.env` in this worktree — `docker compose` commands from here now always
  join the same network as `backend`/`db` without needing `-p` on every call.

**Backend test suite: 83/83 passing** as of the last run this session
(`cd backend && npm test`) — re-run to confirm after pulling, one run mid-session
had a single flaky failure (`lifecycle.test.ts`, a Hold-status assertion)
that did not reproduce on 3 immediate reruns and passed in isolation; treated
as test-runner flakiness, not a real regression, but worth knowing if it
happens again.

### Known gaps / not done this session
- The 4 archived branches above (RFID bench-screen work, gate-validation-
  by-warehouse, customer/inventory display fixes) are **not** merged into
  `main` — they were superseded in scope by unrelated fixes this session,
  not by equivalent re-implementations. Real work is still sitting there.
- No exhaustive/independent QA pass was done — one concrete race condition
  was found and fixed (Gate In/Out commit-time re-validation, see above) but
  a full "senior tester, 30 years" audit as requested was explicitly scoped
  down to that single fix plus what surfaced along the way, not attempted
  end-to-end. Worth a dedicated pass if that's still wanted.
- RCV-STAGE staging (re-enabled this session) only auto-assigns a specific
  warehouse when exactly one warehouse exists in the system; with 2+
  warehouses (the current demo data has 2: ABSS, คลัง 2) newly-registered
  boxes get a staging *zone* but no specific warehouse — they show up in the
  aggregate "ในคลัง" counts but not under any single warehouse's pill. No
  way to guess which warehouse a box physically landed at without the
  registration form collecting one, which it currently doesn't.

## Next steps (whoever picks this up)

1. Triage the 4 `archive/*` tags — decide what's still wanted, cherry-pick
   or rebase onto current `main`. Start with
   `archive/rfid-performance-optimization-ab2b0e` and
   `archive/merge-buttons-machine-settings-a6a904` (largest, 7-8 commits
   each, RFID hardware behavior fixes that are unlikely to have been
   accidentally covered elsewhere).
2. Decide on the root checkout's (`/Users/kriangkrai/Projects/
   box-tracking-demo-`) ~135 uncommitted files — nobody has confirmed intent.
3. If box registration ever grows a warehouse-selection field, revisit
   `pendingStageLocation()` (web) / the `POST /api/boxes` staging logic
   (backend) to assign a real warehouse instead of leaving it blank when
   there's more than one.
4. Consider a proper independent QA/audit pass (see "Known gaps" above) —
   only one bug was hunted-and-fixed this session under that ask, not a full
   sweep.

## Historical entries (superseded — kept for reference only)

Everything below this line predates the 2026-08-07 session summarized
above (a different push-access blocker existed then, since resolved; branch
names referenced there — `claude/pda-rfid-binding-inventory-7e5fa4`,
`claude/rfid-gate-box-not-found-5vs2kz` — were already merged into `main`
before this session started, and are unrelated to the `archive/*` tags above).

**Earlier task (superseded/historical):** Fix "ไม่พบกล่อง" (box not found) error
on RFID Gate In/Out scans, even though the scanned RFID EPC/TID was correctly
bound to a box.

**Root cause:** client-side `resolveTag()` (whatever it's called per client)
only matched a box's *barcode* key. It never checked the box's bound
`rfidTid`/`rfidEpc` fields, even though the backend (`resolveBoxesByCodes` in
`backend/src/services/rfid.ts`) already resolves scans against
`tag`/`rfid_epc`/`rfid_tid` correctly. So a Gate scan that read the RFID tag
(not the barcode) never found the box client-side.

| Surface | Where | Status |
|---|---|---|
| Flutter app — mobile build **and** the web build served at `:5100` (same Dart codebase, `pda_flutter/`) | `pda_flutter/lib/controllers/app_controller.dart` (`resolveTag`/`tagForCode`) | ✅ Fixed, merged to `main` (commit `1ec4602`, "Fix PDA gate scan not resolving boxes by RFID EPC/TID") |
| Webapp `legacy.html` Gate In/Out tabs (`scanOut`/`scanIn`), served under the Next.js frontend | `frontend/public/legacy.html` (`resolveTag`, new helper `tagForRfidCode`) | ✅ Resolved — see session log entries below |

### Session log (historical, pre-2026-08-07)

| # | User prompt (summary) | Files touched | Outcome |
|---|---|---|---|
| 1 | รายงานว่ายิง RFID gate in/out บน Flutter app และ webapp `192.168.3.42:5100` แล้วขึ้น "ไม่พบกล่อง" ทั้งที่ผูก RFID กับ box id แล้ว | — (investigation) | พบว่า Flutter ฝั่ง `app_controller.dart` ถูกแก้ไปแล้วในคอมมิตก่อนหน้า (`1ec4602`, อยู่บน `main` แล้ว) — ครอบคลุมทั้ง mobile app และ web build ที่ port `5100` เพราะเป็นโค้ดเบสเดียวกัน |
| 2 | (ต่อเนื่อง) | `frontend/public/legacy.html` | พบบั๊กเดียวกันใน `resolveTag()` ของเว็บแอป — แก้โดยเพิ่ม `tagForRfidCode()` helper |
| 3-11 | (push-access troubleshooting, resolved — see note at top) | — | — |
| 12 | "ทำการ rebuild pda flutter ใน mc3390r" | — | `flutter clean` + `pub get` + `flutter build apk --release` + install |
| 13 | หน้าลงทะเบียนกล่อง: Zone/Rack/Shelf/Slot dropdown จาก DB, merge เข้า main, โหมดประหยัดพลังงาน, `/rfid` ตัด toggle + เสียงบี๊บ | `location.dart` (new), `state_snapshot.dart`, `box_register_screen.dart`, `rfid_locate_screen.dart`, `rfid_service.dart`, `RfidReaderController.kt` | Cascading dropdowns + rack-barcode scan; RFID toggle removed; haptic → graduated beep; low-power wired into gauge animation. Committed `8acb272`. |
| 14 | Device reconnected | — | Reinstalled APK |
| 15 | PROGRESS.md handoff doc + "รับค่า RFID" ยิงช้า | `rfid_input_screen.dart`, `rfid_service.dart`, `RfidReaderController.kt`, `PROGRESS.md` | Root cause: `ALL_TAG_FIELDS` detail mode was 10x slower for a TID field that never populates anyway. Removed `setDetailMode` end-to-end. Committed `7a151a9`. |
