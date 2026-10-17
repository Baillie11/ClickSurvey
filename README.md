# ClickSurvey

Event-triggered surveys for WordPress, Node.js and other servers that can POST JSON over HTTPS. This installation serves **one trusted administration team**; administrators can access all surveys and responses. It is not a tenant-isolated SaaS product.

## Requirements and setup

- Node.js 20.20 or newer; MySQL 8+ or MariaDB 10.6+ with InnoDB and `SKIP LOCKED` support.
- An existing empty database for a new installation, or a backed-up existing ClickSurvey database.
- An SMTP account and a public HTTPS origin for production.

1. Run `npm ci` and copy `.env.example` to `.env`.
2. Set database credentials. Use a password-authenticated database account supported by mysql2, not Windows GSSAPI/integrated authentication. The runtime does not create databases. A database administrator creates the database and grants the migration user schema modification permissions first.
3. Generate `SESSION_SECRET` with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Set `BASE_URL` to your public origin, with no path. Configure SMTP and `EMAIL_FROM`.
4. Back up existing data, then run `npm run db:migrate`. The migration is repeatable and records its version. Run with a migration account, then switch to the restricted runtime account.
5. Set `ADMIN_EMAIL`, `ADMIN_NAME`, and a unique `ADMIN_PASSWORD` of 16–72 bytes. Run `npm run admin:create`, then remove `ADMIN_PASSWORD` from the environment. This command creates an administrator or resets and promotes the named account. Public registration is disabled.
6. Start **both** `npm start` and `npm run worker` as separately supervised processes. `npm run dev` uses Node's built-in watch mode. Open the configured URL and sign in.

Production: use `NODE_ENV=production`, HTTPS, a unique session secret, TLS-enabled SMTP and a reverse proxy. Set `TRUST_PROXY_HOPS` only to the actual number of trusted proxy hops; leave it empty for direct access. Sessions persist in MySQL. Give the runtime account SELECT/INSERT/UPDATE/DELETE on this database, without global or schema modification rights. Enable database connection encryption through your hosting network where required; the current database client assumes a trusted local/private network.

Deploy the web process and worker together. `/health` reports web process health. `/ready` requires database access and a worker heartbeat less than two minutes old. Admin → Delivery shows the last heartbeat and the most recent 200 invitations. Alert on a stale worker, growing backlog, Failed or DeliveryUnknown invitations. Review your SMTP provider's delivery/bounce reports; Sent means SMTP accepted the message, not inbox delivery. Keep TLS/proxy configuration and backup retention under operational monitoring.

The built-in request limits are per web process. Run one web instance, or add a shared rate limiter at the gateway before scaling web instances. Multiple delivery workers safely claim separate queue items.

## Upgrading the original prototype

Stop the old web process, back up the database, install dependencies, configure a new session secret and run the migration. Existing records and historical duplicate responses are retained. **Existing users are not automatically trusted as administrators, and old API keys are disabled.** Explicitly provision trusted administrators and create replacement keys. Existing sessions must be replaced by the new session cookie/secret. Configure each source website with its new key and a stable event ID before restarting event traffic.

`schema.sql` is the original baseline; `npm run db:migrate` must also run for both fresh installations and upgrades. Runtime startup checks the migration version and fails when required schema is missing. Back up before migration: MySQL DDL is not transactional. Do not downgrade to the prototype against a migrated database. Roll back application and database together from a verified backup if necessary.

The original local configuration encountered a server requesting `auth_gssapi_client`, which mysql2 cannot use. Configure a dedicated password-authenticated database user; no existing database authentication settings were changed during remediation.

## Surveys and API clients

Create an Active survey with valid questions. Create an API client whose **name exactly matches `sourceApp`**, and supply its allowed survey IDs, visible in survey edit URLs. Keys are random, shown once and stored as hashes with an indexed identifier. Empty survey permissions grant no survey access. Disable a key to revoke access.

Create an Active automation rule matching the source and event type. Its target survey must be Active and permitted by the key. The newest matching rule wins. Delays from 0 to 43,200 minutes are supported. Invitations expire 30 days after their scheduled send time. Archive a question rather than deleting its historical answers.

## Event API

Server-side only: do not expose API keys in browser JavaScript. WordPress and Node.js use the same contract; server-to-server calls do not require CORS.

```http
POST /api/events
Content-Type: application/json
Authorization: Bearer YOUR_KEY
```

```json
{
  "eventId": "hunt_completed:booking-123",
  "sourceApp": "Puzzle Path",
  "eventType": "hunt_completed",
  "recipient": { "name": "Test Customer", "email": "test@example.com" },
  "metadata": { "bookingId": "123" }
}
```

`recipient.name` is optional. `metadata` must be an object, up to 16KB. Source/event names are at most 255 characters. `eventId` is required (or use `Idempotency-Key`); it must be printable ASCII, up to 128 characters, and unique within the API client. Store it with the originating business event and **reuse the exact ID and logical payload on retries**. Do not generate a new ID on each HTTP attempt. A repeated ID with different data returns 409. JSON object property ordering does not affect deduplication.

- **202:** event recorded and invite queued, or recorded without a matching Active rule. Inspect `inviteCreated`.
- **200:** previously accepted event returned without creating another invite.
- **400/415:** invalid payload/content type; **401:** invalid/disabled key; **403:** source/survey outside key permissions; **409:** event ID conflict; **429:** request limit; **500:** internal failure.

```json
{"success":true,"eventId":"hunt_completed:booking-123","inviteId":42,"duplicate":false,"inviteCreated":true,"deliveryStatus":"queued; query event status for delivery"}
```

Acceptance is not delivery. Authenticated `GET /api/events/<URL-encoded-eventId>` returns the current status for this client's event. An event recorded with no matching rule stays that way on retry; configure the rule before sending events, or explicitly replay the business event under a new ID after review.

Retry network errors, 429 and transient 5xx responses using the original event ID with bounded exponential backoff. Investigate other errors. A caller should persist pending business events locally until ClickSurvey acknowledges them. The example clients return failures for the caller to handle; they do not provide a persistent caller-side job queue.

## WordPress

Copy [the example plugin](examples/wordpress-clicksurvey.php) to `wp-content/mu-plugins/wordpress-clicksurvey.php`. Define `CLICKSURVEY_URL` (HTTPS) and `CLICKSURVEY_API_KEY` in server-side `wp-config.php`, outside the public web root where your host supports it. Connect `clicksurvey_request()` to the relevant purchase/completion hook in your application:

```php
$result = clicksurvey_request(
    'hunt_completed:' . $booking_id,
    'Puzzle Path',
    'hunt_completed',
    $customer_email,
    $customer_name,
    array('bookingId' => (string) $booking_id)
);
if (is_wp_error($result)) {
    // Log without secrets/recipient data, and persist retryable failures
    // in your existing job system using the same event ID and payload.
}
```

Choose the actual business hook in your WordPress plugin. The client validates HTTP/API acknowledgement and distinguishes missing rules from queued invitations. It does not install a WooCommerce or booking-specific hook automatically. WordPress runtime execution remains a staging acceptance check.

## Node.js

Set `CLICKSURVEY_URL` and `CLICKSURVEY_API_KEY` on the calling server. Use [the Node client](examples/node-client.js):

```js
const { requestSurvey } = require('./examples/node-client');
await requestSurvey({
  eventId: `cover_letter_created:${coverLetter.id}`,
  sourceApp: 'VitaePro',
  eventType: 'cover_letter_created',
  recipient: { email: user.email, name: user.name },
  metadata: { coverLetterId: String(coverLetter.id) }
});
```

## Delivery and unsubscribe

The database is the durable queue. The worker checks every five seconds, respects scheduling, checks suppression and survey state, and retries definite transient SMTP failures with backoff, at most five attempts. Pending/Retry records survive restarts. Failed invitations can be retried through Admin → Delivery while unexpired.

SMTP and MySQL cannot commit atomically. A connection interruption during SMTP, or an interrupted Sending claim, becomes **DeliveryUnknown** and is not automatically resent. Check provider logs using the stable Message-ID before deciding whether to mark the invite Sent or requeue it through a controlled database operation. A stale Sending record becomes DeliveryUnknown after ten minutes. This prevents blind retries after ambiguous acceptance; it does not promise exactly-once SMTP delivery.

Private invitations permit one completed response, enforced transactionally and by a unique completion key. Completed, expired, suppressed, unsent and archived-survey links are unavailable. Public `/s/<key>` surveys intentionally accept multiple independent responses, with request limits. Email includes an unsubscribe confirmation link; visiting the GET link does not unsubscribe, so scanners cannot trigger it. Confirmation globally suppresses future invitations to that address. Source fields on suppressions are context, not scope. A message already accepted by SMTP cannot be recalled.

## Database backup and restore

Install `mariadb-dump` or `mysqldump`. Set `MYSQLDUMP_PATH` to its executable path when it is not on PATH. `npm run db:backup` writes a compressed consistent snapshot under ignored `backups/`; failures remove incomplete output. The account needs dump permissions for the database. GitHub contains source and migrations, **not** recipient data or secrets.

Copy backups to encrypted storage with a retention policy appropriate to your business; schedule `npm run db:backup` in your hosting backup scheduler and monitor its exit status. Keep `.env` in separate secure recovery storage. A local backup alone does not protect against loss of this machine.

Restore drill: create a separate empty database, decompress the `.sql.gz`, import the SQL using the MariaDB/MySQL client against that empty database, then run migrations and verify survey/response counts, permissions, and sample records. Stop web/worker processes during a real recovery. Start a recovered worker only after reviewing historical Pending/Retry/Sending records and SMTP logs. Never point a restore drill at production. The test suite exercises a real dump/restore when `TEST_MYSQLDUMP_PATH` is supplied.

## Verification

`npm test` runs local validation and an SMTP protocol test with no external email. Integration tests are opt-in and create/drop only random databases named `clicksurvey_test_*` on a **separate local test server**:

```powershell
$env:RUN_DB_TESTS='true'
$env:TEST_DB_PORT='33317'
$env:TEST_DB_PASSWORD='your-isolated-test-root-password'
$env:TEST_MYSQLDUMP_PATH='C:\Program Files\MariaDB 11.4\bin\mariadb-dump.exe'
npm test
```

Tests cover legacy migration and repeatability, auth/CSRF/admin checks, API scopes, validation, concurrent deduplication, delayed delivery, SMTP failure states, concurrent workers, response rollback/single completion, unsubscribe, the Node client over HTTP, and optional backup restoration. They do not verify your real SMTP provider, public domain/proxy, live WordPress hook or production load. Complete these staging checks before inviting real recipients.

See [the remediation record](REMEDIATION.txt) for this change's results and remaining deployment requirements.

Primary references: [Express 5 error handling](https://expressjs.com/en/5x/guide/error-handling/), [Nodemailer SMTP settings](https://nodemailer.com/smtp), [WordPress HTTP POST](https://developer.wordpress.org/reference/functions/wp_remote_post/).
