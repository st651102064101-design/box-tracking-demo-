#!/bin/sh
# Creates .env next to docker-compose.yml with random secrets. Never overwrites.
set -eu
cd "$(dirname "$0")/.."
if [ -e .env ]; then
  echo ".env already exists — left unchanged"
  exit 0
fi
umask 077
rand() { openssl rand -hex "$1"; }
cat > .env <<EOF
POSTGRES_PASSWORD=$(rand 24)
JWT_SECRET=$(rand 32)
FX9600_WEBHOOK_SECRET=$(rand 24)
LPR_WEBHOOK_SECRET=$(rand 24)
# Used only when the database has no admin yet.
SEED_ADMIN_PASSWORD=$(rand 12)
EOF
echo "Created .env. Put the two webhook secrets into the RFID reader and the LPR camera."
echo "Existing database? Postgres keeps its old password until you change it — see .env.example."
