/**
 * LinkedIn security / challenge detection.
 * Never attempts to bypass — immediately surfaces any challenge to the user.
 */

import type { Page } from 'playwright';
import { SecurityChallengeError } from '../../types';
import { logger } from '../../logger';
import { LINKEDIN_ORIGIN, LI_SELECTORS } from './selectors';

export function isLinkedInChallengeUrl(url: string): boolean {
  return (
    url.includes('/checkpoint/') ||
    url.includes('/challenge/') ||
    url.includes('/security/') ||
    url.includes('/authwall') ||
    url.includes('/uas/login')
  );
}

/**
 * Returns a human-readable reason if a LinkedIn security/challenge surface is visible.
 * Does NOT throw — caller decides whether to throw or just log.
 */
export async function detectLinkedInChallenge(page: Page): Promise<string | null> {
  const url = page.url();

  if (isLinkedInChallengeUrl(url)) {
    return `LinkedIn security/verification page detected (${url.split('?')[0]}). Complete it manually — browser stays open.`;
  }

  // Captcha iframe
  try {
    const captcha = page.locator(LI_SELECTORS.security.captchaIframe).first();
    if (await captcha.isVisible({ timeout: 1500 })) {
      return 'CAPTCHA / bot-check is visible on LinkedIn. Complete it manually.';
    }
  } catch {
    // timeout — not present
  }

  // Challenge text
  try {
    const challengeEl = page.locator(LI_SELECTORS.security.challengeText).first();
    if (await challengeEl.isVisible({ timeout: 1500 })) {
      const text = (await challengeEl.textContent().catch(() => ''))?.trim() ?? '';
      return `LinkedIn security warning: "${text.slice(0, 160)}". Complete it manually.`;
    }
  } catch {
    // not present
  }

  // Restriction text
  try {
    const restrictEl = page.locator(LI_SELECTORS.security.restrictionText).first();
    if (await restrictEl.isVisible({ timeout: 1500 })) {
      return 'LinkedIn account restriction/limit message detected. Manual review needed.';
    }
  } catch {
    // not present
  }

  return null;
}

/**
 * Assert no challenge — throw SecurityChallengeError if one is detected.
 */
export async function assertNoLinkedInChallenge(page: Page): Promise<void> {
  const reason = await detectLinkedInChallenge(page);
  if (reason) {
    throw new SecurityChallengeError(
      `${reason} LinkedIn workflow stopped — browser stays open. Resolve the check manually, then restart.`,
    );
  }
}

export async function linkedInAppearsLoggedIn(page: Page): Promise<boolean> {
  const url = page.url();
  if (isLinkedInChallengeUrl(url)) return false;
  if (url.includes('/login') || url.includes('/uas/')) return false;
  try {
    const feed = page.locator(LI_SELECTORS.feedIndicator).first();
    if (await feed.isVisible({ timeout: 3000 })) return true;
  } catch {
    // not visible
  }
  // heuristic: on linkedin.com and not on login/challenge
  return url.includes('linkedin.com') && !url.includes('/login') && !url.includes('/uas/');
}

export async function waitForLinkedInLogin(
  getPage: () => Page,
  options: {
    timeoutMs?: number;
    onWaiting?: () => void;
    onChallenge?: (reason: string) => void;
  } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 15 * 60_000;
  const started = Date.now();

  let page = getPage();
  await page
    .goto(LINKEDIN_ORIGIN, { waitUntil: 'domcontentloaded' })
    .catch(() => undefined);

  let lastChallenge = '';
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

    const challenge = await detectLinkedInChallenge(page);
    if (challenge) {
      consecutiveOk = 0;
      if (challenge !== lastChallenge) {
        lastChallenge = challenge;
        logger.warn(`[LinkedIn] ${challenge} Waiting for user to resolve.`);
        options.onChallenge?.(challenge);
      }
      options.onWaiting?.();
      await page.waitForTimeout(2000).catch(() => undefined);
      continue;
    }

    if (await linkedInAppearsLoggedIn(page)) {
      consecutiveOk += 1;
      if (consecutiveOk >= 2) {
        logger.info('[LinkedIn] Session appears logged in (stable)');
        return;
      }
      await page.waitForTimeout(1200).catch(() => undefined);
      continue;
    }

    consecutiveOk = 0;
    options.onWaiting?.();
    logger.info('[LinkedIn] Waiting for manual LinkedIn login in the browser...');
    await page.waitForTimeout(2000).catch(() => undefined);
  }

  throw new Error('Timed out waiting for LinkedIn login. Keep the browser open and try again.');
}
