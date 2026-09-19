-- Moves the firmware cache out of Workers KV and into D1.
--
-- KV allows 1,000 writes/day on the free plan. refreshFirmware rewrote the
-- entire firmware_cache blob whenever any device was refetched, and with ~45
-- devices on a 14-minute TTL at least one is stale almost every minute — about
-- 1,440 writes/day from that one line, before anything else. D1 allows 100,000
-- row writes/day, and per-row upserts mean only the devices actually refetched
-- are written (~4,600/day).
--
-- Per-row writes also remove the lost-update race the blob had: a request path
-- that read the blob before a refresh and wrote it after would revert every
-- device that refresh had just updated.
--
-- No seeding required. An empty table just means every device reads as stale,
-- so the refresher repopulates it within two minutes (30 devices/tick). Cold
-- entries are flagged as changed, but dispatch still gates on
-- last_notified_version, so nobody receives a duplicate.

CREATE TABLE IF NOT EXISTS firmware_cache (
  device_id   TEXT PRIMARY KEY,
  fetched_at  INTEGER NOT NULL,   -- epoch ms
  version     TEXT,
  buildid     TEXT,
  releasedate TEXT,
  filesize    INTEGER
);

-- The RELEASES KV namespace held only firmware_cache and is now unused. The
-- binding can be dropped from wrangler.toml and the namespace deleted once this
-- version is deployed.
