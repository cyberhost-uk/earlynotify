-- destination is an email address, webhook URL or, for Pushover,
-- `userKey:appToken`, per channel. A pending (unconfirmed) row is active = 0 with confirm_token set.
CREATE TABLE subscriptions (
  destination TEXT NOT NULL,
  device_id TEXT NOT NULL,
  subscribed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  active INTEGER DEFAULT 1,
  last_notified_version TEXT DEFAULT NULL,
  unsubscribe_token TEXT DEFAULT NULL,
  deactivated_reason TEXT DEFAULT NULL,
  channel TEXT NOT NULL DEFAULT 'email',
  confirm_token TEXT DEFAULT NULL,
  confirm_sent_at INTEGER DEFAULT NULL,   -- epoch ms
  signing_secret TEXT DEFAULT NULL,       -- generic webhooks only
  consecutive_failures INTEGER NOT NULL DEFAULT 0,  -- non-email; see MAX_CONSECUTIVE_FAILURES
  PRIMARY KEY (destination, device_id)
);

CREATE UNIQUE INDEX idx_unsubscribe_token ON subscriptions(unsubscribe_token);

-- Not unique: one confirmation can cover several devices signed up together.
CREATE INDEX idx_confirm_token ON subscriptions(confirm_token);

-- Lets dispatch read one device's subscribers without scanning the table.
CREATE INDEX idx_subscriptions_device_active ON subscriptions(device_id, active);

-- Single-row coordination table.
--   locked_until    epoch ms; guards against two dispatch runs overlapping
--   pending_devices SPACE-separated device ids whose firmware version moved.
--                   Not comma-separated: every Apple identifier contains a
--                   comma (iPhone17,3), which a comma delimiter splits in half.
--   last_sweep_at   epoch ms of the last full reconciliation pass
CREATE TABLE dispatch_state (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  locked_until    INTEGER NOT NULL DEFAULT 0,
  pending_devices TEXT    NOT NULL DEFAULT '',
  last_sweep_at   INTEGER NOT NULL DEFAULT 0
);

INSERT INTO dispatch_state (id) VALUES (1);

-- Latest known firmware per device. In D1 rather than KV because the free KV
-- plan allows only 1,000 writes/day and this is written every minute; per-row
-- upserts also avoid the lost-update race a shared blob had.
CREATE TABLE firmware_cache (
  device_id   TEXT PRIMARY KEY,
  fetched_at  INTEGER NOT NULL,   -- epoch ms
  version     TEXT,
  buildid     TEXT,
  releasedate TEXT,
  filesize    INTEGER
);
