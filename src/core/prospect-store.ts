import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type {
  Platform,
  PlatformAnalytics,
  PriorityTier,
  ProspectRecord,
} from './lead-types';
import { computeRates, emptyPlatformAnalytics } from './lead-types';
import { logger } from '../logger';

interface ProspectStoreFile {
  prospects: Record<string, ProspectRecord>;
  analyticsEvents: Array<{
    id: string;
    platform: Platform;
    campaignId: string;
    type: string;
    timestamp: string;
    meta?: Record<string, unknown>;
  }>;
}

/**
 * Shared persistent prospect + analytics store for Instagram and LinkedIn.
 */
export class ProspectStore {
  private filePath: string;
  private data: ProspectStoreFile;

  constructor(filePath = './data/prospects.json') {
    this.filePath = path.resolve(filePath);
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    } catch (err) {
      // Ignore read-only errors on serverless environments
    }
    this.data = this.load();
  }

  private load(): ProspectStoreFile {
    if (!fs.existsSync(this.filePath)) {
      return { prospects: {}, analyticsEvents: [] };
    }
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as ProspectStoreFile;
      return {
        prospects: raw.prospects ?? {},
        analyticsEvents: raw.analyticsEvents ?? [],
      };
    } catch (err) {
      logger.warn(`Could not parse prospects store: ${String(err)}`);
      return { prospects: {}, analyticsEvents: [] };
    }
  }

  private save(): void {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (err) {
      // Ignore read-only errors on serverless environments
    }
  }

  private key(platform: Platform, profileUrl: string): string {
    try {
      const u = new URL(profileUrl);
      return `${platform}:${u.pathname.replace(/\/+$/, '').toLowerCase() || profileUrl.toLowerCase()}`;
    } catch {
      return `${platform}:${profileUrl.toLowerCase()}`;
    }
  }

  get(platform: Platform, profileUrl: string): ProspectRecord | null {
    return this.data.prospects[this.key(platform, profileUrl)] ?? null;
  }

  getById(id: string): ProspectRecord | null {
    return Object.values(this.data.prospects).find((p) => p.id === id) ?? null;
  }

  upsert(partial: Omit<ProspectRecord, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): ProspectRecord {
    const k = this.key(partial.platform, partial.profileUrl);
    const existing = this.data.prospects[k];
    const now = new Date().toISOString();
    const record: ProspectRecord = {
      ...(existing ?? {
        id: partial.id ?? randomUUID(),
        createdAt: now,
      }),
      ...partial,
      id: existing?.id ?? partial.id ?? randomUUID(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastInteractionAt: partial.lastInteractionAt || now,
    };
    this.data.prospects[k] = record;
    this.save();
    return record;
  }

  list(filters?: {
    platform?: Platform | 'all';
    priority?: PriorityTier;
    prospectType?: string;
    campaignId?: string;
    conversationStatus?: string;
    minScore?: number;
    qualified?: boolean;
  }): ProspectRecord[] {
    let rows = Object.values(this.data.prospects);
    if (filters?.platform && filters.platform !== 'all') {
      rows = rows.filter((r) => r.platform === filters.platform);
    }
    if (filters?.priority) rows = rows.filter((r) => r.priority === filters.priority);
    if (filters?.prospectType) {
      rows = rows.filter((r) => r.prospectType === filters.prospectType);
    }
    if (filters?.campaignId) rows = rows.filter((r) => r.campaignId === filters.campaignId);
    if (filters?.conversationStatus) {
      rows = rows.filter((r) => r.conversationStatus === filters.conversationStatus);
    }
    if (filters?.minScore != null) rows = rows.filter((r) => r.leadScore >= filters.minScore!);
    if (filters?.qualified != null) rows = rows.filter((r) => r.qualified === filters.qualified);
    return rows.sort((a, b) => b.leadScore - a.leadScore || b.updatedAt.localeCompare(a.updatedAt));
  }

  trackEvent(
    platform: Platform,
    campaignId: string,
    type: string,
    meta?: Record<string, unknown>,
  ): void {
    this.data.analyticsEvents.push({
      id: randomUUID(),
      platform,
      campaignId,
      type,
      timestamp: new Date().toISOString(),
      meta,
    });
    // Keep last 5000 events
    if (this.data.analyticsEvents.length > 5000) {
      this.data.analyticsEvents = this.data.analyticsEvents.slice(-5000);
    }
    this.save();
  }

  getAnalytics(platform: Platform, campaignId?: string): PlatformAnalytics {
    const a = emptyPlatformAnalytics(platform);
    const events = this.data.analyticsEvents.filter(
      (e) => e.platform === platform && (!campaignId || e.campaignId === campaignId),
    );
    for (const e of events) {
      switch (e.type) {
        case 'discovered':
          a.profilesDiscovered += 1;
          break;
        case 'inspected':
          a.profilesInspected += 1;
          break;
        case 'qualified':
          a.profilesQualified += 1;
          break;
        case 'skipped':
          a.profilesSkipped += 1;
          break;
        case 'message_prepared':
          a.messagesPrepared += 1;
          break;
        case 'message_sent':
          a.messagesSent += 1;
          break;
        case 'reply_received':
          a.repliesReceived += 1;
          break;
        case 'interested':
          a.interested += 1;
          break;
        case 'question':
          a.questions += 1;
          break;
        case 'not_interested':
          a.notInterested += 1;
          break;
        case 'follow_up':
          a.followUps += 1;
          break;
        case 'conversion':
          a.conversions += 1;
          break;
        case 'connection_sent':
          a.connectionsSent += 1;
          break;
        case 'connection_accepted':
          a.connectionsAccepted += 1;
          break;
        case 'connection_pending':
          a.connectionsPending += 1;
          break;
        default:
          break;
      }
    }

    for (const p of this.list({ platform, campaignId })) {
      a.priorityCounts[p.priority] += 1;
    }

    return computeRates(a);
  }

  leadIntelligenceSummary(platform: Platform | 'all' = 'all') {
    const rows = this.list({ platform });
    return {
      total: rows.length,
      A: rows.filter((r) => r.priority === 'A').length,
      B: rows.filter((r) => r.priority === 'B').length,
      C: rows.filter((r) => r.priority === 'C').length,
      D: rows.filter((r) => r.priority === 'D').length,
      qualified: rows.filter((r) => r.qualified).length,
      contacted: rows.filter((r) => r.conversationStatus !== 'NEW').length,
      interested: rows.filter((r) => r.conversationStatus === 'INTERESTED').length,
    };
  }
}
