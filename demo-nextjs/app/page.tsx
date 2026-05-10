export default function Home() {
  return (
    <main className="demo-page">
      <h1>Welcome to Acme</h1>
      <p className="demo-lead">
        We cut the boring parts of running a small team — billing, contracts,
        payroll — into one quiet workflow. More time on the work that
        actually pays.
      </p>
      <section className="demo-card" id="features">
        <h2>Built for small teams</h2>
        <p>
          Three to thirty people. Designed so a designer, a PM, and a dev can
          share one workspace without anyone needing a meeting to make a
          decision.
        </p>
        <button className="demo-cta" data-testid="cta-home">
          Try Acme free
        </button>
      </section>
      <section className="demo-card" id="trusted">
        <h2>Trusted by teams shipping things</h2>
        <p>
          From two-person studios to ten-person SaaS companies, Acme is the
          quiet operations layer behind their day.
        </p>
      </section>
    </main>
  );
}
