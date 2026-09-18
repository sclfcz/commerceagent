import { defineConfig, devices } from '@playwright/test';

const systemChromium = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    launchOptions: systemChromium
      ? { executablePath: systemChromium }
      : undefined,
  },
  projects: [
    {
      name: 'chromium-mobile',
      use: {
        ...devices['Pixel 7'],
        // Playwright's compact headless shell does not host Chromium's native
        // PDF viewer, so PDF iframe load/focus behaviour must run against the
        // full browser in CI. Local callers can still supply a system binary.
        ...(systemChromium ? {} : { channel: 'chromium' as const }),
      },
    },
  ],
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1',
    url: 'http://127.0.0.1:5173/tests/e2e/mobile-chat-harness.html',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
