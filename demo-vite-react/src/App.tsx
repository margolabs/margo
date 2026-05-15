import { useState } from 'react';

interface Tier {
  name: string;
  price: string;
  cadence: string;
  features: string[];
  cta: string;
  primary: boolean;
}

const INITIAL_TIERS: Tier[] = [
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

export default function App(): JSX.Element {
  const [tiers] = useState<Tier[]>(INITIAL_TIERS);

  return (
    <>
      <header>
        <h1>Acme Pricing · React Demo</h1>
        <nav>
          <a href="#features">Features</a>
          <a href="#pricing">Pricing</a>
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
          <div className="tiers">
            {tiers.map((tier) => (
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
