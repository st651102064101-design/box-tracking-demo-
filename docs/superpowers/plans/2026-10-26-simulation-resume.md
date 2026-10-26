# Simulation resume and uninterrupted fullscreen plan

**Approved scope:** keep the fullscreen simulation running when the normal login timer expires, and resume its saved progress after refresh/re-entry. User authorized implementation after the playback. Save camera/view as a sensible default. The local simulation continues to avoid business API/DB writes.

**Approach:** defer login navigation while the authenticated app hosts the actual fullscreen simulation; check normal expiry again on exit. This does not extend a server JWT or disable backend authorization. Refresh with an expired server token may require signing in again, after which the same account can resume its checkpoint. This approach keeps the existing zero-API simulation boundary and avoids a new refresh-token system.

**Checkpoint:** small, versioned localStorage record scoped to account identity. Persist deterministic engine elapsed time and cycle, camera/view snapshots, shell and overlay visibility. Save every second, on page hide/visibility changes, and synchronously before host removal on Esc/fullscreen loss. Exclude tokens, business inventory and wall-clock catch-up. Corrupt/incompatible/blocked storage must fall back safely; warn briefly on storage failure. A completed cycle updates the saved position rather than clearing it. No reset UI is added in this scope.

- [x] Add validated engine checkpoint/restore and a bounded account-scoped local checkpoint helper; cover deterministic resume, corruption, storage denial and account separation.
- [x] Integrate view checkpoint restore/save and synchronous host flush before removal. Preserve native pointer lock rules; saved first person shows a click-to-look hint instead of requesting lock without a gesture.
- [x] Guard top-level and legacy expiry/navigation while a real fullscreen simulation is active; recheck on exit and token changes. Cover timeout, stale 401, spoofed child message and exit cleanup.
- [x] Browser verification: refresh/re-entry resumes matching engine/camera; native fullscreen loss saves; B/H and view snapshots survive; no API traffic from simulation; expired session does not tear down active scene.
- [x] Update guide, review scoped changes, back up and patch deployment files preserving its different app/auth implementation, rebuild frontend, verify actual Docker behavior and push WEB_APP_DEMO.

## Deployment constraint

The deployment checkout's app/page.tsx and legacy-sync.js differ from WEB_APP_DEMO. Apply the equivalent small guard change to those existing files; do not overwrite unrelated skeleton/auth changes. Copy matching simulation modules plus new modules byte-for-byte. No backend rebuild or DB migration is necessary.

## Verification / review

- Frontend unit suite: 5 files, 42 tests passed. TypeScript check passed.
- Resume browser suite: 14 checks passed, including actual nested fullscreen timer deferral and refresh/first-person resume; zero API calls/runtime errors; checkpoint about 0.5KB.
- Existing native controls browser suite: 30 checks passed.
- Fresh review found two token-rotation/logout races and a profile alias/rename issue. Fixed guard-first 401 handling, explicit pending denial for a missing token, and stable per-account ids using the host's actual token. Added regressions; reviewer reran 18 checkpoint/session unit tests and confirmed no remaining findings.
- Docker frontend production build passed and the service was recreated. Seven changed public resources were verified byte-for-byte over HTTP against deployment copies. The differing app page and legacy handlers received narrow equivalent changes; prior files are backed up in `.simulation-work/deploy-before-resume-1792976387728`.
- Actual Docker app: 16 browser checks passed, including checkpoint restoration after re-entry and a full app reload, expired token / in-flight 401 deferral while fullscreen, normal login navigation after exit with checkpoint preserved, native controls/audio and real scene restoration. Zero simulation API requests and zero baseline/new runtime errors. No backend code or database changes.
