/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // Emit .next/standalone — a self-contained server with only the node_modules it
  // actually imports. The container image copies that instead of the full
  // dependency tree. Harmless on the bare-metal deploy, which keeps running
  // `next start` against .next as before.
  output: 'standalone',

  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'}/api/:path*`,
      },
    ];
  },
};

module.exports = nextConfig;
