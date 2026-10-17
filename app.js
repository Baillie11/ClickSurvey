const express = require('express');
const session = require('express-session');
const expressLayouts = require('express-ejs-layouts');
const path = require('path');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');
const authRoutes = require('./src/routes/auth');
const adminRoutes = require('./src/routes/admin');
const surveyRoutes = require('./src/routes/surveys');
const apiRoutes = require('./src/routes/api');
const publicRoutes = require('./src/routes/public');
const { initDb } = require('./src/models/db');

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layout');
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(session({
  secret: process.env.SESSION_SECRET || 'secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

app.use(async (req, res, next) => {
  if (!global.db) {
    try {
      global.db = await initDb();
    } catch (error) {
      return next(error);
    }
  }
  next();
});

app.use((req, res, next) => {
  res.locals.user = req.session.user;
  res.locals.baseUrl = process.env.BASE_URL || `http://localhost:${port}`;
  next();
});

app.use('/', authRoutes);
app.use('/admin', adminRoutes);
app.use('/admin/surveys', surveyRoutes);
app.use('/api', apiRoutes);
app.use('/', publicRoutes);

app.use((err, req, res, next) => {
  console.error('Application error:', err);
  res.status(500).send(`Server error: ${err.message}`);
});

app.use((req, res) => {
  res.status(404).render('404', { title: 'Not Found' });
});

const basePort = process.env.PORT && process.env.PORT.trim() ? parseInt(process.env.PORT, 10) : 3000;
const fallbackPort = 3001;

function startServer(portToUse, isRetry = false) {
  const server = app.listen(portToUse, () => {
    console.log(`ClickSurvey running on http://localhost:${portToUse}`);
  });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`Port ${portToUse} is already in use.`);
      if (!isRetry && portToUse === basePort) {
        console.log(`Trying fallback port ${fallbackPort}...`);
        startServer(fallbackPort, true);
      } else {
        console.error('Please free the port or set PORT in your environment.');
        process.exit(1);
      }
    } else {
      console.error('Server startup error:', error);
      process.exit(1);
    }
  });
}

startServer(basePort);
