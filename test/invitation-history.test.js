const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { trackingKey } = require('../src/email-tracking');
test('email image tracking validates its separate token without changing survey-link status', async () => {
  const old = global.db; const updates = [];
  global.db = { execute: async (sql, args) => {
    if (sql.startsWith('SELECT')) return [[{ invite_token: 'private-survey-token' }]];
    updates.push(sql); return [{}];
  }};
  const app = express(); app.use(require('../src/routes/public'));
  try {
    await request(app).get('/email-open/1/' + '0'.repeat(64) + '.gif').expect(200);
    assert.equal(updates.length, 0);
    const key = trackingKey('private-survey-token');
    assert.notEqual(key, 'private-survey-token');
    await request(app).head('/email-open/1/' + key + '.gif').expect(200);
    assert.equal(updates.length, 0);
    await request(app).get('/email-open/1/' + key + '.gif').expect(200).expect('Content-Type', /image\/gif/).expect('Cache-Control', /no-store/);
    assert.equal(updates.length, 1);
    assert.match(updates[0], /email_opened_at=COALESCE/);
    assert.match(updates[0], /suppressions/);
    assert.doesNotMatch(updates[0], /SET status/);
  } finally { global.db = old; }
});
test('history is admin-only, survey scoped, paginated, and labels legacy opens correctly', async () => {
  const old = global.db; let queryArgs;
  global.db = {
    execute: async sql => {
      if (sql.includes('FROM users')) return [[{id:1}]];
      if (sql.includes('COUNT')) return [[{total:101}]];
      return [[{id:5,title:'VitaePro'}]];
    },
    query: async (sql, args) => { queryArgs = args; assert.match(sql, /WHERE survey_id=\?/); return [[{ id:9, recipient_email:'test@example.com', status:'Opened', sent_at:new Date('2026-10-29T00:00:00Z'), opened_at:new Date('2026-10-29T01:00:00Z'), email_tracking_enabled:0, attempts:1 }]]; },
  };
  const app = express(); app.set('views', require('path').join(__dirname,'../views')); app.set('view engine','ejs');
  app.use((req,res,next) => { req.session={user:req.get('X-Admin') ? {id:1}:null}; res.locals.appPath='/clicksurvey'; next(); });
  app.use('/admin',require('../src/routes/admin'));
  try {
    await request(app).get('/admin/surveys/5/invitations').expect(302);
    const page = await request(app).get('/admin/surveys/5/invitations?page=2').set('X-Admin','1').expect(200);
    assert.deepEqual(queryArgs,[5,100]);
    for (const label of ['test@example.com','Not tracked','Survey link visited','Australia/Brisbane','Previous']) assert.ok(page.text.includes(label));
    assert.doesNotMatch(page.text, /invite_token/);
  } finally { global.db = old; }
});
