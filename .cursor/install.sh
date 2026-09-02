#!/usr/bin/env bash
# Idempotent Cloud Agent bootstrap for BoxTrace.
#
# The default Cloud Agent image has no Docker/Postgres, so this uses the
# backend's built-in in-process WASM Postgres (USE_PGLITE=true) — zero external
# services required. Installs deps, generates local .env files (once), then
# applies the schema and seeds the admin account into the PGlite database.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
echo "[install] repo root: $ROOT"

echo "[install] installing backend + frontend dependencies…"
npm run install:all

# --- backend/.env (never committed; contains JWT secret) -------------------
if [ ! -f backend/.env ]; then
  echo "[install] creating backend/.env (PGlite dev config)…"
  JWT_SECRET="$(openssl rand -hex 32 2>/dev/null || node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
  cat > backend/.env <<EOF
PORT=4000
NODE_ENV=development
CORS_ORIGIN=http://localhost:3000,http://localhost:5100

JWT_SECRET=${JWT_SECRET}
JWT_EXPIRES_IN=12h
SEED_ADMIN_USERNAME=admin
SEED_ADMIN_PASSWORD=admin123
SEED_ADMIN_NAME=ผู้ดูแลระบบ

# In-process WASM Postgres — no DB server needed. Data persists under PGLITE_DIR.
USE_PGLITE=true
PGLITE_DIR=./.pglite-dev
DATABASE_URL=postgres://boxtrace:boxtrace@localhost:5432/boxtrace

SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
SMTP_FROM=
EOF
else
  echo "[install] backend/.env already present — leaving as-is"
fi

# --- frontend/.env ----------------------------------------------------------
if [ ! -f frontend/.env ]; then
  echo "[install] creating frontend/.env…"
  echo "BACKEND_URL=http://localhost:4000" > frontend/.env
else
  echo "[install] frontend/.env already present — leaving as-is"
fi

# --- schema + admin seed (idempotent) --------------------------------------
echo "[install] applying schema (migrate)…"
npm run db:migrate
echo "[install] seeding admin account…"
npm run db:seed

echo "[install] done ✓"
