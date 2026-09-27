/**
 * Persistent store for LinkedIn pending connections, message tracking,
 * and connection/message limit counters.
 *
 * Completely separate from Instagram data.
 * Survives application restarts (JSON on disk).
 */

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { logger } from '../logger';

// ─── Status model ────────────────────────────────────────────────────────────

export type LinkedInConnectionStatus =
  | 'DISCOVERED'
  | 'QUALIFIED'
  | 'CONNECTION_SENT'
  | 'PENDING'
  | 'ACCEPTED'
  | 'MESSAGE_READY'
  | 'MESSAGE_SENT'
  | 'SKIPPED'
  | 'FAILED';

// ─── Pending connection record ────────────────────────────────────────────────

export interface LinkedInPendingConnection {
  id: string;
  platform: 'linkedin';
  profileUrl: string;
  profileId: string;           // username extracted from /in/<id>
  name: string;
  firstName: string | null;
  company: string | null;
  role: string | null;
  headline: string | null;
  location: string | null;
  searchQuery: string;
  qualification: {
    qualified: boolean;
    confidence: number;
    reason: string;
  };
  connectionStatus: LinkedInConnectionStatus;
  connectionSentAt: string | null;
  messageSentAt: string | null;
  messageStatus: 'NONE' | 'MESSAGE_PENDING' | 'MESSAGE_SENT' | 'SKIPPED';
  draftedMessage: string | null;
  lastCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Limit counters ───────────────────────────────────────────────────────────

export interface LinkedInLimitCounters {
  connectionsUsed: number;
  messagesUsed: number;
  lastResetAt: string;
}

// ─── On-disk file shape ───────────────────────────────────────────────────────

interface LinkedInStoreFile {
  connections: Record<string, LinkedInPendingConnection>;
  limits: LinkedInLimitCounters;
  activityLog: Array<{
    id: string;
    timestamp: string;
    message: string;
    level: 'info' | 'warn' | 'error';
  }>;
}

// ─── Store class ──────────────────────────────────────────────────────────────

export class LinkedInStore {
  private filePath: string;
  private data: LinkedInStoreFile;

  constructor(filePath = './data/linkedin-store.json') {
    this.filePath = path.resolve(filePath);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.data = this.load();
  }

  // ── Persistence ─────────────────────────────────────────────────────────────

  private load(): LinkedInStoreFile {
    if (!fs.existsSync(this.filePath)) {
      return this.empty();
    }
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as LinkedInStoreFile;
      return {
        connections: raw.connections ?? {},
        limits: raw.limits ?? this.defaultLimits(),
        activityLog: raw.activityLog ?? [],
      };
    } catch (err) {
      logger.warn(`LinkedIn store corrupt — starting fresh: ${String(err)}`);
      return this.empty();
    }
  }

  private empty(): LinkedInStoreFile {
    return { connections: {}, limits: this.defaultLimits(), activityLog: [] };
  }

  private defaultLimits(): LinkedInLimitCounters {
    return { connectionsUsed: 0, messagesUsed: 0, lastResetAt: new Date().toISOString() };
  }

  private save(): void {
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
  }

  // ── URL normalisation ────────────────────────────────────────────────────────

  normalizeUrl(profileUrl: string): string {
    try {
      // Strip query params and fragment before normalising
      const cleanUrl = profileUrl.split('?')[0].split('#')[0];
      const u = new URL(cleanUrl);
      const parts = u.pathname.split('/').filter(Boolean);
      const inIdx = parts.indexOf('in');
      if (inIdx >= 0 && parts[inIdx + 1]) {
        return `https://www.linkedin.com/in/${parts[inIdx + 1]}`;
      }
    } catch {
      // fall through
    }
    return profileUrl.split('?')[0].toLowerCase().replace(/\/$/, '');
  }

  extractProfileId(profileUrl: string): string {
    try {
      const cleanUrl = profileUrl.split('?')[0].split('#')[0];
      const u = new URL(cleanUrl);
      const parts = u.pathname.split('/').filter(Boolean);
      const inIdx = parts.indexOf('in');
      if (inIdx >= 0 && parts[inIdx + 1]) return parts[inIdx + 1];
    } catch {
      // fall through
    }
    return profileUrl.split('/in/')[1]?.split('?')[0]?.replace(/\/$/, '') ?? profileUrl;
  }

  // ── Connection CRUD ──────────────────────────────────────────────────────────

  get(profileUrl: string): LinkedInPendingConnection | null {
    return this.data.connections[this.normalizeUrl(profileUrl)] ?? null;
  }

  getById(id: string): LinkedInPendingConnection | null {
    return Object.values(this.data.connections).find((c) => c.id === id) ?? null;
  }

  hasConnectionSent(profileUrl: string): boolean {
    const c = this.get(profileUrl);
    if (!c) return false;
    const blocking: LinkedInConnectionStatus[] = [
      'CONNECTION_SENT', 'PENDING', 'ACCEPTED', 'MESSAGE_READY', 'MESSAGE_SENT',
    ];
    return blocking.includes(c.connectionStatus);
  }

  hasMessageSent(profileUrl: string): boolean {
    const c = this.get(profileUrl);
    return c?.messageStatus === 'MESSAGE_SENT';
  }

  upsert(partial: Omit<LinkedInPendingConnection, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): LinkedInPendingConnection {
    const key = this.normalizeUrl(partial.profileUrl);
    const existing = this.data.connections[key];
    const now = new Date().toISOString();
    const record: LinkedInPendingConnection = {
      ...(existing ?? {}),
      ...partial,
      id: existing?.id ?? partial.id ?? randomUUID(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.data.connections[key] = record;
    this.save();
    return record;
  }

  list(filter?: {
    status?: LinkedInConnectionStatus | LinkedInConnectionStatus[];
    messageStatus?: LinkedInPendingConnection['messageStatus'];
  }): LinkedInPendingConnection[] {
    let rows = Object.values(this.data.connections);
    if (filter?.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      rows = rows.filter((r) => statuses.includes(r.connectionStatus));
    }
    if (filter?.messageStatus) {
      rows = rows.filter((r) => r.messageStatus === filter.messageStatus);
    }
    return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getPending(): LinkedInPendingConnection[] {
    return this.list({ status: ['CONNECTION_SENT', 'PENDING'] });
  }

  getAccepted(): LinkedInPendingConnection[] {
    return this.list({ status: 'ACCEPTED' });
  }

  getMessageReady(): LinkedInPendingConnection[] {
    return this.list({ status: ['ACCEPTED', 'MESSAGE_READY'], messageStatus: 'MESSAGE_PENDING' });
  }

  // ── Limit tracking ───────────────────────────────────────────────────────────

  getLimits(): LinkedInLimitCounters {
    return { ...this.data.limits };
  }

  incrementConnections(): void {
    this.data.limits.connectionsUsed += 1;
    this.save();
  }

  incrementMessages(): void {
    this.data.limits.messagesUsed += 1;
    this.save();
  }

  resetLimits(): void {
    this.data.limits = this.defaultLimits();
    this.save();
  }

  connectionsRemaining(maximum: number): number {
    return Math.max(0, maximum - this.data.limits.connectionsUsed);
  }

  messagesRemaining(maximum: number): number {
    return Math.max(0, maximum - this.data.limits.messagesUsed);
  }

  // ── Activity log (LinkedIn-specific, separate from Instagram) ────────────────

  logActivity(message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    const entry = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      message,
      level,
    };
    this.data.activityLog.unshift(entry);
    if (this.data.activityLog.length > 500) {
      this.data.activityLog = this.data.activityLog.slice(0, 500);
    }
    this.save();
    if (level === 'error') logger.error(`[LinkedIn] ${message}`);
    else if (level === 'warn') logger.warn(`[LinkedIn] ${message}`);
    else logger.info(`[LinkedIn] ${message}`);
  }

  getActivityLog(limit = 100): typeof this.data.activityLog {
    return this.data.activityLog.slice(0, limit);
  }

  // ── Statistics ───────────────────────────────────────────────────────────────

  getStats() {
    const all = Object.values(this.data.connections);
    return {
      total: all.length,
      discovered: all.filter((c) => c.connectionStatus === 'DISCOVERED').length,
      qualified: all.filter((c) => c.connectionStatus === 'QUALIFIED').length,
      connectionSent: all.filter((c) =>
        ['CONNECTION_SENT', 'PENDING'].includes(c.connectionStatus),
      ).length,
      accepted: all.filter((c) =>
        ['ACCEPTED', 'MESSAGE_READY', 'MESSAGE_SENT'].includes(c.connectionStatus),
      ).length,
      messagePending: all.filter((c) => c.messageStatus === 'MESSAGE_PENDING').length,
      messageSent: all.filter((c) => c.messageStatus === 'MESSAGE_SENT').length,
      skipped: all.filter((c) => c.connectionStatus === 'SKIPPED').length,
      failed: all.filter((c) => c.connectionStatus === 'FAILED').length,
    };
  }
}
