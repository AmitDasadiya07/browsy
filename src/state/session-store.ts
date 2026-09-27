import fs from 'fs';
import path from 'path';
import { logger } from '../logger';

export interface InstagramSessionMeta {
  /** True when a local browser profile with Instagram cookies is retained */
  saved: boolean;
  /** ISO timestamp when login was first confirmed/saved */
  savedAt: string | null;
  /** ISO timestamp of last successful login verification */
  lastVerifiedAt: string | null;
  /** Visible Instagram username if known (never a password) */
  username: string | null;
  /** Absolute path to the persistent browser profile directory */
  profileDir: string;
  /** Human-readable note for the dashboard */
  note: string;
}

/**
 * Tracks whether an Instagram browser session is retained locally.
 * Actual auth cookies live in the Playwright Chromium user-data dir —
 * we never store Instagram passwords in this file.
 */
export class SessionStore {
  private metaPath: string;
  private profileDir: string;
  private meta: InstagramSessionMeta;
  private emptyNote: string;

  constructor(
    profileDir: string,
    metaFile = './data/instagram-session.json',
    emptyNote = 'No saved Instagram login yet',
  ) {
    this.profileDir = path.resolve(profileDir);
    this.metaPath = path.resolve(metaFile);
    this.emptyNote = emptyNote;
    fs.mkdirSync(path.dirname(this.metaPath), { recursive: true });
    fs.mkdirSync(this.profileDir, { recursive: true });
    this.meta = this.load();
  }

  private defaultMeta(note = this.emptyNote): InstagramSessionMeta {
    return {
      saved: false,
      savedAt: null,
      lastVerifiedAt: null,
      username: null,
      profileDir: this.profileDir,
      note,
    };
  }

  private load(): InstagramSessionMeta {
    const profileLooksPresent = this.profileDirHasData();
    if (!fs.existsSync(this.metaPath)) {
      if (profileLooksPresent) {
        const inferred = this.defaultMeta(
          'Browser profile found on disk — session will be reused until cleared from the dashboard',
        );
        inferred.saved = true;
        inferred.savedAt = new Date().toISOString();
        this.write(inferred);
        return inferred;
      }
      return this.defaultMeta();
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.metaPath, 'utf8')) as Partial<InstagramSessionMeta>;
      const meta: InstagramSessionMeta = {
        ...this.defaultMeta(),
        ...parsed,
        profileDir: this.profileDir,
        saved: Boolean(parsed.saved) && profileLooksPresent,
      };
      if (parsed.saved && !profileLooksPresent) {
        meta.saved = false;
        meta.note = 'Saved login was marked present but the browser profile is missing — log in again';
        this.write(meta);
      }
      return meta;
    } catch (err) {
      logger.warn(`Could not parse session meta; resetting. ${String(err)}`);
      return this.defaultMeta();
    }
  }

  private write(meta: InstagramSessionMeta): void {
    this.meta = meta;
    fs.writeFileSync(this.metaPath, JSON.stringify(meta, null, 2), 'utf8');
  }

  private profileDirHasData(): boolean {
    if (!fs.existsSync(this.profileDir)) return false;
    try {
      const entries = fs.readdirSync(this.profileDir);
      // Chromium persistent profiles create Default/, Cookies, etc.
      return entries.some((name) =>
        ['Default', 'Cookies', 'Network', 'Local State', 'Preferences'].includes(name),
      );
    } catch {
      return false;
    }
  }

  getMeta(): InstagramSessionMeta {
    // Refresh saved flag against disk
    const onDisk = this.profileDirHasData();
    if (this.meta.saved && !onDisk) {
      this.write({
        ...this.meta,
        saved: false,
        note: 'Browser profile missing — log in again on next Start',
      });
    } else if (!this.meta.saved && onDisk) {
      // Profile exists but meta says unsaved — still report present for UX
      return {
        ...this.meta,
        saved: true,
        note: this.meta.note || 'Browser profile present on disk',
        profileDir: this.profileDir,
      };
    }
    return { ...this.meta, profileDir: this.profileDir };
  }

  getProfileDir(): string {
    return this.profileDir;
  }

  markLoggedIn(username?: string | null): void {
    const now = new Date().toISOString();
    this.write({
      saved: true,
      savedAt: this.meta.savedAt ?? now,
      lastVerifiedAt: now,
      username: username?.trim() || this.meta.username,
      profileDir: this.profileDir,
      note: 'Instagram login saved locally. You will stay signed in until you clear it from the dashboard.',
    });
    logger.info(
      `Instagram session saved locally${username ? ` (@${username})` : ''} — no re-login needed until cleared`,
    );
  }

  /**
   * Wipe the persistent browser profile and session metadata.
   * Caller must close Playwright first so files are not locked.
   */
  clearSession(note?: string): InstagramSessionMeta {
    this.removeProfileDir();
    fs.mkdirSync(this.profileDir, { recursive: true });
    const cleared = this.defaultMeta(
      note ??
        'Saved Instagram login removed. Next Start will require signing in again.',
    );
    this.write(cleared);
    logger.warn('Instagram saved login cleared from disk');
    return this.getMeta();
  }

  private removeProfileDir(): void {
    if (!fs.existsSync(this.profileDir)) return;
    try {
      fs.rmSync(this.profileDir, { recursive: true, force: true });
    } catch (err) {
      logger.error(`Failed to fully remove browser profile: ${String(err)}`);
      // Best-effort: delete known children
      try {
        for (const name of fs.readdirSync(this.profileDir)) {
          fs.rmSync(path.join(this.profileDir, name), { recursive: true, force: true });
        }
      } catch (inner) {
        throw new Error(`Could not clear browser profile: ${String(inner)}`);
      }
    }
  }
}
