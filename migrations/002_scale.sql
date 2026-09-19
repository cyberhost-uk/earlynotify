-- Upgrade migration for existing deployments. Fresh installs get all of this
-- from init.sql instead.

-- Lets dispatch read one device's subscribers without scanning the table.
CREATE INDEX IF NOT EXISTS idx_subscriptions_device_active
  ON subscriptions(device_id, active);

-- Present in init.sql but absent from older deployments, which leaves every
-- /unsubscribe lookup doing a full table scan.
CREATE UNIQUE INDEX IF NOT EXISTS idx_unsubscribe_token
  ON subscriptions(unsubscribe_token);

-- Set when a send is suppressed by a bounce/complaint rather than by the user.
ALTER TABLE subscriptions ADD COLUMN deactivated_reason TEXT DEFAULT NULL;

-- /subscribe and /internal/bounce both normalise to lowercase, so any row
-- written before that normalisation existed is unreachable by the bounce
-- endpoint and forks into a duplicate row on resubscribe. OR IGNORE skips the
-- rare case where both casings already exist for the same device; those keep
-- their original casing rather than failing the migration.
UPDATE OR IGNORE subscriptions SET email = lower(email) WHERE email <> lower(email);

-- Single-row coordination table.
--   locked_until    epoch ms; guards against two dispatch runs overlapping
--   pending_devices SPACE-separated device ids whose firmware version moved.
--                   Not comma-separated: every Apple identifier contains a
--                   comma (iPhone17,3), which a comma delimiter splits in half.
--   last_sweep_at   epoch ms of the last full reconciliation pass
CREATE TABLE IF NOT EXISTS dispatch_state (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  locked_until    INTEGER NOT NULL DEFAULT 0,
  pending_devices TEXT    NOT NULL DEFAULT '',
  last_sweep_at   INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO dispatch_state (id) VALUES (1);
