import { defineConfig, devices } from '@playwright/test';

// e2e runs against the production build served by `vite preview` (same bundle as GitHub Pages).
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          // Let two local WebRTC peers find each other via plain host candidates (no mDNS in CI).
          args: [
            '--disable-features=WebRtcHideLocalIpsWithMdns',
            '--autoplay-policy=no-user-gesture-required',
          ],
        },
      },
    },
  ],
  webServer: [
    {
      command: 'pnpm build && pnpm preview --host 127.0.0.1 --port 4173 --strictPort',
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      // Web seed + .torrent + magnet endpoints for e2e/fixtures, and a local WebSocket tracker.
      command: 'node e2e/support/fixture-server.mjs',
      url: 'http://127.0.0.1:9000/magnet/sample.mkv',
      reuseExistingServer: !process.env.CI,
    },
  ],
});
