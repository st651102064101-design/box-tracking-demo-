ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS line_display_name TEXT,
  ADD COLUMN IF NOT EXISTS line_picture_url TEXT,
  ADD COLUMN IF NOT EXISTS line_linked_at TIMESTAMPTZ;

COMMENT ON COLUMN customers.line_display_name IS 'Display name returned by LINE Login when the customer linked their account.';
COMMENT ON COLUMN customers.line_picture_url IS 'Profile picture URL returned by LINE Login; may expire and is optional.';
COMMENT ON COLUMN customers.line_linked_at IS 'Timestamp at which the current LINE account was linked.';
