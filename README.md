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

EarlyNotify keeps you up to date with the latest Apple releases, emailing you within
about 15 minutes of a new build hitting Apple's servers.

Never miss a critical update again. Hosted at [earlynotify.com](https://earlynotify.com),
or deploy your own with the instructions below.

## How it works

A Cloudflare Worker polls [ipsw.me](https://ipsw.me) for the firmware version of every
device someone has subscribed to. When a version moves, it records which devices changed
and emails those subscribers via an AWS Lambda function URL wrapping SES.

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
4. Put `email-templates/newupdate.html` in KV under the key `email_version`, and
   `email-templates/email_unsubscribe.html` under `email_unsubscribe`.
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
3. **Replace your cron triggers with exactly `* * * * *` and `*/2 * * * *`.** The two jobs
   have separate subrequest budgets and cannot share an invocation, so any other schedule
   is rejected and logged rather than guessed at.
4. The `RELEASES` KV namespace is no longer used — drop the binding from `wrangler.toml`
   and delete the namespace. `KV_CACHE_AUTOREMOVE` is likewise unused.

## Design notes

**Sending fans out.** The 1-minute cron records which devices changed version. The
2-minute cron picks those up and hands batches to `/internal/send`, each of which runs as
its own Worker invocation. The free tier allows 50 subrequests per invocation, so fanning
out is what lifts the per-run email ceiling — a single invocation caps out around 45
emails no matter what.

**Sending is paced to 12 emails/sec**, deliberately under the SES default of 14/sec. A
throttled send returns an error, gets retried, and becomes a duplicate email to a real
person, so running just below the ceiling beats running at it. If you raise your SES
quota, raise `CHILD_CONCURRENCY` in `src/index.js` to match.

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
account under review past roughly a 5% bounce rate.

## License

MIT — see [LICENSE](LICENSE).
