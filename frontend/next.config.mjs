/** @type {import('next').NextConfig} */
const backendTarget = (process.env.BACKEND_API_URL || (process.env.NEXT_PUBLIC_API_URL?.startsWith('http') ? process.env.NEXT_PUBLIC_API_URL : '') || 'http://localhost:5000').replace(/\/$/, '');

const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async rewrites() {
    return [{ source: '/api/proxy/:path*', destination: `${backendTarget}/:path*` }];
  },
};

export default nextConfig;

