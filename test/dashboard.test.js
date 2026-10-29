const {test} = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const path = require('path');
test('preview is admin-only, has no submission form, and active filtering is parameterized', async () => {
  const saved = global.db;
  const queries = [];
  global.db = {execute: async (sql, args) => {
    queries.push({sql,args});
    if(sql.includes('FROM users')) return [[{id:1}]];
    if(sql.includes('FROM survey_questions')) return [[{id:2,question_text:'Feedback?',question_type:'short_text'}]];
    if(sql.includes('FROM surveys')) return [[{id:1,title:'Draft preview',survey_key:'draft',status:'Draft'}]];
    throw Error('Unexpected query');
  }};
  const app = express();
  app.set('views', path.join(__dirname,'../views')); app.set('view engine','ejs');
  app.use((req,res,next)=>{req.session = {user:req.get('X-Test-Admin') ? {id:1} : null}; res.locals.appPath='/clicksurvey';res.locals.csrfToken='test';next();});
  app.use('/admin',require('../src/routes/admin'));
  try {
    await request(app).get('/admin/surveys/1/preview').expect(302).expect('Location','/login');
    const preview=await request(app).get('/admin/surveys/1/preview').set('X-Test-Admin','1').expect(200);
    assert.match(preview.text,/Blank survey preview/); assert.match(preview.text,/Feedback\?/); assert.doesNotMatch(preview.text,/<form\b/); assert.doesNotMatch(preview.text,/action=/);
    await request(app).get('/admin/surveys?status=Active').set('X-Test-Admin','1').expect(200);
    assert.ok(queries.some(q=>q.sql.includes('WHERE status = ?') && q.args[0]==='Active'));
    assert.ok(queries.every(q=>q.sql.startsWith('SELECT')));
  } finally {global.db=saved;}
});
