<p align="center">
	<a href="https://earlynotify.com">
		<picture>
			<img src="https://files.earlynotify.com/logo-white-bg.png" alt="EarlyNotify" width="350">
		</picture>
	</a>
	<br>
</p>
<h3 align="center">Stay Ahead with EarlyNotify</h3>
<hr>

EarlyNotify is designed to keep you up-to-date with the latest Apple updates, notifying you within just 15 minutes of new updates hitting Apple servers.

Never miss a critical update again.

Deploy yourself:
1. Create a Cloudflare D1 database and configure with migrations/init.sql
2. Create 1 KV store (binding `NOTIFY`) for templates and the device catalog.
3. Under the value "email_version" within your KV store, place the email template "email-templates/newupdate.html"
4. Under the value "email_unsubscribe" within your KV store, place the email template "email-templates/email_unsubscribe.html"
5. Set your secrets: `wrangler secret put LAMBDA_API_KEY`, `HCAPTCHA_SECRET`, and `INTERNAL_SECRET` (`openssl rand -hex 32`).
6. Configure two cron triggers: `* * * * *` (poll for new firmware) and `*/2 * * * *` (send pending notifications).

Upgrading an existing deployment:
1. Apply `migrations/002_scale.sql` and `migrations/003_firmware_d1.sql`.
2. Set `INTERNAL_SECRET` — dispatch refuses to run without it.
3. **Replace your cron triggers with exactly `* * * * *` and `*/2 * * * *`.** The two jobs have separate subrequest budgets and cannot share an invocation, so any other schedule is rejected and logged rather than guessed at.
4. The `RELEASES` KV namespace is no longer used — drop the binding from `wrangler.toml` and delete the namespace. `KV_CACHE_AUTOREMOVE` is likewise unused.

### How sending works

The 1-minute cron polls ipsw.me and records which devices changed version. The
2-minute cron picks those up and hands batches of 40 to `/internal/send`, each of
which runs as its own Worker invocation — the free tier allows 50 subrequests per
invocation, so fanning out is what lifts the per-run email ceiling.

Sending is paced to 12 emails/sec, deliberately under the SES default of 14/sec.
If you raise your SES quota, raise `CHILD_CONCURRENCY` in `src/index.js` to match.

The firmware cache lives in D1, not KV. The free KV plan allows 1,000 writes/day
and this is written roughly every minute, so a KV-backed cache exceeds the quota
on its own — writes then fail rather than queue, which looks like firmware
updates intermittently not persisting.

`/internal/bounce` accepts `{ email, reason }` and deactivates every subscription
for that address. Wire it to your SES bounce/complaint SNS topic — without
suppression, a bad address re-bounces on every release and drags your sender
reputation down with it.
