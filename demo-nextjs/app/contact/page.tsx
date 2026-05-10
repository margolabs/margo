export default function ContactPage() {
  return (
    <main className="demo-page">
      <h1>Get in touch</h1>
      <p className="demo-lead">
        Questions, feedback, or just curious? Reach us — a real person reads
        every email.
      </p>
      <section className="demo-card">
        <h2>Email</h2>
        <p>
          Drop a line at{" "}
          <a href="mailto:hello@acme.example">hello@acme.example</a>. We answer
          within one business day.
        </p>
      </section>
      <section className="demo-card">
        <h2>Office hours</h2>
        <p>
          Tuesdays at 10am PT — open Zoom, no agenda needed. Bring questions,
          show us your setup, or just say hi.
        </p>
        <button className="demo-cta" data-testid="cta-contact">
          Add to calendar
        </button>
      </section>
    </main>
  );
}
