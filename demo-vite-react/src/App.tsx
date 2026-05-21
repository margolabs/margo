import { useEffect, useState, type FormEvent } from 'react';

interface Tier {
  name: string;
  price: string;
  cadence: string;
  features: string[];
  cta: string;
  primary: boolean;
}

/**
 * Hardcoded fallback used while /api/tiers is in flight (and as a backup
 * if the request fails). The fake API in vite.config.ts returns the same
 * shape, so swapping in the live data on resolve doesn't shift layout.
 */
const FALLBACK_TIERS: Tier[] = [
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
];

type Health = 'pending' | 'ok' | 'down';

type SubscribeState =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'ok'; id: string }
  | { kind: 'error'; status: number; message: string };

export default function App(): JSX.Element {
  const [tiers, setTiers] = useState<Tier[]>(FALLBACK_TIERS);
  const [tiersLoading, setTiersLoading] = useState(true);
  const [health, setHealth] = useState<Health>('pending');
  const [email, setEmail] = useState('');
  const [subscribe, setSubscribe] = useState<SubscribeState>({ kind: 'idle' });

  // Load tiers + ping health on mount. Both are independent — they fire
  // in parallel and update their own state slices. Failures fall back to
  // the hardcoded tiers / "down" badge so the page never gets stuck.
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/tiers');
        if (!res.ok) throw new Error(`tiers fetch: ${res.status}`);
        const data = (await res.json()) as { tiers: Tier[] };
        if (Array.isArray(data.tiers)) setTiers(data.tiers);
      } catch {
        // Keep the fallback tiers; the network-pin demo doesn't need a
        // working tiers call — pinning the FAILED one is a valid demo path.
      } finally {
        setTiersLoading(false);
      }
    })();
    void (async () => {
      try {
        const res = await fetch('/api/health');
        setHealth(res.ok ? 'ok' : 'down');
      } catch {
        setHealth('down');
      }
    })();
  }, []);

  const onSubscribe = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    setSubscribe({ kind: 'pending' });
    try {
      const res = await fetch('/api/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        id?: string;
        error?: string;
      };
      if (res.ok && body.id) {
        setSubscribe({ kind: 'ok', id: body.id });
      } else {
        setSubscribe({
          kind: 'error',
          status: res.status,
          message: body.error ?? `HTTP ${res.status}`,
        });
      }
    } catch (err) {
      setSubscribe({
        kind: 'error',
        status: 0,
        message: (err as Error).message || 'network error',
      });
    }
  };

  return (
    <>
      <header>
        <div className="header-row">
          <h1>Acme Pricing · React Demo</h1>
          <span
            className={`api-status api-status-${health}`}
            data-testid="api-status"
            title={`Last health check: ${health}`}
          >
            <span className="api-dot" aria-hidden="true"></span>
            API: {health === 'pending' ? '…' : health}
          </span>
        </div>
        <nav>
          <a href="#features">Features</a>
          <a href="#pricing">Pricing</a>
          <a href="#subscribe">Subscribe</a>
          <a href="#contact">Contact</a>
        </nav>
      </header>
      <main>
        <section id="features" className="card">
          <h2>Why teams pick Acme</h2>
          <p>
            Acme cuts the boring parts of running a small team — billing, contracts, payroll — into
            one quiet workflow. More time on the work that actually pays.
          </p>
        </section>

        <section id="pricing" className="card">
          <h2>Pricing</h2>
          <p>Simple, predictable, and refundable in the first 30 days.</p>
          <div className="tiers" data-testid="tiers" aria-busy={tiersLoading}>
            {tiersLoading
              ? Array.from({ length: 3 }).map((_, i) => (
                  <article key={`skeleton-${i}`} className="tier tier-skeleton" aria-hidden="true">
                    <span className="skel skel-h" />
                    <span className="skel skel-price" />
                    <span className="skel skel-line" />
                    <span className="skel skel-line" />
                    <span className="skel skel-line" />
                    <span className="skel skel-btn" />
                  </article>
                ))
              : tiers.map((tier) => (
                  <article
                    key={tier.name}
                    className={`tier${tier.primary ? ' tier-highlight' : ''}`}
                  >
                    <h3>{tier.name}</h3>
                    <p className="price">
                      {tier.price}
                      {tier.cadence ? <span>{tier.cadence}</span> : null}
                    </p>
                    <ul>
                      {tier.features.map((feature) => (
                        <li key={feature}>{feature}</li>
                      ))}
                    </ul>
                    <button
                      className={`cta${tier.primary ? '' : ' cta-secondary'}`}
                      data-testid={tier.primary ? 'cta-primary' : `cta-${tier.name.toLowerCase()}`}
                    >
                      {tier.cta}
                    </button>
                  </article>
                ))}
          </div>
        </section>

        <section id="subscribe" className="card">
          <h2>Stay in the loop</h2>
          <p>Drop your email. We'll let you know when we ship the next big thing.</p>
          <form onSubmit={onSubscribe} className="subscribe-form" data-testid="subscribe-form">
            <input
              type="email"
              required
              placeholder="you@team.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={subscribe.kind === 'pending'}
              data-testid="subscribe-email"
            />
            <button
              type="submit"
              className="cta"
              disabled={subscribe.kind === 'pending' || !email}
              data-testid="subscribe-submit"
            >
              {subscribe.kind === 'pending' ? 'Subscribing…' : 'Subscribe'}
            </button>
          </form>
          {subscribe.kind === 'ok' ? (
            <p className="subscribe-result subscribe-result-ok" data-testid="subscribe-result">
              ✓ Subscribed — id <code>{subscribe.id}</code>
            </p>
          ) : null}
          {subscribe.kind === 'error' ? (
            <p
              className={`subscribe-result subscribe-result-error subscribe-result-${subscribe.status === 500 ? '5xx' : '4xx'}`}
              data-testid="subscribe-result"
            >
              {subscribe.status >= 500 ? '✗' : '⚠'} {subscribe.status || 'NET'} · {subscribe.message}
            </p>
          ) : null}
        </section>

        <section id="contact" className="card">
          <h2>Get in touch</h2>
          <p>
            Reach us at <a href="mailto:hello@acme.com">hello@acme.com</a>.
          </p>
        </section>
      </main>
    </>
  );
}
