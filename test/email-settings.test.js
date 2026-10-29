const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const nodemailer = require('nodemailer');
const { deliverOne } = require('../src/worker');
const { emailHeader } = require('../src/validation');

test('email settings reject header injection and accept blank defaults', () => {
  assert.equal(emailHeader('  My business  ', 'sender'), 'My business');
  for (const value of ['', '   ', undefined, null]) assert.equal(emailHeader(value, 'subject'), null);
  for (const value of ['Hello\nBcc: x@example.com', 'Hello\rworld', 'a'.repeat(256), ['bad']])
    assert.throws(() => emailHeader(value, 'subject'));
});

test('create and edit persist email settings and reject invalid headers before writing', async () => {
  const saved = global.db;
  const writes = [];
  global.db = { execute: async (sql, values) => { if (sql.includes('FROM users')) return [[{id: 1}]]; if (!sql.startsWith('SELECT')) writes.push({sql, values}); return [[]]; } };
  const app = express();
  app.use(express.urlencoded({extended: false}));
  app.use((req, res, next) => { req.session = {user: {id: 1, is_admin: 1}}; next(); });
  app.use('/admin', require('../src/routes/admin'));
  app.use((err, req, res, next) => res.status(err.status || 500).send(err.message));
  try {
    const body = {survey_key: 'feedback', title: 'Feedback', status: 'Active', email_subject: 'Your visit', email_sender_name: 'My Company'};
    for (const url of ['/admin/surveys', '/admin/surveys/1']) {
      await request(app).post(url).type('form').send(body).expect(302);
      const write = writes.at(-1);
      assert.ok(write.sql.includes('email_subject'));
      assert.ok(write.values.includes('Your visit'));
      assert.ok(write.values.includes('My Company'));
      await request(app).post(url).type('form').send({...body, email_subject: 'Bad\nheader'}).expect(400);
    }
    assert.equal(writes.length, 2);
    await request(app).post('/admin/surveys/1').type('form').send({survey_key: 'feedback', title: 'Feedback', status: 'Active'}).expect(302);
    assert.deepEqual(writes.at(-1).values.slice(-3, -1), [null, null]);
  } finally { global.db = saved; }
});

test('worker produces custom MIME headers and retains the configured sender address', async () => {
  const savedFrom = process.env.EMAIL_FROM, savedBase = process.env.BASE_URL;
  process.env.EMAIL_FROM = 'Click Survey <surveys@example.com>';
  process.env.BASE_URL = 'https://example.com';
  const transport = nodemailer.createTransport({streamTransport: true, buffer: true});
  try {
    for (const settings of [
      {email_subject: 'Thanks for visiting', email_sender_name: 'Acme, Customer Care', brand_name: 'Acme'},
      {email_subject: 'Survey default', email_sender_name: 'Default sender', metadata_json: JSON.stringify({invitationEmail: {subject: 'Puzzle Path adventure', senderName: 'Puzzle Path'}})},
      {brand_name: 'Acme'},
      {},
    ]) {
      const row = {id: 1, invite_token: 'token', recipient_email: 'customer@example.com', source_app: 'Shop', survey_title: 'Feedback', survey_status: 'Active', expires_at: new Date(Date.now()+60000), attempts: 0, ...settings};
      const connection = {beginTransaction: async()=>{}, commit: async()=>{}, release: ()=>{}, rollback: async()=>{}, query: async()=>[[row]], execute: async()=>[[]]};
      const db = {getConnection: async()=>connection, execute: async()=>[[]]};
      let message;
      await deliverOne(db, {sendMail: async mail => { message = (await transport.sendMail(mail)).message.toString(); return {}; }});
      const overrides = JSON.parse(settings.metadata_json || '{}').invitationEmail || {};
      assert.ok(message.includes('Subject: ' + (overrides.subject || settings.email_subject || 'Quick feedback about your Shop experience')));
      assert.ok(message.includes('<surveys@example.com>'));
      assert.ok(message.includes(overrides.senderName || (settings.email_sender_name ? '"Acme, Customer Care"' : settings.brand_name || 'Click Survey')));
      if (settings.brand_name) assert.ok(!message.includes('From: Click Survey'));
    }
  } finally {
    for (const [key, value] of [['EMAIL_FROM', savedFrom], ['BASE_URL', savedBase]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    transport.close();
  }
});

test('email migration upgrades already-hardened databases and can run again', async () => {
  const { migrate } = require('../scripts/migrate');
  const columns = new Set();
  let applied = false;
  const connection = {
    query: async sql => {
      if (sql.includes('GET_LOCK')) return [[{acquired: 1}]];
      if (sql.includes('information_schema.tables')) return [[]];
      if (sql.startsWith('SELECT version')) return [sql.includes('001-hardening') || applied ? [{version: 'done'}] : []];
      if (sql.startsWith('ALTER TABLE surveys')) columns.add(sql.split(' ')[5]);
      if (sql.startsWith('INSERT INTO schema_migrations')) { assert.ok(sql.includes('002-survey-email')); applied = true; }
      return [[]];
    },
    execute: async (sql, values) => [columns.has(values[1]) ? [{exists: 1}] : []],
  };
  await migrate(connection);
  await migrate(connection);
  assert.deepEqual([...columns], ['email_subject', 'email_sender_name']);
  assert.equal(applied, true);
});

 test('API accepts plugin email preferences and rejects malformed headers', () => {
  const { eventInput } = require('../src/validation');
  const payload = {eventId: 'quest:1', sourceApp: 'Puzzle Path', eventType: 'hunt_completed', recipient: {email: 'guest@example.com'}};
  const settings = {subject: 'Your adventure', senderName: 'Puzzle Path'};
  assert.deepEqual(eventInput({...payload, metadata: {invitationEmail: settings}}).metadata.invitationEmail, settings);
  for (const invalid of [[], null, {subject: 'Bad\nheader'}, {senderName: ['bad']}, {subject: 'x'.repeat(256)}])
    assert.throws(() => eventInput({...payload, metadata: {invitationEmail: invalid}}));
 });
