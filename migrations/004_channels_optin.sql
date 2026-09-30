-- Double opt-in, and notification channels other than email.
--
-- `email` becomes `destination`: an email address, a webhook URL or, for
-- Pushover, `userKey:appToken`, depending on `channel`. Every existing row is a
-- confirmed email subscription and carries on unchanged.
--
-- Apply immediately before deploying the matching Worker. The old code reads
-- `email` and the new code reads `destination`, so whichever runs against the
-- other's schema fails for the gap between the two commands. A failed dispatch
-- leaves pending_devices intact, so nothing is lost — it retries next tick.
ALTER TABLE subscriptions RENAME COLUMN email TO destination;
ALTER TABLE subscriptions ADD COLUMN channel TEXT NOT NULL DEFAULT 'email';

-- A pending subscription (email and generic webhooks only; the other channels
-- activate at signup) is active = 0 with confirm_token set. One token can
-- cover several devices signed up together, so its index is not unique.
ALTER TABLE subscriptions ADD COLUMN confirm_token TEXT DEFAULT NULL;
ALTER TABLE subscriptions ADD COLUMN confirm_sent_at INTEGER DEFAULT NULL;  -- epoch ms

-- HMAC key for generic webhooks, shared by every row with the same destination.
ALTER TABLE subscriptions ADD COLUMN signing_secret TEXT DEFAULT NULL;

-- Sends in a row that failed without a definitive answer (timeouts, 5xx).
-- Non-email only; see MAX_CONSECUTIVE_FAILURES in src/index.js.
ALTER TABLE subscriptions ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_confirm_token ON subscriptions(confirm_token);

-- The old /subscribe re-activated a bounced row without clearing its reason,
-- and left the address's other bounced rows as they were. The new code reads a
-- reason as "suppressed": a later bounce would skip the live row and keep
-- mailing it, and the subscriber could never add another device. An address
-- with any live row isn't suppressed, so clear the reason on all of its rows.
UPDATE subscriptions SET deactivated_reason = NULL
WHERE deactivated_reason IS NOT NULL
  AND destination IN (SELECT destination FROM subscriptions WHERE active = 1);
