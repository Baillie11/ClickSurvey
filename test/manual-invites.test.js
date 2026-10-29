const { test } = require('node:test');
const assert = require('node:assert/strict');
const { queueManualInvite } = require('../src/manual-invites');
const body = { survey_id: '5', recipient_email: 'Test@Example.com', recipient_name: 'Test' };
function fixture(status = 'Active', suppressed = false) {
  const saved = [];
  const db = {
    beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {},
    async execute(sql, params) {
      if (sql.startsWith('SELECT id,status')) return [[{ id: 5, status, brand_name: 'VitaePro' }]];
      if (sql.startsWith('SELECT id,survey_id')) return [saved.filter(x => x.token === params[0])];
      if (sql.startsWith('SELECT id FROM suppressions')) return [suppressed ? [{ id: 1 }] : []];
      if (sql.startsWith('INSERT INTO survey_invites')) {
        saved.push({ id: saved.length + 1, survey_id: params[0], recipient_name: params[1], recipient_email: params[2], token: params[6] });
        assert.equal(params[4], 'manual_invitation');
        assert.match(sql, /'Pending'/);
        return [{ insertId: saved.length }];
      }
      throw Error(sql);
    },
  };
  return { getConnection: async () => db, saved };
}
test('one invitation is queued and form replay returns the same invitation', async () => {
  const db = fixture();
  assert.equal(await queueManualInvite(db, body, 'token', 1), 1);
  assert.equal(await queueManualInvite(db, body, 'token', 1), 1);
  assert.equal(db.saved.length, 1);
  assert.equal(db.saved[0].recipient_email, 'test@example.com');
  await assert.rejects(queueManualInvite(db, { ...body, recipient_email: 'different@example.com' }, 'token', 1), { status: 409 });
});
test('inactive and suppressed recipients cannot be queued', async () => {
  for (const db of [fixture('Draft'), fixture('Archived'), fixture('Active', true)]) {
    await assert.rejects(queueManualInvite(db, body, 'token', 1), { status: 400 });
    assert.equal(db.saved.length, 0);
  }
});
test('rejects multiple recipients and invalid survey IDs', async () => {
  for (const invalid of [{ ...body, recipient_email: 'a@example.com,b@example.com' }, { ...body, survey_id: 'bad' }]) {
    const db = fixture();
    await assert.rejects(queueManualInvite(db, invalid, 'token', 1), { status: 400 });
    assert.equal(db.saved.length, 0);
  }
});
test('admin form renders, enforces CSRF, and redirects duplicate submissions to one invite', async () => {
  const express = require('express');
  const request = require('supertest');
  const { csrf } = require('../src/security');
  const pool = fixture();
  pool.execute = async (sql) => {
    if (sql.includes('FROM users')) return [[{ id: 1 }]];
    if (sql.includes('FROM surveys')) return [[{ id: 5, title: 'Help shape VitaePro' }]];
    throw Error(sql);
  };
  const previous = global.db;
  global.db = pool;
  const app = express();
  app.set('views', require('path').join(__dirname, '../views'));
  app.set('view engine', 'ejs');
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => {
    req.session = { csrf: 'a'.repeat(64), user: req.get('X-Test-Admin') ? { id: 1 } : null };
    res.locals.appPath = '/clicksurvey'; next();
  });
  app.use(csrf);
  app.use('/admin', require('../src/routes/admin'));
  try {
    await request(app).get('/admin/send-invitation').expect(302);
    const form = await request(app).get('/admin/send-invitation?survey_id=5').set('X-Test-Admin', '1').expect(200);
    assert.match(form.text, /Help shape VitaePro/);
    assert.match(form.text, /action="\/clicksurvey\/admin\/send-invitation"/);
    const requestId = /name="request_id" value="([a-f0-9]{64})"/.exec(form.text)[1];
    await request(app).post('/admin/send-invitation').set('X-Test-Admin', '1').type('form').send(body).expect(403);
    for (let i = 0; i < 2; i++) {
      await request(app).post('/admin/send-invitation').set('X-Test-Admin', '1').type('form')
        .send({ ...body, request_id: requestId, _csrf: 'a'.repeat(64) }).expect(302).expect('Location', '/admin/delivery?queued=1');
    }
    assert.equal(pool.saved.length, 1);
    const invalid = await request(app).post('/admin/send-invitation').set('X-Test-Admin', '1').type('form')
      .send({ ...body, request_id: requestId, _csrf: 'a'.repeat(64), recipient_email: 'bad' }).expect(400);
    assert.match(invalid.text, /Invalid email/);
  } finally { global.db = previous; }
});
