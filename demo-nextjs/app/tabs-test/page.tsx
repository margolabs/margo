'use client';

// Tabs test page for margo's view-context disambiguation fix.
//
// Scenario: two tabs ("Plans" and "Features") whose panels share structure
// and share short labels (both have a "Custom" entry, both have buttons
// labeled "Start free"). Without the view-context fix, a comment dropped
// on the Plans → Enterprise "Custom" card would also surface as a pin on
// the Features → "Custom plans" entry after a tab switch, because the
// selector + text + role we capture cannot tell the two tabs apart.
//
// The proper ARIA below (role="tablist", role="tab", role="tabpanel" +
// aria-labelledby) is what margo's captureViewContext() reads at pin time.
// The inactive panel uses the `hidden` attribute so both panels exist in
// the DOM but only the active one is rendered — the most common pattern
// for tabs and also the harder case for the resolver (a React-unmount
// pattern would dispose the off-panel content and the bug wouldn't trigger).

import { useState } from 'react';

type Tab = 'plans' | 'features';

export default function TabsTestPage() {
  const [tab, setTab] = useState<Tab>('plans');

  return (
    <main style={{ maxWidth: 900, margin: '40px auto', padding: '0 24px' }}>
      <h1>Tabs test (margo view-context)</h1>
      <p style={{ color: '#555', marginBottom: 24 }}>
        Two tab panels with the same structure. Drop a comment on the
        Enterprise &ldquo;Custom&rdquo; card in the Plans tab, then click
        Features. The pin should not jump to the Features tab&apos;s
        Custom entry. Switch back to Plans and the pin should reappear.
      </p>

      <div
        role="tablist"
        aria-label="Pricing views"
        style={{ display: 'flex', gap: 8, borderBottom: '1px solid #ddd', marginBottom: 16 }}
      >
        <button
          id="tab-plans"
          role="tab"
          aria-selected={tab === 'plans'}
          aria-controls="panel-plans"
          onClick={() => setTab('plans')}
          style={tabBtn(tab === 'plans')}
        >
          Plans
        </button>
        <button
          id="tab-features"
          role="tab"
          aria-selected={tab === 'features'}
          aria-controls="panel-features"
          onClick={() => setTab('features')}
          style={tabBtn(tab === 'features')}
        >
          Features
        </button>
      </div>

      <div
        role="tabpanel"
        id="panel-plans"
        aria-labelledby="tab-plans"
        hidden={tab !== 'plans'}
      >
        <section style={tierRow}>
          <article style={tier} data-testid="plans-starter">
            <h2>Starter</h2>
            <p style={price}>$0<span style={priceUnit}>/month</span></p>
            <ul>
              <li>Up to 3 seats</li>
              <li>Unlimited comments</li>
              <li>Community support</li>
            </ul>
            <button style={cta} data-testid="plans-cta-starter">Start free</button>
          </article>
          <article style={tier} data-testid="plans-team">
            <h2>Team</h2>
            <p style={price}>$12<span style={priceUnit}>/seat / mo</span></p>
            <ul>
              <li>Unlimited seats</li>
              <li>SSO + audit log</li>
              <li>Priority support</li>
            </ul>
            <button style={cta} data-testid="plans-cta-team">Start free trial</button>
          </article>
          <article style={tier} data-testid="plans-enterprise">
            <h2>Enterprise</h2>
            <p style={price}>Custom<span style={priceUnit}></span></p>
            <ul>
              <li>SLA</li>
              <li>Dedicated infra</li>
              <li>On-prem option</li>
            </ul>
            <button style={cta} data-testid="plans-cta-enterprise">Talk to sales</button>
          </article>
        </section>
      </div>

      <div
        role="tabpanel"
        id="panel-features"
        aria-labelledby="tab-features"
        hidden={tab !== 'features'}
      >
        <section style={tierRow}>
          <article style={tier} data-testid="features-billing">
            <h2>Billing</h2>
            <p style={price}>Auto<span style={priceUnit}>+ invoices</span></p>
            <ul>
              <li>Stripe-backed</li>
              <li>Refunds in one click</li>
              <li>Tax handling</li>
            </ul>
            <button style={cta} data-testid="features-cta-billing">Start free</button>
          </article>
          <article style={tier} data-testid="features-reports">
            <h2>Reports</h2>
            <p style={price}>Weekly<span style={priceUnit}>summaries</span></p>
            <ul>
              <li>Email digests</li>
              <li>Trend charts</li>
              <li>Export CSV</li>
            </ul>
            <button style={cta} data-testid="features-cta-reports">Start free trial</button>
          </article>
          <article style={tier} data-testid="features-integrations">
            <h2>Integrations</h2>
            <p style={price}>Custom<span style={priceUnit}></span></p>
            <ul>
              <li>Webhooks</li>
              <li>REST API</li>
              <li>Zapier</li>
            </ul>
            <button style={cta} data-testid="features-cta-integrations">Talk to sales</button>
          </article>
        </section>
      </div>
    </main>
  );
}

const tabBtn = (active: boolean): React.CSSProperties => ({
  padding: '10px 16px',
  border: 'none',
  borderBottom: active ? '2px solid #0070f3' : '2px solid transparent',
  background: 'transparent',
  fontWeight: active ? 600 : 400,
  cursor: 'pointer',
  fontSize: 16,
});

const tierRow: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr 1fr',
  gap: 16,
  padding: '8px 0',
};

const tier: React.CSSProperties = {
  border: '1px solid #e5e5e5',
  borderRadius: 12,
  padding: 20,
  background: 'white',
};

const price: React.CSSProperties = {
  fontSize: 28,
  fontWeight: 600,
  margin: '8px 0 16px',
};

const priceUnit: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 400,
  color: '#666',
  marginLeft: 4,
};

const cta: React.CSSProperties = {
  padding: '8px 14px',
  borderRadius: 8,
  border: '1px solid #0070f3',
  background: '#0070f3',
  color: 'white',
  fontWeight: 500,
  cursor: 'pointer',
};
