<p align="center">
	<a href="https://earlynotify.com">
		<picture>
			<img src="https://files.earlynotify.com/logo-white-bg.png" alt="EarlyNotify" width="350">
		</picture>
	</a>
	<br>
</p>
<h3 align="center">Stay Ahead with EarlyNotify</h3>
<p align="center">
	<a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
	<img src="https://img.shields.io/badge/Cloudflare-Workers-orange.svg" alt="Cloudflare Workers">
</p>
<hr>

EarlyNotify keeps you up to date with the latest Apple releases, notifying you by email,
Discord, Slack, Microsoft Teams, Pushover or your own webhook within about 15 minutes of a
new build hitting Apple's servers.

Never miss a critical update again. Hosted at [earlynotify.com](https://earlynotify.com),
or deploy your own with the instructions below.

## How it works

A Cloudflare Worker polls [ipsw.me](https://ipsw.me) for the firmware version of every
device someone has subscribed to. When a version moves, it records which devices changed
and notifies those subscribers — email via an AWS Lambda function URL wrapping SES, and
everything else by posting to the subscriber's webhook or to Pushover.

The whole thing is designed to run inside Cloudflare's **free** tier, which is the source
of most of the non-obvious decisions in `src/index.js`. See
[Design notes](#design-notes) if you are wondering why something is shaped the way it is.

## Prerequisites

- A Cloudflare account (free plan is fine) with [Wrangler](https://developers.cloudflare.com/workers/wrangler/) installed
- An AWS account with SES in production access, fronted by a Lambda function URL that
  accepts `{ to, subject, message }` and an `x-api-key` header
- An [hCaptcha](https://www.hcaptcha.com/) site key and secret for the signup form

## Deploy your own

1. Copy `wrangler.toml.example` to `wrangler.toml` and fill in your IDs. `wrangler.toml`
   is gitignored — keep it that way, it holds live credentials.
2. Create a D1 database and apply `migrations/init.sql`.
3. Create one KV namespace bound as `NOTIFY`, for email templates and the device catalog.
4. Put the email templates in KV: `email-templates/newupdate.html` under the key
   `email_version`, `email-templates/email_unsubscribe.html` under `email_unsubscribe`, and
   `email-templates/email_confirm.html` under `email_confirm`.
5. Set your secrets — never put these in `wrangler.toml`:
   ```sh
   wrangler secret put LAMBDA_API_KEY
   wrangler secret put HCAPTCHA_SECRET
   wrangler secret put INTERNAL_SECRET   # openssl rand -hex 32
   ```
6. Configure exactly two cron triggers: `* * * * *` (poll for new firmware) and
   `*/2 * * * *` (send pending notifications).
7. `wrangler deploy`

### Upgrading an existing deployment

1. Apply `migrations/002_scale.sql` and `migrations/003_firmware_d1.sql`.
2. Set `INTERNAL_SECRET` — dispatch refuses to run without it.
   Also add the `SELF` service binding from `wrangler.toml.example` — dispatch
   refuses to run without it.
3. **Replace your cron triggers with exactly `* * * * *` and `*/2 * * * *`.** The two jobs
   have separate subrequest budgets and cannot share an invocation, so any other schedule
   is rejected and logged rather than guessed at.
4. The `RELEASES` KV namespace is no longer used — drop the binding from `wrangler.toml`
   and delete the namespace. `KV_CACHE_AUTOREMOVE` is likewise unused.
5. For double opt-in and channels: upload `email-templates/email_confirm.html` to KV as
   `email_confirm` first, then apply `migrations/004_channels_optin.sql` and deploy
   straight after it. The migration renames `email` to `destination`, so old code and new
   schema don't mix — keep the gap between the two commands short. Existing subscribers
   are unaffected and don't need to re-confirm.

## Design notes

**Sending fans out.** The 1-minute cron records which devices changed version. The
2-minute cron picks those up and hands batches to `/internal/send` through the `SELF`
service binding, each of which runs as its own Worker invocation. (A plain `fetch()` to the
Worker's own hostname does not work — same-zone Worker-to-Worker fetch fails.) The free tier allows 50 subrequests per invocation, so fanning
out is what lifts the per-run email ceiling — a single invocation caps out around 45
emails no matter what.

**Sending is paced to 6 emails/sec**, under the SES default of 14/sec. A throttled send
returns an error, gets retried, and becomes a duplicate email to a real person, so running
below the ceiling beats running at it. The pace is set by Cloudflare, not SES: batches
called through a service binding share the top-level request's 6-connection limit, so
raising `CHILD_CONCURRENCY` would not send any faster — the extra waves just queue.

**The firmware cache lives in D1, not KV.** The free KV plan allows 1,000 writes/day and
this cache is written roughly every minute, so a KV-backed version exceeds the quota on
its own. Writes then fail rather than queue, which looks like firmware updates
intermittently not persisting.

**Dispatch only reads the subscriber table when something actually changed.** A quiet
2-minute tick costs a single-row read. Scanning every subscriber on every tick is what
otherwise caps the whole design at a couple of thousand subscribers.

**Bounce handling matters.** `/internal/bounce` accepts `{ email, reason }` and
deactivates every subscription for that address. Wire it to your SES bounce/complaint SNS
topic — without suppression a bad address re-bounces on every release, and SES puts an
account under review past roughly a 5% bounce rate. Suppressed addresses stay suppressed:
`/subscribe` will not re-enrol them.

**`/internal/send` only answers the `SELF` binding.** It refuses any request whose
hostname isn't the binding's internal one, so it is unreachable from the internet even if
`INTERNAL_SECRET` leaks.

## Subscribing

`POST /subscribe` takes a form body with `channel`, `destination`, `device` and
`h-captcha-response`, plus `pushover_token` for Pushover. A bare `email` field with no
`channel` still works, as the site sent before channels existed.

| `channel`  | `destination`                                                        |
|------------|----------------------------------------------------------------------|
| `email`    | an email address                                                     |
| `discord`  | a Discord webhook URL (`https://discord.com/api/webhooks/…`)          |
| `slack`    | a Slack incoming webhook URL (`https://hooks.slack.com/services/…`)   |
| `teams`    | a Teams Workflows or Office 365 connector webhook URL                 |
| `pushover` | a Pushover user or group key, with the subscriber's own app token in `pushover_token` |
| `webhook`  | any public `https://` URL on the default port                         |

**Email and generic webhooks are double opt-in.** The subscription is stored inactive and
a confirmation link is sent to the destination itself, so only someone who can read that
inbox or endpoint can turn it on. The link opens a page with a button, rather than
confirming on load, because mail scanners and link previews fetch every URL they see. One
confirmation covers every device a destination signs up for within 15 minutes, and no
second one is sent in that window.

**Discord, Slack, Teams and Pushover activate immediately.** Their destinations are
credentials: holding a webhook URL already lets you post to that channel, and holding a
Pushover app token already lets you message any user key, so confirming would prove
nothing. Signup posts a "subscribed" message instead; if it can't be delivered, nothing is
stored and the form returns an error. Pushover messages go through the subscriber's own
application, so they count against that app's quota, not yours.

For every channel, the response is the same whether the destination is new, already
subscribed or suppressed, so the form can't be used to look up who is subscribed.
Email addresses deactivated by a bounce or complaint are never re-enrolled through the
form; clear `deactivated_reason` by hand to allow it. Webhooks and Pushover switched off for
failing can sign up again, since signup itself has to deliver successfully.

### Generic webhooks

Each request is a JSON `POST`:

```json
{
  "event": "firmware.released",
  "device": { "id": "iPhone17,3", "name": "iPhone 16" },
  "version": "26.1",
  "unsubscribe_url": "https://api.earlynotify.com/unsubscribe?token=…",
  "sent_at": "2026-09-30T12:00:00.000Z"
}
```

`event` is one of `subscription.confirm`, `firmware.released` or `subscription.cancelled`.
The `subscription.confirm` event also carries `confirm_url`, which must be opened in a
browser to activate the subscription, and `signing_secret`. **That event is the only place
the secret is ever sent.** Store it.

Verify every request by computing HMAC-SHA256, keyed with the secret, over
`X-EarlyNotify-Timestamp + "." + raw body`, and comparing it (in constant time) with the
hex after `sha256=` in `X-EarlyNotify-Signature`. Reject timestamps more than a few minutes
old to prevent replays.

Respond with any 2xx. A `410 Gone` unsubscribes the endpoint permanently, and so do 30
failed deliveries in a row (timeouts, 5xx, refused connections) — about a day and a half
of failing every retry. Any success resets the count. For Discord, Slack
and Teams, a `404` (a deleted webhook) does the same, as does Pushover rejecting the user
key or app token. Redirects are not followed, and each
request times out after 5 seconds.

## Metrics

`metrics/` is a second, cron-only Worker that pushes project numbers to a Telegraf
`http_listener_v2` as InfluxDB line protocol: subscribers by channel and state, the signup
funnel, per-device versions and backlog, dispatch state, and release detections. It is kept
separate so it can never affect sending. It only reads, apart from one KV key
(`metrics_versions`) that it writes when a release is detected.

1. `cp metrics/wrangler.toml.example metrics/wrangler.toml` and fill in the same D1 and KV
   IDs as the main Worker, plus `METRICS_ENDPOINT`.
2. `cd metrics && wrangler secret put TELEGRAF_TOKEN && wrangler deploy`

It POSTs to `${METRICS_ENDPOINT}/${TELEGRAF_TOKEN}` every 10 minutes. Every point carries
`source=earlynotify`, and all numeric fields are integers.

| Measurement                  | Tags                             | Fields |
|------------------------------|----------------------------------|--------|
| `earlynotify_totals`         | —                                | `active_subscriptions`, `active_destinations`, `devices_watched`, `backlog` |
| `earlynotify_subscriptions`  | `channel`, `state`, (`reason`)   | `count` — state is `active`/`pending`/`expired`/`unsubscribed`/`deactivated`; reason is `bounce`/`complaint`/`gone`/`unresponsive`/`other` |
| `earlynotify_audience`       | `channel`                        | `destinations` (unique addresses/webhooks/keys) |
| `earlynotify_signups_daily`  | `channel`, stamped at UTC midnight | `started`, `active`, `pending`, `expired` — the last 3 days are re-sent each run, so confirmations update in place |
| `earlynotify_device`         | `device_id`, `device`            | `subscribers`, `behind`, `version`, `build`, `fetched_age_s` |
| `earlynotify_release`        | `device_id`, `device`, stamped at detection | `version`, `previous`, `build`, `detection_lag_s` (ipsw.me release time to detection) |
| `earlynotify_email_domain`   | `email_domain`                   | `destinations` — top 15, rest as `other`; `EMAIL_DOMAIN_TOP_N=0` turns it off |
| `earlynotify_dispatch`       | —                                | `pending_devices`, `locked`, `last_sweep_age_s` |
| `earlynotify_collector`      | —                                | `last_run_ok`, `rows_read`, `duration_ms`, `lines` |

**Dashboard.** Import `metrics/grafana-dashboard.json` in Grafana (Dashboards → New →
Import) and pick your InfluxDB data source (Flux) when asked. The bucket is a text box at the
top of the dashboard, defaulting to `servers`. Releases appear as annotations on every time
series, and the Health row goes amber or red on the silent failures: no push from the
collector, a stalled catch-up sweep, an undrained backlog, or stale firmware checks.

**Watch `rows_read`.** Each run reads about 4 rows per `subscriptions` row, which is
about 545k/day at ~920 subscriptions, against the free plan's 5M D1 reads/day shared with
the notifier. It grows linearly with the table. The cron has to stay under 14 minutes
(the notifier's `KV_CACHE_INVALID`) for `detection_lag_s` to be accurate.

## License

MIT — see [LICENSE](LICENSE).
