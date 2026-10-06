import { execFileSync } from 'node:child_process';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Binds to 127.0.0.1 only, as the real app does (FR-3.3, NF-1). In development /api goes to the
// development server on 4318, same-origin; the proxy adds the bearer token, read from the
// Keychain where that server keeps it, so the token is never in the page.

const DEV_SERVER = 'http://127.0.0.1:4318';
let token: string | undefined;

function devToken(): string | undefined {
  if (token) return token;
  try {
    token = execFileSync('/usr/bin/security', ['find-generic-password', '-s', 'com.polestar.workos', '-a', 'api-token-dev', '-w'], { encoding: 'utf8', timeout: 5000 }).trim();
  } catch {
    // The development server hasn't run yet, so it has made no token. Try again next request.
  }
  return token;
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: DEV_SERVER,
        configure: (proxy) => {
          proxy.on('proxyReq', (req) => {
            const t = devToken();
            if (t) req.setHeader('authorization', `Bearer ${t}`);
          });
        },
      },
    },
  },
  preview: { host: '127.0.0.1', port: 4391, strictPort: true },
});
