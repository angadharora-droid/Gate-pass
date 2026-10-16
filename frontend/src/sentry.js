// ─── SENTRY: errors and slow pages in the browser ────────────────────────────
// Imported first by main.jsx. Without VITE_SENTRY_DSN (set in Vercel, baked
// in at build time) nothing is initialised and nothing is sent.
import * as Sentry from '@sentry/react';
import { useEffect } from 'react';
import {
  Routes, useLocation, useNavigationType, createRoutesFromChildren, matchRoutes,
} from 'react-router-dom';

const dsn = import.meta.env.VITE_SENTRY_DSN;
const apiOrigin = (import.meta.env.VITE_API_URL || '').replace(/\/+$/, '');

if (dsn) {
  const rate = Number(import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE);
  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    integrations: [
      // Page loads and navigations, named by route (/passes/:id, not every id)
      Sentry.reactRouterV6BrowserTracingIntegration({
        useEffect, useLocation, useNavigationType, createRoutesFromChildren, matchRoutes,
      }),
    ],
    // Share of page views traced — 10% keeps a busy day inside the free plan
    tracesSampleRate: Number.isFinite(rate) ? rate : 0.1,
    // Link a page's trace to the API calls it makes, so one trace shows the
    // browser wait and the server/database time together
    tracePropagationTargets: apiOrigin ? [apiOrigin] : [/^\/api\//],
    sendDefaultPii: false,
  });
}

// <Routes> that tells Sentry which route matched (a plain <Routes> without Sentry)
export const SentryRoutes = Sentry.withSentryReactRouterV6Routing(Routes);

// Errors carry who hit them — the user id and role only, never name or email
export function identifyUser(user) {
  Sentry.setUser(user ? { id: user.id } : null);
  Sentry.setTag('role', user?.role || null);
}

export const ErrorBoundary = Sentry.ErrorBoundary;
