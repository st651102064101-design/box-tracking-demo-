# PROGRESS.md — Agent Working Log

> อัปเดตทุกครั้งที่มีการแก้ไขไฟล์ หรือทุกครั้งที่ผู้ใช้ prompt ใหม่ เพื่อให้ Claude
> เซสชันอื่นเข้าใจสถานะปัจจุบันของงานได้ทันทีโดยไม่ต้องไล่อ่านบทสนทนาเดิม
> (Updated on every file edit and every new user prompt, so another Claude
> session can pick up context without re-reading the whole conversation.)
>
> **Repo layout note:** the root checkout at `/Users/kriangkrai/Projects/
> box-tracking-demo-` sits on a stale branch (`stash-check`, 16 commits
> *behind* `main`, with large uncommitted deletions of core PDA files) — do
> not build on it. Prefer a fresh worktree/checkout of `origin/main`, or one
> of the `.claude/worktrees/*` dirs that's actually tracking a live
> feature branch. Push access to `origin` works fine as of 2026-08-06 (see
> entry below) — the earlier "403, no write access" blocker in this file is
> resolved/was session-specific, not a standing repo issue.

## Current status

**Latest work (2026-08-06):** PDA Flutter app (`pda_flutter/`), branch
`claude/pda-rfid-binding-inventory-7e5fa4` (pushed to origin, not yet merged
to `main`):

1. **Cascading location dropdowns on box registration's putaway step.**
   Zone/Rack/Shelf/Slot were plain free-text fields; now sourced from the
   Location Master (`S.locations`, previously not even parsed by
   `StateSnapshot`) via cascading dropdowns + a rack-barcode scan shortcut,
   mirroring `frontend/public/legacy.html`'s `locPickerHtml()`/
   `rebuildLocCascade()`. New files: `pda_flutter/lib/models/location.dart`
   (`Location`, `LocationCascade`). Touched:
   `pda_flutter/lib/models/state_snapshot.dart`,
   `pda_flutter/lib/screens/box_register_screen.dart`.
2. **RFID locate screen (`/rfid`, "หากล่อง"):** removed the barcode/RFID
   input toggle on the pick step (barcode-only now — RFID stays reserved for
   the locate sweep itself). Proximity feedback switched from
   `HapticFeedback` to a real graduated beep — volume *and* pitch scale with
   signal strength via a new native `playLocateBeep(level)` method
   (`RfidReaderController.kt`, uses `ToneGenerator` constructed fresh
   per-call since its volume is fixed at construction). Low power mode now
   also disables the gauge's needle-sweep `TweenAnimationBuilder` and
   per-frame `Color.lerp` — previously low power mode touched polling
   interval/page transitions/shadows but not this screen's animation at
   all, which was its single biggest per-frame repaint cost.
3. **Root-caused and fixed a real bug:** "รับค่า RFID" (`rfid_input_screen.dart`)
   read at ~16 tags/sec instead of the ~171/sec every other screen gets,
   with visible stutter, immediately on opening the screen. Cause: it was
   the only screen enabling the reader's `ALL_TAG_FIELDS` "detail mode" (to
   show TID/PC/CRC/antenna/channel/phase/seen-count per tag) —
   `RfidReaderController.kt`'s own prior comments already documented the
   10x cost, *and* that TID specifically never actually arrives this way on
   this reader regardless (`tidCount` stays 0) — so detail mode bought
   nothing and cost everything. Removed entirely: no more per-screen
   fast/detail toggle, `setDetailMode` deleted end-to-end (Dart wrapper,
   MethodChannel case, Kotlin field/branch). Every screen, including this
   one, now always runs fast EPC+RSSI. The extra fields still render in the
   UI as "—" (honest — that's what they were showing before too, just slower).
4. Confirmed `main` already had this branch's prior state merged in
   (`0d46ad9`, "Merge claude/pda-rfid-binding-inventory-7e5fa4 into main")
   — the 4 items above are commits *after* that merge point, still only on
   the feature branch (`8acb272`, `7a151a9`). **Next session: merge
   `claude/pda-rfid-binding-inventory-7e5fa4` into `main` and push**, unless
   further work is planned on the branch first.
5. Built + installed release APK to the physical MC3390R (device id
   `20214523021458`, adb name "MC33") after each change to confirm compile
   correctness; did not do full manual on-device QA of the new dropdown UI
   or beep behavior — worth a real walkthrough next session.

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
| Webapp `legacy.html` Gate In/Out tabs (`scanOut`/`scanIn`), served under the Next.js frontend | `frontend/public/legacy.html` (`resolveTag`, new helper `tagForRfidCode`) | ✅ Resolved — see session log entries below; push-access blocker from that session no longer applies (confirmed by this session's successful pushes) |

## Blockers (historical — see note at top; not current)

- **This session has zero write access to this repo — confirmed, not just a
  large-file problem.** Plain `git push` fails with `403` on the initial
  `info/refs` request (confirmed repeatedly, including 4 retries with
  exponential backoff 2/4/8/16s — not transient). The GitHub content-API
  fallback (`mcp__github__create_or_update_file`) was then tried on a *tiny*
  new file (this very `PROGRESS.md`, a few KB) and failed too, with
  `403 Resource not accessible by integration` — a GitHub App permissions
  error, not a size limit. Both write paths use the same underlying
  credential/App installation for this repo, and that installation does not
  have write/contents permission on `st651102064101-design/box-tracking-demo-`.
  **This needs a human to grant write access** (re-authorize/update the
  GitHub App installation permissions for this repo, e.g. via the Claude
  Code GitHub connector/integration settings) — no retry or workaround from
  inside a session can fix it.
- Earlier in this session, `frontend/public/legacy.html` (~2MB / ~994,000
  tokens — it has a minified spreadsheet library inlined) was *also* found to
  exceed this tool's own 25,000-token read ceiling, so even with write access
  restored, that one specific file would still need `git push` (not the
  content-API) to update.
- **What was done instead:** delivered a git patch
  (`0001-fix-web-gate-rfid-resolve.patch`, ~2.3KB, just the real 18-line
  diff) directly to the user via file transfer. Needs `git am
  0001-fix-web-gate-rfid-resolve.patch` + `git push` from anywhere with real
  push credentials for this repo, on branch
  `claude/rfid-gate-box-not-found-5vs2kz`. This `PROGRESS.md` is being
  delivered the same way, since it can't be pushed either.
- The local commit also still exists in this session's workspace
  (`/home/user/box-tracking-demo-` and `/workspace/box-tracking-demo-`,
  commit `4e4d36e` / `6a5e107` respectively) if a future session gets granted
  push credentials and wants to push it directly instead of applying the
  patch.

## Next steps (whoever picks this up)

1. **Merge `claude/pda-rfid-binding-inventory-7e5fa4` into `main` and push.**
   It's currently 2 commits ahead of the last merge point (`8acb272`
   location dropdowns/gauge/beeps, `7a151a9` RFID detail-mode removal).
   Nothing on the branch conflicts with anything known to be in-flight
   elsewhere as of this writing.
2. Manually QA on the physical MC3390R (device stays connected as adb id
   `20214523021458` / name "MC33" when plugged in — reconnect if
   `flutter devices` doesn't show it):
   - Box registration putaway step: scan a real rack barcode, confirm the
     "กรอกเอง" dropdown path also cascades correctly against real
     Location Master data (needs at least one row in `S.locations` —
     check via the web app's setup/location-master screen if the dropdowns
     look empty).
   - `/rfid` locate screen: confirm the beep actually gets louder/higher
     pitched as a tag gets closer, and that low power mode visibly stops
     the gauge needle animation.
   - "รับค่า RFID" (`rfid_input_screen.dart`): confirm read rate now
     matches other screens (~171/sec class, not ~16/sec) and no more
     stutter on opening the screen.
3. Historical `legacy.html` Gate In/Out RFID-resolve fix (rows 1-11 in the
   session log below) — confirm it's actually still present in current
   `frontend/public/legacy.html` on `main`; that older session's blocker
   was push permissions, not code correctness, and this session confirmed
   push access works, but nobody has re-verified that fix specifically
   survived into the current `main`.

## Session log

| # | User prompt (summary) | Files touched | Outcome |
|---|---|---|---|
| 1 | รายงานว่ายิง RFID gate in/out บน Flutter app และ webapp `192.168.3.42:5100` แล้วขึ้น "ไม่พบกล่อง" ทั้งที่ผูก RFID กับ box id แล้ว | — (investigation) | พบว่า Flutter ฝั่ง `app_controller.dart` ถูกแก้ไปแล้วในคอมมิตก่อนหน้า (`1ec4602`, อยู่บน `main` แล้ว) — ครอบคลุมทั้ง mobile app และ web build ที่ port `5100` เพราะเป็นโค้ดเบสเดียวกัน |
| 2 | (ต่อเนื่อง) | `frontend/public/legacy.html` | พบบั๊กเดียวกันใน `resolveTag()` ของเว็บแอป (`scanOut`/`scanIn`) — แก้โดยเพิ่ม `tagForRfidCode()` helper ให้ค้นหากล่องจาก `rfidTid`/`rfidEpc` ด้วย ไม่ใช่แค่ barcode key. Commit ไว้ในเครื่อง (`4e4d36e` บน branch `claude/rfid-gate-box-not-found-5vs2kz`) แต่ push ขึ้น GitHub ไม่ได้ (403, ไม่มี credential) |
| 3 | ลองหาทาง push ผ่าน GitHub content-API แทน git push โดยตรง | — | ยืนยันว่าไฟล์ใหญ่เกินไป (993,651 tokens > 25,000 token limit ของ Read tool) — เป็นทางตัน ไม่ใช่แค่ช้า/เสี่ยง จึงส่ง patch file (`0001-fix-web-gate-rfid-resolve.patch`) ให้ผู้ใช้แทน |
| 4 | Stop-hook แจ้งว่ามี unpushed commit ค้างอยู่ | — | ลอง `git push` ซ้ำอีกครั้ง + retry 4 ครั้งแบบ exponential backoff (2/4/8/16s) — ยัง 403 เหมือนเดิมทุกครั้ง ยืนยันว่าเป็นปัญหา credential ของ session ไม่ใช่ network ชั่วคราว |
| 5 | ขอให้สร้างไฟล์ `.md` นี้ (`PROGRESS.md`) ไว้ที่ branch `main` อัปเดตทุกครั้งที่แก้ไฟล์/ทุกครั้งที่ prompt เพื่อให้ Claude เซสชันอื่นตามงานทัน | `PROGRESS.md` (ใหม่) | ลอง push ตรงไปที่ `main` ผ่าน GitHub content-API — ได้ `403 Resource not accessible by integration` แม้ไฟล์จะเล็กมาก ยืนยันว่า session นี้ไม่มีสิทธิ์เขียนขึ้น repo นี้เลย (ไม่ใช่แค่ปัญหาไฟล์ใหญ่อย่างที่เข้าใจก่อนหน้านี้) — ส่งไฟล์นี้ให้ผู้ใช้โดยตรงแทน |
| 6 | Stop-hook แจ้งเตือนเรื่อง unpushed commit ซ้ำอีกครั้ง | — | ลอง `git push` อีกครั้ง — ยัง `403` เหมือนเดิม (ปัญหาเดียวกับที่วินิจฉัยไปแล้วใน #5: session ไม่มีสิทธิ์เขียน ไม่ใช่ปัญหาชั่วคราว) ไม่ได้ลอง retry ซ้ำหลายรอบอีกเพราะทราบสาเหตุแน่ชัดแล้วและ retry ซ้ำจะได้ผลเหมือนเดิมทุกครั้ง |
| 7 | ผู้ใช้ขอสรุปว่าทำเสร็จหรือยัง/push main แล้วหรือยัง | — | สรุปสถานะให้: Flutter fix อยู่บน main แล้ว, legacy.html fix เสร็จแต่ยัง push ไม่ได้ (สิทธิ์เขียนไม่มี) — เสนอ 2 ทาง (apply patch เอง / ให้สิทธิ์ write) |
| 8 | Stop-hook แจ้งเตือนซ้ำอีกครั้ง (รอบที่ 3) | — | ลอง `git push` อีกครั้ง — ยัง `403` เหมือนเดิมทุกครั้ง ไม่มีอะไรเปลี่ยนแปลงฝั่งสิทธิ์การเข้าถึง |
| 9 | ผู้ใช้ส่งภาพหน้าจอ GitHub `main` — เห็นคนอื่น (`kriangkrai`) push ตรงเข้า `main` ได้เมื่อ 19 นาทีก่อน (commit "aa") ถามว่าทำไมยังไม่เห็นการแก้ไข | — | เช็ค `origin/main` ใหม่: มี commit `549bf21 "aa"` เพิ่มมา (แก้ `docs/reference/rfid-gate_v17-3d.html`, `RfidReaderController.kt` — ไม่ชนกับไฟล์ที่ patch ของเราแก้) ลอง `git push` อีกครั้ง — ยัง `403` เหมือนเดิม สรุปให้ผู้ใช้ว่ามีอีก account/เครื่องที่มีสิทธิ์ push จริง (ไม่ใช่ session นี้) แนะนำให้เอา patch ไป apply+push จากเครื่องนั้นแทน เป็นทางที่เร็วที่สุด |
| 10 | Stop-hook แจ้งเตือนซ้ำอีกครั้ง (รอบที่ 4) | — | ลอง `git push` อีกครั้ง — ยัง `403` เหมือนเดิม ไม่มีอะไรเปลี่ยน |
| 11 | ผู้ใช้ขอไฟล์ไปเพื่อ push เอง | `frontend/public/legacy.html` (ส่งไฟล์ฉบับเต็มที่แก้แล้ว, ไม่ใช่แค่ patch) | ส่งไฟล์ `legacy.html` ฉบับเต็ม (แก้แล้ว) ให้ผู้ใช้โดยตรงผ่าน file transfer (ไม่ผ่าน context ของโมเดล เลยไม่ติดข้อจำกัด token เหมือนตอนลองผ่าน GitHub API) พร้อม patch ไฟล์เดิม ให้เลือกใช้แบบไหนก็ได้ |
| — | *(new session, different branch/worktree: `claude/pda-rfid-binding-inventory-7e5fa4`, push access confirmed working throughout — no 403s this session)* | | |
| 12 | "ทำการ rebuild pda flutter ใน mc3390r" | — (build only) | `flutter clean` + `pub get` + `flutter build apk --release` + `flutter install -d 20214523021458 --release`. Confirmed working install flow for this device going forward. |
| 13 | หน้าลงทะเบียนกล่อง: ทำ Zone/Rack/Shelf/Slot ให้เป็น dropdown จาก DB + ยิงบาร์โค้ดได้ เหมือนเว็บ; merge branch นี้เข้า `main`; โหมดประหยัดพลังงานใช้งานไม่ได้จริง ต้องลดกราฟิกเทียบเท่า/มากกว่า Zebra 123RFID Mobile; หน้า `/rfid` เอา toggle RFID ออกเหลือบาร์โค้ดอย่างเดียว + เสียงบี๊บควรดัง/เบาตามระดับกราฟสัญญาณ | `pda_flutter/lib/models/location.dart` (new), `state_snapshot.dart`, `box_register_screen.dart`, `rfid_locate_screen.dart`, `rfid_service.dart`, `RfidReaderController.kt` | Researched via Explore subagent first (mapped current implementation for all 4 asks), then confirmed 2 design choices with the user via AskUserQuestion (cascading dropdowns yes; merge = local + push). Found merge-to-main was already done in a prior session (`main`/`origin/main` both already at `0d46ad9`, the merge commit) — nothing to do there. Implemented cascading location dropdowns + rack-barcode scan shortcut; removed the RFID toggle on `/rfid`'s pick step; replaced haptic proximity feedback with a real graduated native beep (new `playLocateBeep` Kotlin method); wired low power mode into the locate gauge's animation (previously untouched by it). Verified via `flutter analyze` + `flutter build apk --release` + on-device install after every change. Committed (`8acb272`) and pushed — no push issues. |
| 14 | "ทำต่อ ผมเสียงสายแล้ว" (device reconnected) | — (install only) | `flutter devices` confirmed MC33 back online; installed the already-built release APK. |
| 15 | ทำไฟล์ `.md` ไว้ที่ branch `main` สำหรับ handoff ระหว่าง Claude account/brand อื่น; แก้ปัญหาหน้า "รับค่า RFID" ยิงช้า/ติดขัดทันทีที่เข้าหน้า (ต่างจากหน้า "รับเข้า" ที่ยิงรัวปกติ) — ขอให้หาสาเหตุแล้วตัดออกทันที | `rfid_input_screen.dart`, `rfid_service.dart`, `RfidReaderController.kt`, `PROGRESS.md` (this file) | Root cause found directly by reading the two screens + the native controller: `rfid_input_screen.dart` was the only screen enabling the reader's `ALL_TAG_FIELDS` "detail mode" (`rfid.setDetailMode(true)` in its own `initState`) to show TID/PC/CRC/antenna/channel/phase/seen-count — and `RfidReaderController.kt` already had its own doc comment measuring that mode at ~171/sec → ~16/sec (10x slower) on this hardware, for a TID field that never actually arrives that way regardless (`tidCount` confirmed 0). Confirmed the fix approach with the user via AskUserQuestion (cut detail mode entirely vs. keep as opt-in) — chose full removal. Deleted `setDetailMode` end-to-end: Dart service wrapper, Kotlin `MethodChannel` case, `detailMode` field, and the branch in `eventReadNotify`/`applyReadProfile` that switched on it. Verified via `flutter analyze` + `flutter build apk --release` + on-device install. Committed (`7a151a9`) and pushed. Then wrote/updated this `PROGRESS.md` on a clean `origin/main` worktree (root checkout was on a stale unrelated branch `stash-check`; a `main`-tracked worktree `great-mendeleev-57773d` existed but had unrelated massive uncommitted deletions, so used a fresh detached worktree from `origin/main` instead to avoid touching either). |
