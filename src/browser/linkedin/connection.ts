/**
 * LinkedIn connection request and messaging via visible UI.
 * No private APIs. No CAPTCHA bypassing.
 */

import type { Page } from 'playwright';
import { logger } from '../../logger';
import { LI_SELECTORS } from './selectors';
import { assertNoLinkedInChallenge } from './security';

/**
 * Attempt to click the visible Connect button and optionally add a note.
 * Returns true if a connection request was successfully sent from the visible UI.
 */
export async function sendConnectionRequest(
  page: Page,
  note?: string,
): Promise<boolean> {
  await assertNoLinkedInChallenge(page);

  // Try the primary visible Connect button
  let connectClicked = false;

  const primarySelectors = [
    LI_SELECTORS.connectButton,
    LI_SELECTORS.connectButtonFallback,
  ];

  for (const sel of primarySelectors) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await btn.click({ timeout: 5000 });
      connectClicked = true;
      logger.info('[LinkedIn] Clicked Connect button');
      await page.waitForTimeout(1000);
      break;
    }
  }

  // If primary button not found, look in "More actions" dropdown
  if (!connectClicked) {
    const moreBtn = page.locator(LI_SELECTORS.moreActionsButton).first();
    if (await moreBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await moreBtn.click({ timeout: 5000 });
      await page.waitForTimeout(600);
      const connectInMenu = page.locator(LI_SELECTORS.connectInDropdown).first();
      if (await connectInMenu.isVisible({ timeout: 2000 }).catch(() => false)) {
        await connectInMenu.click({ timeout: 5000 });
        connectClicked = true;
        logger.info('[LinkedIn] Clicked Connect via More Actions dropdown');
        await page.waitForTimeout(1000);
      }
    }
  }

  if (!connectClicked) {
    logger.warn('[LinkedIn] No visible Connect button found');
    return false;
  }

  await assertNoLinkedInChallenge(page);

  // Handle the connection modal — add note if provided and length allows
  if (note && note.trim()) {
    const addNoteBtn = page.locator(LI_SELECTORS.addNoteButton).first();
    if (await addNoteBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await addNoteBtn.click({ timeout: 5000 });
      await page.waitForTimeout(600);
      const textarea = page.locator(LI_SELECTORS.noteTextarea).first();
      if (await textarea.isVisible({ timeout: 3000 }).catch(() => false)) {
        // LinkedIn limits connection notes to 300 characters
        const trimmedNote = note.trim().slice(0, 300);
        await textarea.fill(trimmedNote);
        logger.info(`[LinkedIn] Added connection note (${trimmedNote.length} chars)`);
      }
    }
  }

  // Click Send (with or without note)
  const sendSelectors = [
    LI_SELECTORS.sendNowButton,
    LI_SELECTORS.sendWithoutNoteButton,
    LI_SELECTORS.sendButton,
  ];

  for (const sel of sendSelectors) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await btn.click({ timeout: 5000 });
      logger.info('[LinkedIn] Connection request sent');
      await page.waitForTimeout(1200);
      await assertNoLinkedInChallenge(page);
      return true;
    }
  }

  // If none of the send buttons appeared, the request may still have gone through
  // after clicking Connect without a note flow. Check if modal closed.
  const modalGone = !(await page
    .locator(LI_SELECTORS.addNoteButton)
    .isVisible({ timeout: 1000 })
    .catch(() => false));
  if (modalGone) {
    logger.info('[LinkedIn] Connection request appears sent (modal dismissed)');
    return true;
  }

  logger.warn('[LinkedIn] Could not confirm connection request was sent');
  return false;
}

/**
 * Send a LinkedIn DM via the visible Message button on a profile page.
 * Returns true if the message was sent successfully.
 */
export async function sendLinkedInMessage(
  page: Page,
  message: string,
): Promise<boolean> {
  await assertNoLinkedInChallenge(page);

  // Click the visible Message button
  const msgBtn = page.locator(LI_SELECTORS.messageButton).first();
  if (!(await msgBtn.isVisible({ timeout: 3000 }).catch(() => false))) {
    logger.warn('[LinkedIn] No visible Message button found');
    return false;
  }

  await msgBtn.click({ timeout: 5000 });
  await page.waitForTimeout(1200);
  await assertNoLinkedInChallenge(page);

  // Type into the visible composer
  const composer = page.locator(LI_SELECTORS.messageComposer).first();
  if (!(await composer.isVisible({ timeout: 5000 }).catch(() => false))) {
    logger.warn('[LinkedIn] Message composer not visible');
    return false;
  }

  await composer.click();
  await composer.fill('');
  await composer.fill(message);
  logger.info('[LinkedIn] Typed message into visible composer');
  await page.waitForTimeout(500);

  // Click Send
  const sendBtn = page.locator(LI_SELECTORS.messageSendButton).first();
  if (!(await sendBtn.isVisible({ timeout: 3000 }).catch(() => false))) {
    // Fallback: Enter key
    logger.warn('[LinkedIn] Send button not found, trying Enter key');
    await composer.press('Enter');
  } else {
    await sendBtn.click({ timeout: 5000 });
  }

  await page.waitForTimeout(1000);
  await assertNoLinkedInChallenge(page);
  logger.info('[LinkedIn] Message sent via visible UI');
  return true;
}
