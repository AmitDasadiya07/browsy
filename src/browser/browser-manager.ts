import type { BrowserContext, Page } from 'playwright';
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import type { BrowserConfig } from '../types';
import { logger } from '../logger';
import { INSTAGRAM_ORIGIN } from './instagram/selectors';

export class BrowserManager {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private intentionalClose = false;

  constructor(private readonly config: BrowserConfig) {}

  getUserDataDir(): string {
    return path.resolve(this.config.userDataDir);
  }

  isOpen(): boolean {
    return Boolean(this.context);
  }

  /** Always returns the current live page (may change if Instagram closes a tab). */
  getPage(): Page {
    if (!this.page || this.page.isClosed()) {
      const live = this.context?.pages().find((p) => !p.isClosed());
      if (live) {
        this.page = live;
        return live;
      }
      throw new Error('Browser page is not available');
    }
    return this.page;
  }

  getContext(): BrowserContext {
    if (!this.context) {
      throw new Error('Browser context not available');
    }
    return this.context;
  }

  async launch(): Promise<Page> {
    this.intentionalClose = false;

    if (this.context) {
      const live = this.context.pages().find((p) => !p.isClosed());
      if (live) {
        this.page = live;
        logger.info('Reusing already-open browser window');
        return live;
      }
      // Context exists but no pages — try to open one before recreating
      try {
        this.page = await this.context.newPage();
        await this.page.goto(INSTAGRAM_ORIGIN, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
        return this.page;
      } catch {
        await this.close();
      }
    }

    const userDataDir = this.getUserDataDir();
    fs.mkdirSync(userDataDir, { recursive: true });

    logger.info(`Launching persistent browser profile at ${userDataDir}`);

    const launchOptions: Parameters<typeof chromium.launchPersistentContext>[1] = {
      headless: this.config.headless,
      slowMo: this.config.slowMoMs,
      viewport: { width: 1280, height: 900 },
      // Keep process around; Instagram login redirects often close tabs
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    };

    if (this.config.executablePath.trim()) {
      launchOptions.executablePath = this.config.executablePath.trim();
    } else if (this.config.useSystemChrome) {
      // System Chrome is far more stable with Instagram login / reCAPTCHA than bundled Chromium
      launchOptions.channel = 'chrome';
      logger.info('Using installed Google Chrome (channel=chrome)');
    }

    try {
      this.context = await chromium.launchPersistentContext(userDataDir, launchOptions);
    } catch (err) {
      if (this.config.useSystemChrome && !this.config.executablePath.trim()) {
        logger.warn(
          `Could not launch system Chrome (${String(err)}). Falling back to Playwright Chromium.`,
        );
        delete launchOptions.channel;
        this.context = await chromium.launchPersistentContext(userDataDir, launchOptions);
      } else {
        throw err;
      }
    }

    this.context.setDefaultTimeout(this.config.actionTimeoutMs);
    this.context.setDefaultNavigationTimeout(this.config.navigationTimeoutMs);
    this.wireKeepAlive(this.context);

    const pages = this.context.pages().filter((p) => !p.isClosed());
    this.page = pages[0] ?? (await this.context.newPage());
    this.attachPageGuard(this.page);
    return this.page;
  }

  /**
   * Instagram sometimes closes the login tab after submit / CAPTCHA.
   * If every tab dies, Chromium may exit — so we always keep at least one tab alive.
   */
  private wireKeepAlive(context: BrowserContext): void {
    context.on('close', () => {
      if (this.intentionalClose) {
        logger.info('Browser closed intentionally');
      } else {
        logger.error(
          'Browser context closed unexpectedly (often after Instagram login redirect). Click "Open login" again.',
        );
      }
      this.context = null;
      this.page = null;
    });

    context.on('page', (newPage) => {
      logger.info('New browser tab opened — tracking it');
      this.page = newPage;
      this.attachPageGuard(newPage);
    });
  }

  private attachPageGuard(page: Page): void {
    page.on('close', () => {
      void this.recoverAfterPageClose();
    });
  }

  private async recoverAfterPageClose(): Promise<void> {
    if (this.intentionalClose || !this.context) return;

    const remaining = this.context.pages().filter((p) => !p.isClosed());
    if (remaining.length > 0) {
      this.page = remaining[remaining.length - 1] ?? remaining[0];
      logger.warn('A tab closed after login/navigation — switched to another open tab');
      return;
    }

    logger.warn(
      'Instagram closed the last tab — opening a fresh tab so the browser does NOT exit',
    );
    try {
      this.page = await this.context.newPage();
      this.attachPageGuard(this.page);
      await this.page.goto(INSTAGRAM_ORIGIN, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    } catch (err) {
      logger.error(`Could not reopen tab after close: ${String(err)}`);
    }
  }

  async saveStorageState(filePath: string): Promise<void> {
    if (!this.context) return;
    const resolved = path.resolve(filePath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    await this.context.storageState({ path: resolved });
    logger.info(`Saved Instagram storage state to ${resolved}`);
  }

  async close(): Promise<void> {
    this.intentionalClose = true;
    try {
      await this.context?.close();
    } catch (err) {
      logger.warn(`Error closing browser: ${String(err)}`);
    }
    this.context = null;
    this.page = null;
  }
}
