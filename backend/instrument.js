// ─── SENTRY: error + performance monitoring ──────────────────────────────────
// Start the server with `node --import ./instrument.js server.js` (the npm
// start script): in ES modules Sentry can only trace Express, HTTP and MongoDB
// for modules loaded AFTER it. server.js also imports this file first, so
// errors are still reported if the --import is ever forgotten (without
// per-request tracing).
// Without SENTRY_DSN nothing is initialised — local dev and the smoke test
// never report anything.
import 'dotenv/config';
import * as Sentry from '@sentry/node';

// Login and user-edit bodies carry passwords, and every API call carries the
// login token: strip request bodies, cookies and credential headers from
// everything before it leaves the server.
function scrub(event) {
  const req = event.request;
  if (req) {
    delete req.data;
    delete req.cookies;
    for (const name of Object.keys(req.headers || {})) {
      if (/^(authorization|cookie|x-api-key)$/i.test(name)) delete req.headers[name];
    }
  }
  return event;
}

// The Performance view is for API requests. Database work at startup (index
// builds, seeding) has no request around it and would show up as nameless
// one-off traces, so only traces named after an HTTP request are kept.
function onlyRequests(event) {
  return /^(GET|POST|PUT|PATCH|DELETE) \//.test(event.transaction || '') ? scrub(event) : null;
}

if (process.env.SENTRY_DSN) {
  const rate = Number(process.env.SENTRY_TRACES_SAMPLE_RATE);
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.RAILWAY_ENVIRONMENT_NAME || process.env.NODE_ENV || 'development',
    release: process.env.RAILWAY_GIT_COMMIT_SHA || undefined,
    // Share of requests traced for the Performance view (which endpoints are
    // slow, and why). 10% keeps a busy day inside the free plan.
    tracesSampleRate: Number.isFinite(rate) ? rate : 0.1,
    // Never attach IP addresses, cookies or user details automatically
    sendDefaultPii: false,
    // Platform health checks would eat the free quota and say nothing
    ignoreTransactions: ['GET /api/health'],
    beforeSend: scrub,
    beforeSendTransaction: onlyRequests,
  });
}
