import fs from 'fs';
import path from 'path';
import type { OutreachRecord } from '../types';
import { logger } from '../logger';

interface ProcessedStore {
  profiles: Record<
    string,
    {
      profileUrl: string;
      username: string;
      lastMessageStatus: string;
      firstSeenAt: string;
      lastSeenAt: string;
    }
  >;
}

export interface AiCacheEntry {
  profileUrl: string;
  username: string;
  displayedName: string;
  qualified: boolean;
  confidence: number;
  reason: string;
  extractedFirstName?: string | null;
  generatedMessage?: string;
  timestamp: string;
  leadScore?: number;
  leadConfidence?: number;
  prospectType?: string;
  scoringFactors?: Record<string, number>;
  role?: string | null;
  company?: string | null;
  location?: string | null;
}

interface AiCacheStore {
  profiles: Record<string, AiCacheEntry>;
}

/**
 * Local JSON + JSONL persistence so restarts never re-message the same profile,
 * and AI qualification results are cached per profile.
 */
export class LocalStore {
  private processedPath: string;
  private resultsPath: string;
  private aiCachePath: string;
  private processed: ProcessedStore;
  private aiCache: AiCacheStore;
  private recentRecords: OutreachRecord[] = [];

  constructor(
    processedProfilesFile: string,
    resultsLogFile: string,
    aiCacheFile = './data/ai-cache.json',
  ) {
    this.processedPath = path.resolve(processedProfilesFile);
    this.resultsPath = path.resolve(resultsLogFile);
    this.aiCachePath = path.resolve(aiCacheFile);
    fs.mkdirSync(path.dirname(this.processedPath), { recursive: true });
    fs.mkdirSync(path.dirname(this.resultsPath), { recursive: true });
    fs.mkdirSync(path.dirname(this.aiCachePath), { recursive: true });
    this.processed = this.loadProcessed();
    this.aiCache = this.loadAiCache();
  }

  private loadProcessed(): ProcessedStore {
    if (!fs.existsSync(this.processedPath)) {
      return { profiles: {} };
    }
    try {
      const raw = fs.readFileSync(this.processedPath, 'utf8');
      const parsed = JSON.parse(raw) as ProcessedStore;
      return { profiles: parsed.profiles ?? {} };
    } catch (err) {
      logger.warn(`Could not parse processed profiles file; starting fresh. ${String(err)}`);
      return { profiles: {} };
    }
  }

  private loadAiCache(): AiCacheStore {
    if (!fs.existsSync(this.aiCachePath)) {
      return { profiles: {} };
    }
    try {
      const raw = fs.readFileSync(this.aiCachePath, 'utf8');
      const parsed = JSON.parse(raw) as AiCacheStore;
      return { profiles: parsed.profiles ?? {} };
    } catch (err) {
      logger.warn(`Could not parse AI cache file; starting fresh. ${String(err)}`);
      return { profiles: {} };
    }
  }

  private saveProcessed(): void {
    fs.writeFileSync(this.processedPath, JSON.stringify(this.processed, null, 2), 'utf8');
  }

  private saveAiCache(): void {
    fs.writeFileSync(this.aiCachePath, JSON.stringify(this.aiCache, null, 2), 'utf8');
  }

  normalizeProfileKey(profileUrl: string): string {
    try {
      const url = new URL(profileUrl);
      const parts = url.pathname.split('/').filter(Boolean);
      const username = (parts[0] ?? '').toLowerCase();
      return username || profileUrl.toLowerCase();
    } catch {
      return profileUrl.toLowerCase();
    }
  }

  hasProcessed(profileUrl: string): boolean {
    const key = this.normalizeProfileKey(profileUrl);
    return Boolean(this.processed.profiles[key]);
  }

  markProcessed(
    profileUrl: string,
    username: string,
    messageStatus: string,
  ): void {
    const key = this.normalizeProfileKey(profileUrl);
    const now = new Date().toISOString();
    const existing = this.processed.profiles[key];
    this.processed.profiles[key] = {
      profileUrl,
      username,
      lastMessageStatus: messageStatus,
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastSeenAt: now,
    };
    this.saveProcessed();
  }

  getAiCache(profileUrl: string): AiCacheEntry | null {
    const key = this.normalizeProfileKey(profileUrl);
    return this.aiCache.profiles[key] ?? null;
  }

  setAiCache(entry: AiCacheEntry): void {
    const key = this.normalizeProfileKey(entry.profileUrl);
    this.aiCache.profiles[key] = entry;
    this.saveAiCache();
  }

  /** Test helper / forced refresh */
  clearAiCache(profileUrl?: string): void {
    if (!profileUrl) {
      this.aiCache = { profiles: {} };
    } else {
      delete this.aiCache.profiles[this.normalizeProfileKey(profileUrl)];
    }
    this.saveAiCache();
  }

  appendResult(record: OutreachRecord): void {
    fs.appendFileSync(this.resultsPath, `${JSON.stringify(record)}\n`, 'utf8');
    this.recentRecords.unshift(record);
    if (this.recentRecords.length > 100) {
      this.recentRecords = this.recentRecords.slice(0, 100);
    }
    if (
      record.messageStatus === 'sent' ||
      record.messageStatus === 'dry_run_drafted' ||
      record.messageStatus === 'rejected_by_user'
    ) {
      this.markProcessed(record.profileUrl, record.username, record.messageStatus);
    }
  }

  getRecentRecords(limit = 50): OutreachRecord[] {
    return this.recentRecords.slice(0, limit);
  }

  getProcessedCount(): number {
    return Object.keys(this.processed.profiles).length;
  }
}
