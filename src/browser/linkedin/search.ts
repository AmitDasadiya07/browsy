/**
 * LinkedIn people search using visible UI navigation only.
 * No private APIs used.
 */

import type { Page } from 'playwright';
import { logger } from '../../logger';
import { LI_SELECTORS, LINKEDIN_ORIGIN } from './selectors';
import { assertNoLinkedInChallenge } from './security';

export interface LinkedInSearchHit {
  profileUrl: string;
  profileId: string;
  name: string;
  subtitle: string;
}

export async function searchLinkedInPeople(
  page: Page,
  query: string,
  maxResults: number,
): Promise<LinkedInSearchHit[]> {
  logger.info(`[LinkedIn] Searching for: "${query}"`);
  await assertNoLinkedInChallenge(page);

  // Navigate to people search results using the visible LinkedIn search URL
  const encoded = encodeURIComponent(query);
  const searchUrl = `${LINKEDIN_ORIGIN}/search/results/people/?keywords=${encoded}&origin=GLOBAL_SEARCH_HEADER`;
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await assertNoLinkedInChallenge(page);

  const hits: LinkedInSearchHit[] = [];
  const seen = new Set<string>();

  // Collect from current page and paginate
  let pagesChecked = 0;
  const maxPages = Math.ceil(maxResults / 10) + 1;

  while (hits.length < maxResults && pagesChecked < maxPages) {
    await assertNoLinkedInChallenge(page);
    pagesChecked += 1;

    // Collect all /in/ links visible on the search results page
    const links = page.locator('a[href*="/in/"]');
    const count = await links.count().catch(() => 0);

    for (let i = 0; i < count && hits.length < maxResults; i++) {
      const a = links.nth(i);
      const href = await a.getAttribute('href').catch(() => null);
      if (!href || !href.includes('/in/')) continue;

      // Normalise to clean profile URL
      const clean = href.split('?')[0].replace(/\/$/, '');
      const match = clean.match(/\/in\/([^/]+)/);
      if (!match) continue;
      const profileId = match[1];
      if (!profileId || seen.has(profileId.toLowerCase())) continue;
      seen.add(profileId.toLowerCase());

      const profileUrl = clean.startsWith('http')
        ? clean
        : `${LINKEDIN_ORIGIN}${clean}`;

      // Try to get visible name text from sibling/parent span
      let name = profileId;
      let subtitle = '';
      try {
        // The link usually wraps or is near the name span
        const nameEl = a
          .locator('span[aria-hidden="true"]')
          .first();
        const nameText = await nameEl.innerText().catch(() => '');
        if (nameText.trim()) name = nameText.trim();

        // Parent li for subtitle
        const liEl = a.locator('..').locator('..').locator('..');
        const subEl = liEl
          .locator('.entity-result__primary-subtitle, .t-14.t-black.t-normal')
          .first();
        subtitle = (await subEl.innerText().catch(() => '')).trim();
      } catch {
        // fallback to profileId
      }

      hits.push({ profileUrl, profileId, name, subtitle });
    }

    // Try to go to next page if we haven't collected enough
    if (hits.length < maxResults && pagesChecked < maxPages) {
      const nextBtn = page.locator(LI_SELECTORS.searchPaginationNext).first();
      const nextVisible = await nextBtn.isVisible().catch(() => false);
      if (!nextVisible) break;
      await nextBtn.click().catch(() => undefined);
      await page.waitForTimeout(2500);
    } else {
      break;
    }
  }

  logger.info(`[LinkedIn] Found ${hits.length} visible result(s) for "${query}"`);
  return hits;
}
