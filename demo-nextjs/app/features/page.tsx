const features = [
  {
    title: "Billing on autopilot",
    body: "Invoices land on time, late ones nudge themselves, refunds are one click. No more spreadsheet math.",
  },
  {
    title: "Contracts that sign themselves",
    body: "Templates with the right variables filled in by your CRM. Signed in the browser, archived in your repo.",
  },
  {
    title: "Payroll that respects time off",
    body: "PTO accrual, holiday pay, contractor invoices — one ledger, no surprises at month-end.",
  },
  {
    title: "Reports that read like sentences",
    body: "We write the summary, not the dashboard. Skim the week in 30 seconds.",
  },
];

export default function FeaturesPage() {
  return (
    <main className="demo-page">
      <h1>Features</h1>
      <p className="demo-lead">Everything a small team needs to stop touching spreadsheets.</p>
      <section className="demo-features">
        {features.map((f) => (
          <article key={f.title} className="demo-feature">
            <h2>{f.title}</h2>
            <p>{f.body}</p>
          </article>
        ))}
      </section>
    </main>
  );
}
