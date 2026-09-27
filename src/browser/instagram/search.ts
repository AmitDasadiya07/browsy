import type { Page } from 'playwright';
import { logger } from '../../logger';
import { INSTAGRAM_ORIGIN, SELECTORS } from './selectors';
import { assertNoSecurityChallenge, dismissCommonDialogs } from './security';

export interface SearchHit {
  username: string;
  profileUrl: string;
  label: string;
}

function sleep(page: Page, ms: number): Promise<void> {
  return page.waitForTimeout(ms);
}

async function safeClick(page: Page, locator: ReturnType<Page['locator']>): Promise<boolean> {
  try {
    await locator.click({ timeout: 4_000 });
    return true;
  } catch {
    try {
      await locator.click({ force: true, timeout: 4_000 });
      return true;
    } catch {
      return false;
    }
  }
}

async function openSearchPanel(page: Page): Promise<void> {
  await assertNoSecurityChallenge(page);
  await dismissCommonDialogs(page);

  // Left-nav Search control (icon or link)
  const searchTriggers = [
    page.locator('a').filter({ has: page.locator('svg[aria-label="Search"]') }).first(),
    page.locator('span').filter({ hasText: /^Search$/ }).first(),
    page.locator('svg[aria-label="Search"]').first(),
    page.locator(SELECTORS.searchNav).first(),
  ];

  for (const trigger of searchTriggers) {
    if (await trigger.isVisible().catch(() => false)) {
      if (await safeClick(page, trigger)) {
        await sleep(page, 700);
        await dismissCommonDialogs(page);
        return;
      }
    }
  }

  logger.warn('Could not click Search control — will try search input / URL fallback');
}

async function findSearchInput(page: Page) {
  const input = page.locator(SELECTORS.searchInput).first();
  await input.waitFor({ state: 'visible', timeout: 12_000 });
  return input;
}

/**
 * Focus + type into search without getting blocked by overlay intercepts.
 */
async function typeIntoSearch(page: Page, query: string): Promise<void> {
  await dismissCommonDialogs(page);
  const input = await findSearchInput(page);

  // Prefer fill (less click-sensitive); fall back to force-click + keyboard
  try {
    await input.click({ force: true, timeout: 5_000 });
  } catch {
    await input.focus({ timeout: 5_000 }).catch(() => undefined);
  }

  await input.fill('');
  await input.fill(query);
  // Some IG builds need input events via typing
  const current = await input.inputValue().catch(() => '');
  if (current !== query) {
    await page.keyboard.type(query, { delay: 35 });
  }
  await sleep(page, 2_000);
}

/**
 * Search Instagram via the visible search UI and collect profile result links.
 */
export async function searchProfiles(
  page: Page,
  query: string,
  maxResults: number,
): Promise<SearchHit[]> {
  logger.info(`Searching Instagram for: "${query}"`);
  await assertNoSecurityChallenge(page);
  await dismissCommonDialogs(page);

  // Stable home shell first
  if (!page.url().startsWith(INSTAGRAM_ORIGIN)) {
    await page.goto(INSTAGRAM_ORIGIN, { waitUntil: 'domcontentloaded' });
  } else if (!page.url().includes('/accounts/')) {
    // Soft refresh home to clear sticky overlays
    await page.goto(`${INSTAGRAM_ORIGIN}/`, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
  }
  await dismissCommonDialogs(page);
  await assertNoSecurityChallenge(page);

  let typed = false;
  try {
    await openSearchPanel(page);
    await typeIntoSearch(page, query);
    typed = true;
  } catch (err) {
    logger.warn(`Primary search UI failed (${String(err)}) — trying explore search URL`);
  }

  if (!typed) {
    const encoded = encodeURIComponent(query);
    // Visible Instagram explore/search page (normal navigation, not a private API)
    await page.goto(`${INSTAGRAM_ORIGIN}/explore/search/keyword/?q=${encoded}`, {
      waitUntil: 'domcontentloaded',
    });
    await assertNoSecurityChallenge(page);
    await dismissCommonDialogs(page);
    try {
      await typeIntoSearch(page, query);
      typed = true;
    } catch (err) {
      logger.warn(`Search input still blocked after URL fallback: ${String(err)}`);
    }
  }

  // Last resort: open search panel again and use keyboard only
  if (!typed) {
    await dismissCommonDialogs(page);
    await openSearchPanel(page);
    await page.keyboard.type(query, { delay: 40 });
    await sleep(page, 2_000);
  }

  await assertNoSecurityChallenge(page);
  await dismissCommonDialogs(page);

  const hits = await collectVisibleProfileResults(page, maxResults);
  if (hits.length === 0) {
    logger.warn(`No visible profile results for query "${query}"`);
  } else {
    logger.info(`Found ${hits.length} visible profile result(s) for "${query}"`);
  }
  return hits;
}

async function collectVisibleProfileResults(page: Page, maxResults: number): Promise<SearchHit[]> {
  const anchors = page.locator('a[href^="/"]');
  const count = await anchors.count();
  const seen = new Set<string>();
  const hits: SearchHit[] = [];

  const reserved = new Set([
    'explore',
    'reels',
    'direct',
    'stories',
    'accounts',
    'about',
    'legal',
    'privacy',
    'p',
    'tv',
    'reel',
    'tags',
    'locations',
    'directory',
    'web',
    'nametag',
    'emailsignup',
    'challenge',
    'auth_platform',
  ]);

  for (let i = 0; i < count && hits.length < maxResults; i++) {
    const a = anchors.nth(i);
    const href = await a.getAttribute('href').catch(() => null);
    if (!href) continue;

    const match = href.match(/^\/([A-Za-z0-9._]+)\/?$/);
    if (!match) continue;
    const username = match[1];
    if (!username || reserved.has(username.toLowerCase())) continue;
    if (seen.has(username.toLowerCase())) continue;

    const label = ((await a.innerText().catch(() => '')) || username).trim().replace(/\s+/g, ' ');
    seen.add(username.toLowerCase());
    hits.push({
      username,
      profileUrl: `${INSTAGRAM_ORIGIN}/${username}/`,
      label,
    });
  }

  return hits;
}

export async function openProfile(page: Page, profileUrl: string, settleMs: number): Promise<void> {
  logger.info(`Opening profile: ${profileUrl}`);
  await page.goto(profileUrl, { waitUntil: 'domcontentloaded' });
  await assertNoSecurityChallenge(page);
  await dismissCommonDialogs(page);
  await page.waitForTimeout(settleMs);

  const main = page.locator('main, header').first();
  const visible = await main.isVisible().catch(() => false);
  if (!visible) {
    throw new Error(`Profile did not load visibly: ${profileUrl}`);
  }
  await assertNoSecurityChallenge(page);
}
