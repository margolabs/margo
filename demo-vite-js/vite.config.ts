import { defineConfig, type Plugin } from 'vite';
import margo from 'margo-dev';

/**
 * Tiny in-process fake API so margo's network-request-pin feature has
 * something to capture in the React demo.
 *
 * Endpoints:
 *  - GET  /api/health     -> 200 { ok, ts }  (sanity check)
 *  - GET  /api/tiers      -> 200 { tiers }   (artificially slow: 250ms — pin this for a "too slow" comment)
 *  - POST /api/subscribe  -> 201 { id }      on valid email
 *                            400 { error }   if missing / no "@"
 *                            500 { error }   DELIBERATE BUG: email.length > 30 simulates a
 *                                            "database connection refused" failure so users
 *                                            can pin the failed request and comment
 *                                            "long emails should still work".
 */
const fakeApi = (): Plugin => ({
  name: 'demo-fake-api',
  configureServer(server) {
    server.middlewares.use('/api/health', (req, res, next) => {
      if (req.method !== 'GET') return next();
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, ts: new Date().toISOString() }));
    });

    server.middlewares.use('/api/tiers', (req, res, next) => {
      if (req.method !== 'GET') return next();
      // Artificial latency so this request is pinnable for a "this is slow" comment.
      setTimeout(() => {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            tiers: [
              {
                name: 'Starter',
                price: '$0',
                cadence: '/month',
                features: ['Up to 3 seats', 'Unlimited comments', 'Community support'],
                cta: 'Start free',
                primary: false,
              },
              {
                name: 'Team',
                price: '$12',
                cadence: '/seat / mo',
                features: ['Unlimited seats', 'SSO + audit log', 'Priority support'],
                cta: 'Start free trial',
                primary: true,
              },
              {
                name: 'Enterprise',
                price: 'Custom',
                cadence: '',
                features: ['SLA', 'Dedicated infra', 'On-prem option'],
                cta: 'Contact sales',
                primary: false,
              },
            ],
          }),
        );
      }, 250);
    });

    server.middlewares.use('/api/subscribe', (req, res, next) => {
      if (req.method !== 'POST') return next();
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        let body: { email?: unknown } = {};
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          body = {};
        }
        const email = typeof body.email === 'string' ? body.email : '';

        const sendJson = (status: number, payload: unknown) => {
          res.statusCode = status;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(payload));
        };

        if (!email || !email.includes('@')) {
          return sendJson(400, { error: 'invalid email' });
        }
        // DELIBERATE BUG: emails longer than 30 chars blow up.
        if (email.length > 30) {
          return sendJson(500, { error: 'database connection refused' });
        }
        const id = 'sub_' + Math.random().toString(16).slice(2, 8).padEnd(6, '0');
        sendJson(201, { id });
      });
    });
  },
});

export default defineConfig({
  plugins: [margo(), fakeApi()],
  server: { port: 5173 },
});
