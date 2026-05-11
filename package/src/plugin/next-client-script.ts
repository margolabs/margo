// <MargoScript /> — React component the user drops into their root layout.
// Emits a single <script type="module"> that lazy-imports the overlay bundle
// from /__margo/overlay.js. Renders null in production unless MARGO_ENABLED=1.
//
// This module lives at margo-dev/next/client-script (not margo-dev/next or
// margo-dev/next/server) for a specific reason: withMargo() externalizes
// margo-dev/next/server via Next.js's serverExternalPackages so chokidar/git
// can do `require()` at runtime instead of being bundled. But externalized
// modules resolve their own dependencies — including `react` — against the
// package's own node_modules, while Next's SSR pipeline uses
// next/dist/compiled/react. Two React instances collide and SSR throws
// digest:'…' / "A React Element from an older version of React was rendered."
//
// Keeping MargoScript in a sibling subpath that is NOT externalized lets
// Next bundle it normally, so its `react` import resolves to the same
// compiled React Next is using for rendering.

import { createElement, type ReactElement } from 'react';

function isDev(): boolean {
  return process.env.NODE_ENV !== 'production';
}

// CSP support: apps that set a Content-Security-Policy header with
// `strict-dynamic` + a nonce will block any inline <script> that lacks that
// nonce. Next.js does not auto-propagate the nonce — the layout must read it
// (typically from a middleware-set request header) and pass it through:
//
//   import { headers } from 'next/headers';
//   import { MargoScript } from 'margo-dev/next/client-script';
//
//   export default async function RootLayout({ children }) {
//     const nonce = (await headers()).get('x-nonce') ?? undefined;
//     return (
//       <html><body>{children}<MargoScript nonce={nonce} /></body></html>
//     );
//   }
//
// When `nonce` is undefined the script renders without the attribute, which
// is fine for apps that don't set a strict CSP (the historical behavior).
export interface MargoScriptProps {
  nonce?: string;
}

export function MargoScript({ nonce }: MargoScriptProps = {}): ReactElement | null {
  if (!isDev() && process.env.MARGO_ENABLED !== '1') return null;
  const mode = isDev() ? 'dev' : 'preview';
  const bootstrap = `(async () => {
    const mod = await import('/__margo/overlay.js');
    mod.start({ mode: ${JSON.stringify(mode)} });
  })().catch((err) => console.warn('[margo] failed to start overlay', err));`;
  return createElement('script', {
    type: 'module',
    nonce,
    'data-margo': '',
    'data-margo-mode': mode,
    dangerouslySetInnerHTML: { __html: bootstrap },
  });
}
