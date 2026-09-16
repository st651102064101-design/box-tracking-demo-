---
name: reader-heartbeat
description: FX9600 or fixed-reader online/offline via webhook heartbeat. Use when changing reader presence detection, webhook routes, or heartbeat timeouts. Not for handheld UI-only edits.
---

# Reader heartbeat

## Scope

- Backend webhook / heartbeat endpoints for fixed readers (e.g. FX9600)
- Online/offline status propagated to clients

## Guidance

- Prefer idempotent heartbeat handling and clear timeout semantics.
- Cover with backend Vitest when routes/services change.
- Load frontend/PDA code only if status display must change with the API.
