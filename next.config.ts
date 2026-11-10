import type { NextConfig } from 'next';

const config: NextConfig = {
  output: 'standalone',
  outputFileTracingIncludes: {'/*': [
    './src/reports/xlsx-worker.mjs',
    './node_modules/write-excel-file/**/*', './node_modules/csv-parse/**/*',
    './node_modules/.pnpm/write-excel-file@*/node_modules/**/*',
    './node_modules/.pnpm/csv-parse@*/node_modules/**/*',
    './node_modules/.pnpm/fflate@*/node_modules/**/*'
  ]},
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'no-referrer' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
      { key: 'Content-Security-Policy', value: "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" }
    ] }];
  }
};
export default config;
