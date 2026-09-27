import type { Page } from 'playwright';
import { SecurityChallengeError } from '../../types';
import { logger } from '../../logger';
import { INSTAGRAM_ORIGIN, SELECTORS } from './selectors';

export function isSecurityChallengeUrl(url: string): boolean {
  return (
    url.includes('/challenge/') ||
    url.includes('/auth_platform/') ||
    url.includes('/recaptcha')
  );
}

/**
 * Returns a human-readable reason if a security surface is visible.
 * Does not throw — used when we want to pause for manual completion.
 */
export async function detectSecurityChallenge(page: Page): Promise<string | null> {
  const url = page.url();

  if (isSecurityChallengeUrl(url)) {
    return `Instagram security / CAPTCHA page is open (${url.split('?')[0]}). Complete it manually in the browser.`;
  }

  const captcha = page.locator(SELECTORS.security.captchaIframe).first();
  if (await captcha.isVisible().catch(() => false)) {
    return 'CAPTCHA / bot-check is visible. Complete it manually in the browser.';
  }

  const challenge = page.locator(SELECTORS.security.challengeText).first();
  if (await challenge.isVisible().catch(() => false)) {
    const text = (await challenge.textContent().catch(() => ''))?.trim() ?? '';
    return `Instagram security / unusual-activity warning: "${text.slice(0, 160)}". Complete it manually if shown.`;
  }

  const suspended = page.locator(SELECTORS.security.accountsSuspended).first();
  if (await suspended.isVisible().catch(() => false)) {
    return 'Account restriction / suspension message detected.';
  }

  return null;
}

/**
 * Detect Instagram security surfaces from the visible page and stop.
 * Never attempts to solve or bypass challenges.
 */
export async function assertNoSecurityChallenge(page: Page): Promise<void> {
  const reason = await detectSecurityChallenge(page);
  if (reason) {
    throw new SecurityChallengeError(
      `${reason} Workflow stopped — the browser will stay open so you can finish verification, then click Start again.`,
    );
  }
}

export async function dismissCommonDialogs(page: Page): Promise<void> {
  // Escape closes many Instagram overlays that intercept clicks
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Escape').catch(() => undefined);
    await page.waitForTimeout(200);
  }

  const candidates = [
    SELECTORS.notNowButton,
    SELECTORS.dismissButton,
    'button:has-text("OK")',
    'div[role="button"]:has-text("OK")',
    'button:has-text("Cancel")',
  ];

  for (const sel of candidates) {
    const buttons = page.locator(sel);
    const count = await buttons.count().catch(() => 0);
    for (let i = 0; i < Math.min(count, 3); i++) {
      const btn = buttons.nth(i);
      if (await btn.isVisible().catch(() => false)) {
        logger.info(`Dismissing overlay via: ${sel}`);
        await btn.click({ force: true, timeout: 3_000 }).catch(() => undefined);
        await page.waitForTimeout(400);
      }
    }
  }

  // Notification prompts often sit as a full-screen/role=button layer
  if (await page.locator(SELECTORS.notificationDialog).first().isVisible().catch(() => false)) {
    const notNow = page.locator(SELECTORS.notNowButton).first();
    if (await notNow.isVisible().catch(() => false)) {
      await notNow.click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(400);
    } else {
      await page.keyboard.press('Escape').catch(() => undefined);
    }
  }
}

export async function isLoginPage(page: Page): Promise<boolean> {
  const url = page.url();
  if (url.includes('/accounts/login')) {
    return true;
  }
  const login = page.locator(SELECTORS.loginForm).first();
  return login.isVisible().catch(() => false);
}

export async function appearsLoggedIn(page: Page): Promise<boolean> {
  const url = page.url();
  if (await isLoginPage(page)) return false;
  if (isSecurityChallengeUrl(url)) return false;
  if (await detectSecurityChallenge(page)) return false;

  const home = page.locator(SELECTORS.homeFeedHint).first();
  if (await home.isVisible().catch(() => false)) return true;

  // Feed / app shell without login form (avoid cookie-only false positives during CAPTCHA)
  if (url.includes('instagram.com') && !url.includes('/accounts/')) {
    const main = page.locator('main').first();
    if (await main.isVisible().catch(() => false)) return true;
  }
  return false;
}

/**
 * Wait until the user is fully logged in.
 * Uses getPage() each loop so we survive Instagram closing/reopening tabs after sign-in.
 */
export async function waitForLoggedInSession(
  getPage: () => Page,
  options: {
    timeoutMs?: number;
    onWaiting?: () => void;
    onSecurityChallenge?: (reason: string) => void;
  } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 15 * 60_000;
  const started = Date.now();

  let page = getPage();
  await page.goto(INSTAGRAM_ORIGIN, { waitUntil: 'domcontentloaded' }).catch(() => undefined);

  let lastSecurityNote = '';
  let consecutiveOk = 0;

  while (Date.now() - started < timeoutMs) {
    try {
      page = getPage();
    } catch {
      options.onWaiting?.();
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }

    if (page.isClosed()) {
      options.onWaiting?.();
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }

    const security = await detectSecurityChallenge(page);
    if (security) {
      consecutiveOk = 0;
      if (security !== lastSecurityNote) {
        lastSecurityNote = security;
        logger.warn(
          `${security} Keep this window open and finish the check yourself — the agent is waiting.`,
        );
        options.onSecurityChallenge?.(security);
      }
      options.onWaiting?.();
      await page.waitForTimeout(2_000).catch(() => undefined);
      continue;
    }

    if (await appearsLoggedIn(page)) {
      consecutiveOk += 1;
      if (consecutiveOk >= 2) {
        logger.info('Instagram session appears logged in (stable)');
        await dismissCommonDialogs(page);
        return;
      }
      await page.waitForTimeout(1_200).catch(() => undefined);
      continue;
    }

    consecutiveOk = 0;
    options.onWaiting?.();
    logger.info('Waiting for manual Instagram login in the browser window...');
    await page.waitForTimeout(2_000).catch(() => undefined);
  }

  throw new Error(
    'Timed out waiting for Instagram login / security checks. Keep the browser open, finish any CAPTCHA, then try again.',
  );
}

/** Best-effort visible/cookie username — never a password. */
export async function readLoggedInUsername(page: Page): Promise<string | null> {
  try {
    const cookies = await page.context().cookies(INSTAGRAM_ORIGIN);
    const dsUser = cookies.find((c) => c.name === 'ds_user');
    if (dsUser?.value) {
      return decodeURIComponent(dsUser.value);
    }
  } catch {
    // ignore
  }

  try {
    const href = await page
      .locator('a[href^="/"][href$="/"]')
      .evaluateAll((anchors) => {
        const reserved = new Set([
          'explore',
          'reels',
          'direct',
          'accounts',
          'stories',
          'p',
          'reel',
          'tags',
        ]);
        for (const a of anchors) {
          const hrefAttr = a.getAttribute('href') || '';
          const m = hrefAttr.match(/^\/([A-Za-z0-9._]+)\/$/);
          if (m && !reserved.has(m[1].toLowerCase())) {
            const label = (a.getAttribute('aria-label') || '').toLowerCase();
            if (label.includes('profile') || a.querySelector('img')) {
              return m[1];
            }
          }
        }
        return null;
      })
      .catch(() => null);
    if (href) return href;
  } catch {
    // ignore
  }
  return null;
}
