import type { Page } from 'playwright';
import { logger } from '../../logger';
import { SELECTORS } from './selectors';
import { assertNoSecurityChallenge, dismissCommonDialogs } from './security';
import { applyMessageTemplate, resolveGreetingName } from '../../message-template';

export { applyMessageTemplate, resolveGreetingName };
export async function waitForMessageComposer(page: Page, timeoutMs = 15_000): Promise<void> {
  await assertNoSecurityChallenge(page);
  await dismissCommonDialogs(page);
  const composer = page.locator(SELECTORS.messageComposer).first();
  await composer.waitFor({ state: 'visible', timeout: timeoutMs });
}

export async function typeMessage(page: Page, message: string, typingDelayMs: number): Promise<void> {
  await assertNoSecurityChallenge(page);
  const composer = page.locator(SELECTORS.messageComposer).first();
  await composer.click();
  await composer.fill('');
  // Prefer type for contenteditable; fill works for textarea
  try {
    await composer.fill(message);
  } catch {
    await page.keyboard.type(message, { delay: typingDelayMs });
  }
  logger.info('Drafted message into visible composer');
}

export async function clickSend(page: Page): Promise<void> {
  await assertNoSecurityChallenge(page);
  for (const sel of SELECTORS.sendButtonCandidates) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible().catch(() => false)) {
      logger.info(`Clicking Send (${sel})`);
      await btn.click();
      await page.waitForTimeout(800);
      return;
    }
  }
  // Some IG UIs send via Enter when composer focused
  logger.warn('Send button not found; attempting Enter key on composer');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);
}
