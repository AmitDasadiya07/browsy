/**
 * Read visible LinkedIn profile data from the page DOM.
 * All data from visible UI only — no private APIs.
 */

import type { Page } from 'playwright';
import { logger } from '../../logger';
import { LI_SELECTORS } from './selectors';
import { assertNoLinkedInChallenge } from './security';

export interface LinkedInProfileSnapshot {
  profileUrl: string;
  profileId: string;
  name: string;
  firstName: string | null;
  headline: string | null;
  jobTitle: string | null;
  company: string | null;
  location: string | null;
  about: string | null;
  industry: string | null;
}

function firstWord(name: string): string | null {
  const cleaned = name.trim();
  if (!cleaned) return null;
  const parts = cleaned.split(/\s+/);
  return parts[0] || null;
}

export async function readLinkedInProfile(
  page: Page,
  profileUrl: string,
): Promise<LinkedInProfileSnapshot> {
  await assertNoLinkedInChallenge(page);

  const profileId =
    profileUrl.split('/in/')[1]?.replace(/\/$/, '').split('?')[0] ??
    profileUrl;

  const name =
    (await page.locator(LI_SELECTORS.profileName).first().innerText().catch(() => '')) ||
    profileId;

  const headline =
    (await page.locator(LI_SELECTORS.profileHeadline).first().innerText().catch(() => '')) ||
    null;

  const location =
    (await page.locator(LI_SELECTORS.profileLocation).first().innerText().catch(() => '')) ||
    null;

  // About section
  const about =
    (await page
      .locator(LI_SELECTORS.profileAboutText)
      .first()
      .innerText()
      .catch(() => '')) ||
    (await page
      .locator(LI_SELECTORS.profileAboutSection)
      .first()
      .innerText()
      .catch(() => '')) ||
    null;

  // Current job title / company from experience section
  const jobTitle =
    (await page
      .locator(LI_SELECTORS.profileFirstExperienceTitle)
      .first()
      .innerText()
      .catch(() => '')) || null;

  const company =
    (await page
      .locator(LI_SELECTORS.profileFirstExperienceCompany)
      .first()
      .innerText()
      .catch(() => '')) || null;

  const trimmedName = name.trim();
  const firstName = firstWord(trimmedName);

  // Industry hint from headline or page title
  const pageTitle = await page.title().catch(() => '');
  const industry =
    headline
      ? headline.split(' | ')[1]?.trim() || null
      : pageTitle.split(' | ')[1]?.trim() || null;

  const snapshot: LinkedInProfileSnapshot = {
    profileUrl,
    profileId,
    name: trimmedName,
    firstName,
    headline: headline?.trim() || null,
    jobTitle: jobTitle?.trim() || null,
    company: company?.trim() || null,
    location: location?.trim() || null,
    about: about?.slice(0, 1000).trim() || null,
    industry: industry || null,
  };

  logger.info(
    `[LinkedIn] Profile: ${snapshot.name} | ${snapshot.headline ?? 'no headline'} | ${snapshot.location ?? 'unknown location'}`,
  );

  return snapshot;
}

/** Read a minimal snapshot from search result HTML (before opening the profile page). */
export async function readSearchResultSnapshot(
  nameText: string,
  subtitleText: string,
  profileUrl: string,
): Promise<Pick<LinkedInProfileSnapshot, 'profileUrl' | 'profileId' | 'name' | 'firstName' | 'headline' | 'jobTitle' | 'company' | 'location'>> {
  const profileId =
    profileUrl.split('/in/')[1]?.replace(/\/$/, '').split('?')[0] ?? profileUrl;
  const name = nameText.trim() || profileId;
  return {
    profileUrl,
    profileId,
    name,
    firstName: firstWord(name),
    headline: subtitleText.trim() || null,
    jobTitle: null,
    company: null,
    location: null,
  };
}

/** Check if the profile already shows "Connected" or "1st" (already connected). */
export async function isAlreadyConnected(page: Page): Promise<boolean> {
  try {
    const connected = page.locator(LI_SELECTORS.connectedIndicator).first();
    if (await connected.isVisible({ timeout: 2000 })) return true;
  } catch {
    // not visible
  }
  return false;
}

/** Check if a connection request is still pending. */
export async function isConnectionPending(page: Page): Promise<boolean> {
  try {
    const pending = page.locator(LI_SELECTORS.pendingIndicator).first();
    if (await pending.isVisible({ timeout: 2000 })) return true;
  } catch {
    // not visible
  }
  return false;
}

/**
 * Determine the current connection status from visible LinkedIn UI.
 * Returns: 'connected' | 'pending' | 'none' | 'unknown'
 */
export async function detectConnectionState(
  page: Page,
): Promise<'connected' | 'pending' | 'none' | 'unknown'> {
  await assertNoLinkedInChallenge(page);
  if (await isAlreadyConnected(page)) return 'connected';
  if (await isConnectionPending(page)) return 'pending';

  // Connect button visible means no connection
  try {
    const connectBtn = page
      .locator(LI_SELECTORS.connectButton + ', ' + LI_SELECTORS.connectButtonFallback)
      .first();
    if (await connectBtn.isVisible({ timeout: 2000 })) return 'none';
  } catch {
    // not visible
  }

  return 'unknown';
}
