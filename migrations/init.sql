CREATE TABLE subscriptions (
  email TEXT NOT NULL,
  device_id TEXT NOT NULL,
  subscribed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  active INTEGER DEFAULT 1,
  last_notified_version TEXT DEFAULT NULL,
  PRIMARY KEY (email, device_id)
);
