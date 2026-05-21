<script setup lang="ts">
import { onMounted, ref } from 'vue';

type Tier = {
  name: string;
  price: string;
  cadence: string;
  features: string[];
  cta: string;
  primary: boolean;
};

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

const tiers = ref<Tier[]>([]);
const loading = ref(true);

const health = ref<'unknown' | 'ok' | 'down'>('unknown');

const email = ref('');
const submitting = ref(false);
const subscribeMessage = ref<{ kind: 'success' | 'warn' | 'error'; text: string } | null>(null);

onMounted(async () => {
  // Tiers
  try {
    const res = await fetch('/api/tiers');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { tiers: Tier[] };
    tiers.value = Array.isArray(data.tiers) ? data.tiers : FALLBACK_TIERS;
  } catch {
    tiers.value = FALLBACK_TIERS;
  } finally {
    loading.value = false;
  }

  // Health
  try {
    const res = await fetch('/api/health');
    health.value = res.ok ? 'ok' : 'down';
  } catch {
    health.value = 'down';
  }
});

async function onSubscribe() {
  if (submitting.value) return;
  submitting.value = true;
  subscribeMessage.value = null;
  try {
    const res = await fetch('/api/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.value }),
    });
    let payload: { id?: string; error?: string } = {};
    try {
      payload = (await res.json()) as { id?: string; error?: string };
    } catch {
      payload = {};
    }
    if (res.status === 201 && payload.id) {
      subscribeMessage.value = { kind: 'success', text: `Subscribed (id: ${payload.id})` };
      email.value = '';
    } else if (res.status === 400) {
      subscribeMessage.value = { kind: 'warn', text: payload.error ?? 'invalid request' };
    } else if (res.status === 500) {
      subscribeMessage.value = { kind: 'error', text: payload.error ?? 'server error' };
    } else {
      subscribeMessage.value = { kind: 'error', text: payload.error ?? `unexpected status ${res.status}` };
    }
  } catch {
    subscribeMessage.value = { kind: 'error', text: 'network error' };
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <header>
    <h1>Acme Pricing &middot; Vue Demo</h1>
    <nav>
      <a href="#features">Features</a>
      <a href="#pricing">Pricing</a>
      <a href="#contact">Contact</a>
      <span
        class="status"
        :class="{
          'status-ok': health === 'ok',
          'status-down': health === 'down',
          'status-unknown': health === 'unknown',
        }"
        data-testid="api-status"
      >
        <span class="status-dot" aria-hidden="true"></span>
        <span class="status-label">
          API: {{ health === 'ok' ? 'ok' : health === 'down' ? 'down' : '…' }}
        </span>
      </span>
    </nav>
  </header>
  <main>
    <section id="features" class="card">
      <h2>Why teams pick Acme</h2>
      <p>
        Acme cuts the boring parts of running a small team &mdash; billing, contracts, payroll &mdash;
        into one quiet workflow. More time on the work that actually pays.
      </p>
    </section>

    <section id="pricing" class="card">
      <h2>Pricing</h2>
      <p>Simple, predictable, and refundable in the first 30 days.</p>
      <div class="tiers" data-testid="tiers">
        <template v-if="loading">
          <article
            v-for="n in 3"
            :key="`skeleton-${n}`"
            class="tier tier-skeleton"
            data-testid="tier-skeleton"
            aria-busy="true"
          >
            <div class="skel skel-title"></div>
            <div class="skel skel-price"></div>
            <ul>
              <li><div class="skel skel-line"></div></li>
              <li><div class="skel skel-line"></div></li>
              <li><div class="skel skel-line"></div></li>
            </ul>
            <div class="skel skel-button"></div>
          </article>
        </template>
        <template v-else>
          <article
            v-for="tier in tiers"
            :key="tier.name"
            class="tier"
            :class="{ 'tier-highlight': tier.primary }"
          >
            <h3>{{ tier.name }}</h3>
            <p class="price">{{ tier.price }}<span v-if="tier.cadence">{{ tier.cadence }}</span></p>
            <ul>
              <li v-for="feature in tier.features" :key="feature">{{ feature }}</li>
            </ul>
            <button
              class="cta"
              :class="{ 'cta-secondary': !tier.primary }"
              :data-testid="tier.primary ? 'cta-primary' : `cta-${tier.name.toLowerCase()}`"
            >
              {{ tier.cta }}
            </button>
          </article>
        </template>
      </div>

      <form class="subscribe" @submit.prevent="onSubscribe" data-testid="subscribe-form">
        <label for="subscribe-email">Get product updates</label>
        <div class="subscribe-row">
          <input
            id="subscribe-email"
            type="email"
            v-model="email"
            placeholder="you@company.com"
            required
            data-testid="subscribe-email"
          />
          <button
            type="submit"
            class="cta"
            :disabled="submitting"
            data-testid="subscribe-submit"
          >
            {{ submitting ? 'Subscribing…' : 'Subscribe' }}
          </button>
        </div>
        <p
          v-if="subscribeMessage"
          class="subscribe-msg"
          :class="{
            'subscribe-msg-success': subscribeMessage.kind === 'success',
            'subscribe-msg-warn': subscribeMessage.kind === 'warn',
            'subscribe-msg-error': subscribeMessage.kind === 'error',
          }"
          data-testid="subscribe-msg"
        >
          {{ subscribeMessage.text }}
        </p>
      </form>
    </section>

    <section id="contact" class="card">
      <h2>Get in touch</h2>
      <p>Reach us at <a href="mailto:hello@acme.com">hello@acme.com</a>.</p>
    </section>
  </main>
</template>

<style scoped>
.status {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.85rem;
  margin-left: 0.75rem;
  color: #475569;
}
.status-dot {
  display: inline-block;
  width: 0.55rem;
  height: 0.55rem;
  border-radius: 50%;
  background: #cbd5e1;
}
.status-ok .status-dot {
  background: #16a34a;
  box-shadow: 0 0 0 2px rgba(22, 163, 74, 0.18);
}
.status-down .status-dot {
  background: #dc2626;
  box-shadow: 0 0 0 2px rgba(220, 38, 38, 0.18);
}
.status-ok .status-label { color: #166534; }
.status-down .status-label { color: #991b1b; }

.tier-skeleton {
  pointer-events: none;
}
.skel {
  background: linear-gradient(90deg, #e2e8f0 0%, #f1f5f9 50%, #e2e8f0 100%);
  background-size: 200% 100%;
  border-radius: 4px;
  animation: skel-shimmer 1.2s ease-in-out infinite;
}
.skel-title { height: 1.25rem; width: 45%; margin-bottom: 0.75rem; }
.skel-price { height: 1.75rem; width: 60%; margin-bottom: 1rem; }
.skel-line  { height: 0.85rem; width: 90%; }
.skel-button { height: 2.25rem; width: 100%; margin-top: 1rem; border-radius: 6px; }
.tier-skeleton ul { list-style: none; padding: 0; margin: 0 0 0.5rem; }
.tier-skeleton li { margin: 0.45rem 0; }

@keyframes skel-shimmer {
  0%   { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

.subscribe {
  margin-top: 1.5rem;
  padding-top: 1.25rem;
  border-top: 1px solid #e2e8f0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.subscribe label {
  font-size: 0.9rem;
  color: #334155;
}
.subscribe-row {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.subscribe-row input[type="email"] {
  flex: 1 1 220px;
  min-width: 0;
  padding: 0.55rem 0.7rem;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  font: inherit;
  background: #fff;
}
.subscribe-row input[type="email"]:focus {
  outline: none;
  border-color: #6366f1;
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.18);
}
.subscribe-row .cta:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.subscribe-msg {
  margin: 0.25rem 0 0;
  font-size: 0.9rem;
}
.subscribe-msg-success { color: #15803d; }
.subscribe-msg-warn    { color: #b45309; }
.subscribe-msg-error   { color: #b91c1c; }
</style>
