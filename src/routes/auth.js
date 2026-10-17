const express = require('express');
const bcrypt = require('bcrypt');
const router = express.Router();

function requireGuest(req, res, next) {
  if (req.session.user) return res.redirect('/admin');
  next();
}

router.get('/register', requireGuest, (req, res) => {
  res.render('auth/register', { title: 'Register', error: null });
});

router.post('/register', requireGuest, async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) {
    return res.render('auth/register', { title: 'Register', error: 'All fields are required.' });
  }

  const [existing] = await global.db.execute('SELECT id FROM users WHERE email = ?', [email]);
  if (existing.length) {
    return res.render('auth/register', { title: 'Register', error: 'Email already registered.' });
  }

  const password_hash = await bcrypt.hash(password, 10);
  await global.db.execute(
    'INSERT INTO users (name, email, password_hash, created_at, updated_at) VALUES (?, ?, ?, NOW(), NOW())',
    [name, email, password_hash]
  );

  res.redirect('/login');
});

router.get('/login', requireGuest, (req, res) => {
  res.render('auth/login', { title: 'Login', error: null });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const [rows] = await global.db.execute('SELECT * FROM users WHERE email = ?', [email]);
  const user = rows[0];
  if (!user) {
    return res.render('auth/login', { title: 'Login', error: 'Invalid email or password.' });
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    return res.render('auth/login', { title: 'Login', error: 'Invalid email or password.' });
  }

  req.session.user = { id: user.id, name: user.name, email: user.email };
  res.redirect('/admin');
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

module.exports = router;
