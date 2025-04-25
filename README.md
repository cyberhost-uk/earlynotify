<p align="center">
	<a href="https://earlynotify.com">
		<picture>
			<img src="https://files.earlynotify.com/logo.jpg" alt="EarlyNotify" width="550">
		</picture>
	</a>
	<br>
</p>
<h3 align="center">Stay Ahead with EarlyNotify</h3>
<hr>

EarlyNotify is designed to keep you up-to-date with the latest Apple updates, notifying you within just 15 minutes of new updates hitting Apple servers.

EarlyNotify ensures you never miss a critical update again. Sign up today and take control of your Apple devices. 

Deploy yourself:
1. Create a Cloudflare D1 database and configure with migrations/init.sql
2. Create 2 KV stores. One is used for general storage, the other is for caching ipsw.me responses.
3. Under the value "email_version" within your general KV store, place the email template "email-templates/newupdate.html"
4. Under the value "email_unsubscribe" within your general KV store, place the email template "email-templates/email_unsubscribe.html"
5. Configure a cron to schedule checking. We have this configured at every 5 minutes.
