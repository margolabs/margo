import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@margo/dev"],
  // Margo's overlay fetches from /__margo/*, but Next.js treats any folder
  // prefixed with `_` as private (excluded from routing), so we host the
  // handler at /margo-runtime/* and rewrite the public URL to it. Users
  // never see /margo-runtime; clients always hit /__margo.
  async rewrites() {
    return [
      { source: "/__margo/:path*", destination: "/margo-runtime/:path*" },
    ];
  },
};

export default nextConfig;
