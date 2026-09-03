ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS line_user_id TEXT,
  ADD COLUMN IF NOT EXISTS contact_email TEXT;

COMMENT ON COLUMN customers.line_user_id IS
  'LINE Messaging API recipient userId received from the Official Account webhook';
COMMENT ON COLUMN customers.contact_email IS
  'Customer notification email address';
