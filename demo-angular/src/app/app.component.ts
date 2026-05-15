import { Component, signal } from '@angular/core';
import { NgFor, NgClass, NgIf } from '@angular/common';

interface Tier {
  name: string;
  price: string;
  cadence: string;
  features: string[];
  cta: string;
  primary: boolean;
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [NgFor, NgIf, NgClass],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css',
})
export class AppComponent {
  tiers = signal<Tier[]>([
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
}
