---
name: frontend-3d-gate
description: Edit warehouse 3D / forklift / WebGL gate visuals. Use when changing Three.js scenes, forklift selection, or 3D runtime caching. Not for login pages or API-only work.
---

# Frontend 3D gate

## Scope

- Three.js scenes and controls under `frontend/` (often via legacy runtime or bundled 3D helpers)
- Forklift hover/select, wheel/lift animation, WebGL renderer fallbacks
- Cache-busting for 3D runtime assets when selection bugs recur after deploy

## Guidance

- Prefer fixing selection/hover targeting over remounting the whole scene.
- Keep renderer fallback paths when WebGL is unavailable.
- Load this skill’s detail only; do not also load PDA RFID skills unless the task crosses products.

## Verify

`web-demo-verify` plus a focused visual check of the 3D view when UI behavior changed.
