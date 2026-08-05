# PROGRESS.md — Agent Working Log

> อัปเดตทุกครั้งที่มีการแก้ไขไฟล์ หรือทุกครั้งที่ผู้ใช้ prompt ใหม่ เพื่อให้ Claude
> เซสชันอื่นเข้าใจสถานะปัจจุบันของงานได้ทันทีโดยไม่ต้องไล่อ่านบทสนทนาเดิม
> (Updated on every file edit and every new user prompt, so another Claude
> session can pick up context without re-reading the whole conversation.)

## Current status

**Task:** Fix "ไม่พบกล่อง" (box not found) error on RFID Gate In/Out scans, even
though the scanned RFID EPC/TID is correctly bound to a box.

**Root cause:** client-side `resolveTag()` (whatever it's called per client)
only matched a box's *barcode* key. It never checked the box's bound
`rfidTid`/`rfidEpc` fields, even though the backend (`resolveBoxesByCodes` in
`backend/src/services/rfid.ts`) already resolves scans against
`tag`/`rfid_epc`/`rfid_tid` correctly. So a Gate scan that read the RFID tag
(not the barcode) never found the box client-side.

| Surface | Where | Status |
|---|---|---|
| Flutter app — mobile build **and** the web build served at `:5100` (same Dart codebase, `pda_flutter/`) | `pda_flutter/lib/controllers/app_controller.dart` (`resolveTag`/`tagForCode`) | ✅ Fixed, merged to `main` (commit `1ec4602`, "Fix PDA gate scan not resolving boxes by RFID EPC/TID") |
| Webapp `legacy.html` Gate In/Out tabs (`scanOut`/`scanIn`), served under the Next.js frontend | `frontend/public/legacy.html` (`resolveTag`, new helper `tagForRfidCode`) | ⚠️ Fixed locally, **NOT pushed to GitHub yet** — see Blockers |

## Blockers

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

1. Get the `legacy.html` fix onto GitHub — either apply the patch file above
   and push, or fix this session's/a future session's git push credentials
   for this repo and push commit `4e4d36e` directly from
   `claude/rfid-gate-box-not-found-5vs2kz`.
2. Once merged, redeploy the `frontend` service (port 3000/legacy.html) and
   confirm `pda` service (`:5100`) + Flutter mobile build are already
   running code built from `main` at/after commit `1ec4602` so the fix is
   actually live.
3. No automated tests were run this session for the `legacy.html` change
   (no test harness for that file) — only a syntax check
   (`node --check`-equivalent via `new Function`) on the affected script
   block. Manual verification of Gate In/Out with a real RFID scan is
   recommended once deployed.

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
