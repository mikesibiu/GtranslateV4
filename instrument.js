/**
 * Sentry instrumentation — must be required before all other modules in server.js
 * Set SENTRY_DSN env var in Heroku to activate. No-op when unset.
 */
const Sentry = require('@sentry/node');

if (process.env.SENTRY_DSN) {
    Sentry.init({
        dsn: process.env.SENTRY_DSN,
        environment: process.env.NODE_ENV || 'development',
        tracesSampleRate: 0.1,   // 10% of requests traced (keeps quota low)
        sendDefaultPii: false    // Don't send IP addresses / user data
    });
}
