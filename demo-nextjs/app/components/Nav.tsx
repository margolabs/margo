import Link from "next/link";

const links = [
  { href: "/", label: "Home" },
  { href: "/pricing", label: "Pricing" },
  { href: "/features", label: "Features" },
  { href: "/contact", label: "Contact" },
  { href: "/tabs-test", label: "Tabs test" },
  { href: "/scroll-test", label: "Scroll test" },
];

export function Nav() {
  return (
    <nav className="margo-demo-nav">
      <strong className="margo-demo-brand">Acme</strong>
      <ul>
        {links.map((l) => (
          <li key={l.href}>
            <Link href={l.href}>{l.label}</Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
