CREATE TABLE IF NOT EXISTS line_link_invites (
  id               SERIAL PRIMARY KEY,
  token_hash       TEXT NOT NULL UNIQUE,
  customer_id      TEXT NOT NULL REFERENCES customers(id),
  oauth_state_hash TEXT,
  nonce            TEXT,
  code_verifier    TEXT,
  expires_at       TIMESTAMPTZ NOT NULL,
  consumed_at      TIMESTAMPTZ,
  created_by       TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS line_link_invites_customer_idx
  ON line_link_invites (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS line_link_invites_expiry_idx
  ON line_link_invites (expires_at) WHERE consumed_at IS NULL;
