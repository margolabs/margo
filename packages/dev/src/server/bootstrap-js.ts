// Shared bootstrap script served at `/__margo/bootstrap.js` from all
// three integration entry points (Vite plugin, Next.js plugin, and the
// `margo serve` sidecar). Users add ONE line to their HTML:
//
//   <script type="module" src="/__margo/bootstrap.js"></script>
//
// and the bootstrap dynamically imports the overlay bundle and starts
// it. This module was previously private to cli/serve.ts; lifting it
// up means a user who adopts the script-tag pattern doesn't have to
// remember which integration mode actually exposes the URL — all of
// them do now.
//
// Why an external script and not just inline? The script tag is
// stable across HMR / config reloads / hot-replaces of the overlay
// bundle. Inline scripts get re-injected on every transformIndexHtml
// pass, which can fire stale references. External `import()` always
// resolves against the current overlay file.
//
// Why hardcode mode='dev'? In a dev-server context (sidecar, vite
// configureServer, next dev) the user is always in dev mode. Preview
// builds (MARGO_ENABLED=1 on a deploy) use the inline injection paths
// in vite.ts and next-client-script.ts respectively, which thread the
// mode in at build time.

export const BOOTSTRAP_JS = `(async () => {
  try {
    const mod = await import('/__margo/overlay.js');
    mod.start({ mode: 'dev' });
  } catch (err) {
    console.warn('[margo] failed to start overlay', err);
  }
})();
`
