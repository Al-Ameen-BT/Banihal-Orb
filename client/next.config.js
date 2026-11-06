/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  env: {
    NEXT_PUBLIC_PRODUCT_VERSION: require('./package.json').version,
  },

  // next/image serves the file as-is instead of resizing it through
  // /_next/image. Two static local PNGs are the ONLY consumers (the 36 KB
  // wordmark in BrandLogo and the 40px sidebar icon) — ticket attachments use a
  // plain <img>. Optimizing those two is not worth sharp: a ~35 MB native
  // dependency whose absence, in `output: 'standalone'`, does not degrade but
  // THROWS — Next 14.2 answers every /_next/image request with a 500. sharp was
  // present in the dev node_modules but never in package-lock.json, so `npm ci`
  // in Containerfile.web never installed it and the images 500'd only in the pod.
  // Keeping the optimizer off removes the dependency and the drift together.
  images: { unoptimized: true },

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
