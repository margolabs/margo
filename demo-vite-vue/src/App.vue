<script setup lang="ts">
import { ref } from 'vue';

const tiers = ref([
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
]);
</script>

<template>
  <header>
    <h1>Acme Pricing · Vue Demo</h1>
    <nav>
      <a href="#features">Features</a>
      <a href="#pricing">Pricing</a>
      <a href="#contact">Contact</a>
    </nav>
  </header>
  <main>
    <section id="features" class="card">
      <h2>Why teams pick Acme</h2>
      <p>
        Acme cuts the boring parts of running a small team — billing, contracts, payroll —
        into one quiet workflow. More time on the work that actually pays.
      </p>
    </section>

    <section id="pricing" class="card">
      <h2>Pricing</h2>
      <p>Simple, predictable, and refundable in the first 30 days.</p>
      <div class="tiers">
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
      </div>
    </section>

    <section id="contact" class="card">
      <h2>Get in touch</h2>
      <p>Reach us at <a href="mailto:hello@acme.com">hello@acme.com</a>.</p>
    </section>
  </main>
</template>
