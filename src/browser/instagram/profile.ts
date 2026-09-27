import type { Page } from 'playwright';
import type { ProfileSnapshot } from '../../types';
import { logger } from '../../logger';
import { SELECTORS } from './selectors';
import { assertNoSecurityChallenge } from './security';

function parseCount(raw: string): number | null {
  const cleaned = raw.replace(/,/g, '').trim().toLowerCase();
  if (!cleaned) return null;
  const match = cleaned.match(/^([\d.]+)\s*([kmb])?$/i);
  if (!match) {
    const digits = cleaned.replace(/[^\d]/g, '');
    return digits ? Number(digits) : null;
  }
  const base = Number(match[1]);
  if (Number.isNaN(base)) return null;
  const suffix = (match[2] ?? '').toLowerCase();
  const mult = suffix === 'k' ? 1_000 : suffix === 'm' ? 1_000_000 : suffix === 'b' ? 1_000_000_000 : 1;
  return Math.round(base * mult);
}

function firstNameFromDisplay(displayedName: string, username: string): string {
  const cleaned = displayedName.trim();
  if (!cleaned) return username;
  const first = cleaned.split(/\s+/)[0] ?? cleaned;
  return first.replace(/[^\p{L}\p{N}._'-]/gu, '') || username;
}

/**
 * Read visible profile attributes from the Instagram profile page UI.
 */
export async function readVisibleProfile(page: Page, profileUrl: string): Promise<ProfileSnapshot> {
  await assertNoSecurityChallenge(page);

  const username =
    new URL(profileUrl).pathname.split('/').filter(Boolean)[0] ??
    profileUrl;

  const pageText = (
    await page
      .locator('main')
      .innerText()
      .catch(async () => page.locator('body').innerText())
  ).slice(0, 8000);

  const isVerified =
    (await page.locator(SELECTORS.verifiedBadge).first().isVisible().catch(() => false)) ||
    /verified/i.test(
      (await page.locator('[aria-label="Verified"]').first().getAttribute('aria-label').catch(() => '')) ??
        '',
    );

  const isPrivate = await page
    .locator(SELECTORS.privateAccountText)
    .first()
    .isVisible()
    .catch(() => false);

  // Followers / following / posts from visible stat links/text
  let followers: number | null = null;
  let following: number | null = null;
  let posts: number | null = null;

  const stats = await page.evaluate(() => {
    const result = { followers: null as string | null, following: null as string | null, posts: null as string | null };
    const lis = Array.from(document.querySelectorAll('header li, main li, header ul li'));
    for (const li of lis) {
      const text = (li.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const numMatch = text.match(/([\d.,]+\s*[kmb]?)/i);
      if (!numMatch) continue;
      if (text.includes('follower')) result.followers = numMatch[1];
      else if (text.includes('following')) result.following = numMatch[1];
      else if (text.includes('post')) result.posts = numMatch[1];
    }

    // Fallback: aria labels like "12.3K followers"
    const labeled = Array.from(document.querySelectorAll('[title], span, a'));
    for (const el of labeled) {
      const t = `${el.getAttribute('title') || ''} ${el.textContent || ''}`.replace(/\s+/g, ' ').trim();
      const m = t.match(/([\d.,]+\s*[kmb]?)\s*followers?/i);
      if (m && !result.followers) result.followers = m[1];
      const m2 = t.match(/([\d.,]+\s*[kmb]?)\s*following/i);
      if (m2 && !result.following) result.following = m2[1];
      const m3 = t.match(/([\d.,]+\s*[kmb]?)\s*posts?/i);
      if (m3 && !result.posts) result.posts = m3[1];
    }
    return result;
  });

  followers = stats.followers ? parseCount(stats.followers) : null;
  following = stats.following ? parseCount(stats.following) : null;
  posts = stats.posts ? parseCount(stats.posts) : null;

  // Displayed name: usually near header; exclude username-only duplicates when possible
  let displayedName = await page.evaluate((user) => {
    const header = document.querySelector('header');
    if (!header) return '';
    const spans = Array.from(header.querySelectorAll('span, h1, h2'));
    const texts = spans
      .map((s) => (s.textContent || '').trim())
      .filter((t) => t && t.length < 80 && !/^[\d.,]+[kmb]?$/i.test(t));
    // Prefer a text that is not the username and not a meta label
    const skip = new Set(
      ['posts', 'followers', 'following', 'follow', 'message', 'edit profile', 'verified', user.toLowerCase()].map(
        (s) => s.toLowerCase(),
      ),
    );
    for (const t of texts) {
      if (!skip.has(t.toLowerCase()) && !/^\d/.test(t)) {
        return t;
      }
    }
    return texts[0] || user;
  }, username);

  if (!displayedName) {
    displayedName = username;
  }

  // Bio: grab header section text after name block — heuristic from visible text
  let bio = '';
  let locationText = '';
  const accountTypeHints: string[] = [];

  const bioCandidate = await page.evaluate(() => {
    const header = document.querySelector('header');
    if (!header) return { bio: '', hints: [] as string[] };
    const chunks = Array.from(header.querySelectorAll('span, div'))
      .map((el) => (el.textContent || '').trim())
      .filter((t) => t.length > 0 && t.length < 500);
    const unique = [...new Set(chunks)];
    const hints: string[] = [];
    for (const t of unique) {
      if (/professional dashboard|business|creator|digital creator|product\/service/i.test(t)) {
        hints.push(t);
      }
    }
    // Longest multi-word string that isn't a stat tends to be bio-ish
    const bioLike = unique
      .filter((t) => t.split(/\s+/).length >= 2)
      .filter((t) => !/followers?|following|posts?/i.test(t))
      .sort((a, b) => b.length - a.length)[0] || '';
    return { bio: bioLike, hints };
  });

  bio = bioCandidate.bio;
  accountTypeHints.push(...bioCandidate.hints);

  // Location sometimes appears as a link under bio
  const locationEl = page.locator('header a[href*="/locations/"], header a[href*="/explore/locations/"]').first();
  if (await locationEl.isVisible().catch(() => false)) {
    locationText = ((await locationEl.innerText().catch(() => '')) || '').trim();
  }
  if (!locationText) {
    // Fall back: scan bio / page text for common location-ish phrases later via keywords
    locationText = bio;
  }

  const snapshot: ProfileSnapshot = {
    profileUrl,
    username,
    displayedName,
    firstName: firstNameFromDisplay(displayedName, username),
    bio,
    followers,
    following,
    posts,
    isVerified,
    isPrivate: isPrivate ? true : isPrivate === false ? false : null,
    accountTypeHints,
    locationText,
  };

  logger.info(
    `Profile snapshot @${username}: name="${snapshot.displayedName}", followers=${snapshot.followers}, verified=${snapshot.isVerified}, private=${snapshot.isPrivate}`,
  );
  logger.debug(`Bio preview: ${bio.slice(0, 120)}`);
  logger.debug(`Page text length: ${pageText.length}`);

  return snapshot;
}

export async function hasVisibleMessageButton(page: Page): Promise<boolean> {
  for (const sel of SELECTORS.messageButtonCandidates) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible().catch(() => false)) {
      return true;
    }
  }
  return false;
}

export async function clickMessageButton(page: Page): Promise<void> {
  for (const sel of SELECTORS.messageButtonCandidates) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible().catch(() => false)) {
      logger.info(`Clicking Message button (${sel})`);
      await btn.click();
      return;
    }
  }
  throw new Error('Message button not found on visible profile UI');
}
