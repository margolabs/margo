export default function PricingPage() {
  return (
    <main className="demo-page">
      <h1>Pricing</h1>
      <p className="demo-lead">
        Simple, predictable, and refundable in the first 30 days.
      </p>
      <section className="demo-tiers">
        <article className="demo-tier">
          <h2>Starter</h2>
          <p className="demo-price">$0<span>/month</span></p>
          <ul>
            <li>Up to 3 seats</li>
            <li>Unlimited comments</li>
            <li>Community support</li>
          </ul>
          <button className="demo-cta demo-cta-secondary" data-testid="cta-starter">
            Start free
          </button>
        </article>
        <article className="demo-tier demo-tier-highlight">
          <h2>Team</h2>
          <p className="demo-price">$12<span>/seat / mo</span></p>
          <ul>
            <li>Unlimited seats</li>
            <li>SSO + audit log</li>
            <li>Priority support</li>
          </ul>
          <button className="demo-cta" data-testid="cta-primary">
            Start free trial
          </button>
        </article>
        <article className="demo-tier">
          <h2>Enterprise</h2>
          <p className="demo-price">Custom<span></span></p>
          <ul>
            <li>SLA</li>
            <li>Dedicated infra</li>
            <li>On-prem option</li>
          </ul>
          <button className="demo-cta demo-cta-secondary" data-testid="cta-enterprise">
            Talk to sales
          </button>
        </article>
      </section>
    </main>
  );
}
