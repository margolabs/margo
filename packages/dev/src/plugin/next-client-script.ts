// <MargoScript /> — async React Server Component the user drops into
// their root layout. Emits a single <script type="module"> that
// lazy-imports the overlay bundle from /__margo/overlay.js. Renders
// null in production unless MARGO_ENABLED=1.
//
// Lives at margo-dev/next-client-script (separate subpath from the
// route handler at margo-dev/next-server). The earlier React-instance
// bug came from packing everything under one externalized export — the
// externalized React component resolved `react` from the package's own
// node_modules while Next SSR used next/dist/compiled/react, causing
// every page render to throw "A React Element from an older version of
// React was rendered." Keeping the component in its own subpath ensures
// it's bundled by Next (not externalized) and so its `react` import
// resolves to the same compiled React Next is using for rendering.

import { createElement, type ReactElement } from 'react';

function isDev(): boolean {
  return process.env.NODE_ENV !== 'production';
}

// CSP support is automatic: any app whose middleware sets a per-request
// nonce on the `x-nonce` request header (the convention Next's docs
// + community examples use) gets it threaded onto the <script> tag
// without the user touching their layout. Pass `nonce` explicitly to
// override (e.g. a project using a different header name).
//
// `storage` lets the overlay pick the right boot screen (sign-in pill
// vs no-op fallback) before /__margo/me lands — a network blip or
// plugin restart must not degrade a server-mode workspace into a
// local-mode UX. Optional; if omitted the overlay falls back to
// detecting mode from /__margo/me.
export interface MargoScriptProps {
  nonce?: string;
  storage?: 'standalone' | 'server';
}

export async function MargoScript({ nonce, storage }: MargoScriptProps = {}): Promise<ReactElement | null> {
  if (!isDev() && process.env.MARGO_ENABLED !== '1') return null;
  const mode = isDev() ? 'dev' : 'preview';
  const resolvedNonce = nonce ?? await tryReadCspNonce();
  const bootstrap = `(async () => {
    const mod = await import('/__margo/overlay.js');
    mod.start({ mode: ${JSON.stringify(mode)} });
  })().catch((err) => console.warn('[margo] failed to start overlay', err));`;
  const attrs: Record<string, unknown> = {
    type: 'module',
    nonce: resolvedNonce,
    'data-margo': '',
    'data-margo-mode': mode,
    dangerouslySetInnerHTML: { __html: bootstrap },
  };
  if (storage === 'standalone' || storage === 'server') {
    attrs['data-margo-storage'] = storage;
  }
  return createElement('script', attrs);
}

/** Auto-read the CSP nonce from the `x-nonce` request header — the
 *  convention Next's strict-dynamic docs and most middleware examples
 *  use. Swallows errors so consumers without a Next request context
 *  (Pages Router shims, unit tests) don't crash; they just render
 *  without a nonce, matching pre-auto-nonce behavior. */
async function tryReadCspNonce(): Promise<string | undefined> {
  try {
    // Dynamic import so the module only loads in Next App Router
    // contexts. The static-analysis import would force `next` as a
    // hard runtime resolution for every consumer of the subpath, but
    // the dynamic form is invisible to bundlers' static walk — same
    // trick the config loader uses for esbuild.
    const dynamicImport = new Function('m', 'return import(m)') as (m: string) => Promise<{ headers: () => Promise<{ get(name: string): string | null }> }>;
    const mod = await dynamicImport('next/headers');
    const h = await mod.headers();
    return h.get('x-nonce') ?? undefined;
  } catch {
    return undefined;
  }
}
