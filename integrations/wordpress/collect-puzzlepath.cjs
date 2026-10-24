"use strict";
// Run once per minute under flock. Credentials live outside the web root.
const fs = require('fs');
async function collect({ key, fetcher = fetch }) {
  const site = 'https://puzzlepath.com.au/wp-json/puzzlepath-clicksurvey/v1';
  const base = 'https://clickecommerce.com.au/clicksurvey';
  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  async function request(url, options = {}) {
    return fetcher(url, { ...options, headers, redirect: 'error', signal: AbortSignal.timeout(20000) });
  }
  const response = await request(site + '/events');
  if (!response.ok) throw Error('Queue HTTP ' + response.status);
  const { events } = await response.json();
  if (!Array.isArray(events) || events.length > 5) throw Error('Invalid queue response');
  let accepted = 0;
  for (const payload of events) {
    if (!payload || typeof payload.eventId !== 'string' || payload.sourceApp !== 'Puzzle Path' || payload.eventType !== 'hunt_completed') throw Error('Invalid queued event');
    let acknowledgement = { eventId: payload.eventId, status: 'retry' };
    try {
      const delivery = await request(base + '/api/events', { method: 'POST', body: JSON.stringify(payload) });
      const body = await delivery.json();
      if (delivery.ok && body.success && body.eventId === payload.eventId) {
        acknowledgement = { eventId: payload.eventId, status: body.inviteCreated ? 'accepted' : 'no_matching_rule', inviteId: body.inviteId };
      }
    } catch (_) { /* A persisted retry keeps the original event ID and payload. */ }
    const ack = await request(site + '/ack', { method: 'POST', body: JSON.stringify(acknowledgement) });
    if (!ack.ok || !(await ack.json()).success) throw Error('Queue acknowledgement failed');
    if (acknowledgement.status === 'accepted') accepted++;
  }
  return { collected: events.length, accepted };
}
module.exports = { collect };
if (require.main === module) {
  const file = process.env.CLICKSURVEY_CONNECTIONS_FILE;
  if (!file) throw Error('CLICKSURVEY_CONNECTIONS_FILE is required');
  const { key } = JSON.parse(fs.readFileSync(file, 'utf8'))['Puzzle Path'];
  collect({ key }).then(result => console.log(new Date().toISOString(), result))
    .catch(error => { console.error(new Date().toISOString(), error.message); process.exitCode = 1; });
}
