import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** A Chromium for rendering reports in tests: MERV_REPORTS_CHROMIUM, else Playwright's cache. */
export function reportBrowser(): string | undefined {
  if (process.env.MERV_REPORTS_CHROMIUM) return process.env.MERV_REPORTS_CHROMIUM;
  for (const cache of [
    join(homedir(), 'Library', 'Caches', 'ms-playwright'),
    join(homedir(), '.cache', 'ms-playwright'),
  ]) {
    if (!existsSync(cache)) continue;
    for (const dir of readdirSync(cache)
      .filter((d) => d.startsWith('chromium-'))
      .sort()
      .reverse()) {
      for (const app of [
        join(
          cache,
          dir,
          'chrome-mac-arm64',
          'Google Chrome for Testing.app',
          'Contents',
          'MacOS',
          'Google Chrome for Testing',
        ),
        join(
          cache,
          dir,
          'chrome-mac',
          'Google Chrome for Testing.app',
          'Contents',
          'MacOS',
          'Google Chrome for Testing',
        ),
        join(cache, dir, 'chrome-linux', 'chrome'),
        join(cache, dir, 'chrome-linux64', 'chrome'),
      ])
        if (existsSync(app)) return app;
    }
  }
  return undefined;
}
