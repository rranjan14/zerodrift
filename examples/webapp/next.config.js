/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // zerodrift is consumed from source via the tsconfig "paths" alias
  // (../../src), not from node_modules — nothing to transpile here.
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080",
    NEXT_PUBLIC_SSE_URL: process.env.NEXT_PUBLIC_SSE_URL || "http://localhost:8081",
  },
};

module.exports = nextConfig;
