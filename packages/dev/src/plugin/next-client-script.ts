// <MargoScript /> — React component the user drops into their root layout.
// Emits a single <script type="module"> that lazy-imports the overlay bundle
// from /__margo/overlay.js. Renders null in production unless MARGO_ENABLED=1.
//
// Lives at margo-dev/next-client-script (separate subpath from the route
// handler at margo-dev/next-server). The earlier React-instance bug came
// from packing everything under one externalized export — the externalized
// React component resolved `react` from the package's own node_modules
// while Next SSR used next/dist/compiled/react, causing every page render
// to throw "A React Element from an older version of React was rendered."
// Keeping the component in its own subpath ensures it's bundled by Next
// (not externalized) and so its `react` import resolves to the same
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
