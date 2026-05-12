// Scroll-tracking test for margo pins.
//
// Reproduces the bug where the pin dot stopped following its target as
// content scrolled. Two scenarios:
//
//   A) Inner-container scroll — a fixed-height card with `overflow-y: auto`.
//      A pin dropped on the wizard inside the card stays glued to its
//      original viewport spot pre-fix, drifting away from the wizard as
//      the card scrolls. This is the common case for app-shell layouts
//      where `html`/`body` don't scroll but a main pane does.
//
//   B) Document scroll — the same wizard pinned far down the page. With
//      `position: static` on the overlay root and `position: absolute`
//      children, document scroll *should* work without re-rendering, but
//      any layout where window.scrollY isn't the actual scroll source
//      (sticky headers shifting things, content async-loading above)
//      surfaces the same drift. Easiest test: scroll down and watch.
//
// To repro pre-fix: drop a pin on a step number; scroll. Pin drifts.
// Expected post-fix: pin tracks the step element on every scroll.

export default function ScrollTest() {
  return (
    <main style={{ padding: '32px 32px 600px', maxWidth: 960, margin: '0 auto' }}>
      <h1 style={{ fontSize: 24, fontWeight: 600, marginBottom: 8 }}>Scroll-tracking test</h1>
      <p style={{ color: '#6b7280', marginBottom: 24 }}>
        Pin a step number in either wizard below, then scroll. The pin should follow the target.
      </p>

      <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>A. Inner-container scroll</h2>
      <p style={{ color: '#6b7280', fontSize: 14, marginBottom: 8 }}>
        The card has its own scrollbar. The wizard is at the top of the card; scroll inside to move it.
      </p>
      <section
        data-testid="scroll-card"
        style={{
          border: '1px dashed #e2b53b',
          background: '#f0fbf2',
          borderRadius: 12,
          padding: 24,
          maxHeight: 260,
          overflowY: 'auto',
        }}
      >
        <Wizard />
        <FillerParagraphs count={6} />
      </section>

      <h2 style={{ fontSize: 16, fontWeight: 600, margin: '48px 0 12px' }}>B. Document scroll</h2>
      <p style={{ color: '#6b7280', fontSize: 14, marginBottom: 8 }}>
        The wizard below is at normal page flow. Scroll the page up/down — the pin should follow.
      </p>
      <FillerParagraphs count={8} />
      <section
        data-testid="page-flow-wizard"
        style={{
          border: '1px dashed #e2b53b',
          background: '#f0fbf2',
          borderRadius: 12,
          padding: 24,
        }}
      >
        <Wizard />
      </section>
      <FillerParagraphs count={12} />
    </main>
  );
}

// A 4-step horizontal progress bar matching the user's screenshot:
// numbered circles with labels, joined by dashed connectors. Step 1 is
// the "current" step, others greyed out.
function Wizard() {
  const steps = [
    { n: 1, label: 'Connect to Clusters', current: true },
    { n: 2, label: 'Assign Cluster Role' },
    { n: 3, label: 'Review' },
    { n: 4, label: 'Deploy' },
  ];
  return (
    <div>
      <h3 style={{ textAlign: 'center', fontSize: 18, fontWeight: 600 }}>Deployment</h3>
      <p style={{ textAlign: 'center', color: '#6b7280', fontSize: 13, margin: '6px 0 24px' }}>
        Connect your K8s clusters and assign each one a role. The FAIG Management Node will
        register each cluster after deployment.
      </p>
      <ol
        data-testid="wizard-steps"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          listStyle: 'none',
          padding: 0,
          margin: 0,
        }}
      >
        {steps.map((s, i) => (
          <li key={s.n} style={{ display: 'flex', alignItems: 'center', flex: i < steps.length - 1 ? 1 : 'initial' }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
              <div
                data-testid={`wizard-step-${s.n}`}
                aria-current={s.current ? 'step' : undefined}
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: s.current ? '#1f2937' : '#d1d5db',
                  color: s.current ? '#fff' : '#374151',
                  fontWeight: 600,
                }}
              >
                {s.n}
              </div>
              <span
                style={{
                  fontSize: 13,
                  fontWeight: s.current ? 600 : 400,
                  color: s.current ? '#111' : '#6b7280',
                  whiteSpace: 'nowrap',
                }}
              >
                {s.label}
              </span>
            </div>
            {i < steps.length - 1 && (
              <div
                aria-hidden
                style={{
                  flex: 1,
                  borderTop: '2px dashed #d1d5db',
                  margin: '0 16px',
                  alignSelf: 'flex-start',
                  marginTop: 18,
                }}
              />
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

function FillerParagraphs({ count }: { count: number }) {
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <p key={i} style={{ color: '#6b7280', fontSize: 14, margin: '12px 0' }}>
          Filler paragraph {i + 1}. Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do
          eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis
          nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.
        </p>
      ))}
    </>
  );
}
