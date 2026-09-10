/** @type {import('next').NextConfig} */
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:4000';

const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    // Same-origin proxy: the browser (and the legacy app iframe/page) call
    // /api/* on :3000 and Next forwards to the Express backend on :4000.
    return [
      {
        source: '/api/:path*',
        destination: `${BACKEND_URL}/api/:path*`,
      },
    ];
  },
  async headers() {
    // The 3D renderer is a standalone module loaded by legacy.html. Never
    // allow an earlier, partially loaded version to remain in a browser cache:
    // a stale module parse error prevents the entire warehouse view from booting.
    return [
      {
        source: '/loc3d.js',
        headers: [{ key: 'Cache-Control', value: 'no-store, max-age=0' }],
      },
    ];
  },
};

module.exports = nextConfig;
