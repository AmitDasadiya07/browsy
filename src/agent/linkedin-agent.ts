/**
 * LinkedIn outreach agent — completely separate from Instagram.
 * Two-stage workflow:
 *   Stage 1 — Process new prospects (search → qualify → connect)
 *   Stage 2 — Process pending connections (check status → message accepted)
 *
 * Shares: GroqService, BrowserManager, ProspectStore, TemplateLibrary, logger.
 * Does NOT share: browser session, state, workflow, counters with Instagram.
 */

import { randomUUID } from 'crypto';
import type { Page } from 'playwright';
import type { AppConfig, AgentStatus, InstagramSessionStatus } from '../types';
import { SecurityChallengeError, StopRequestedError } from '../types';
import { logger } from '../logger';
import { BrowserManager } from '../browser/browser-manager';
import { SessionStore } from '../state/session-store';
import { LinkedInStore } from '../state/linkedin-store';
import type { LinkedInPendingConnection } from '../state/linkedin-store';
import { GroqService, AiProcessingError } from '../services/groq';
import { ProspectStore } from '../core/prospect-store';
import { TemplateLibrary } from '../core/template-library';
import { calculatePriority } from '../core/lead-types';
import type { GroqDashboardStatus } from '../types';
import {
  searchLinkedInPeople,
} from '../browser/linkedin/search';
import {
  readLinkedInProfile,
  detectConnectionState,
} from '../browser/linkedin/profile';
import {
  sendConnectionRequest,
  sendLinkedInMessage,
} from '../browser/linkedin/connection';
import {
  waitForLinkedInLogin,
  assertNoLinkedInChallenge,
} from '../browser/linkedin/security';
import { LINKEDIN_ORIGIN } from '../browser/linkedin/selectors';
import type { ProfileSnapshot } from '../types';

// ─── LinkedIn-specific config ─────────────────────────────────────────────────

export interface LinkedInConfig {
  enabled: boolean;
  searches: string[];
  qualification: {
    requiredKeywords: string[];
    excludedKeywords: string[];
    locations: string[];
  };
  connectionLimit: {
    enabled: boolean;
    maximum: number;
  };
  messageLimit: {
    enabled: boolean;
    maximum: number;
  };
  requireConfirmationBeforeSend: boolean;
  maximumProfilesPerSearch: number;
}

export function defaultLinkedInConfig(base: AppConfig): LinkedInConfig {
  return {
    enabled: true,
    searches: base.linkedInSearchQueries,
    qualification: {
      requiredKeywords: [],
      excludedKeywords: ['student', 'intern'],
      locations: [],
    },
    connectionLimit: {
      enabled: true,
      maximum: 20,
    },
    messageLimit: {
      enabled: true,
      maximum: 20,
    },
    requireConfirmationBeforeSend: base.requireConfirmationBeforeSend,
    maximumProfilesPerSearch: base.maximumProfilesPerSearch,
  };
}

// ─── Agent stats snapshot ──────────────────────────────────────────────────────

export interface LinkedInAgentStats {
  status: AgentStatus;
  dryRun: boolean;
  lastError: string;
  currentSearch: string;
  currentProfile: string;
  profilesInspected: number;
  profilesQualified: number;
  profilesSkipped: number;
  connectionsUsed: number;
  connectionsRemaining: number;
  messagesUsed: number;
  messagesRemaining: number;
  pendingConnections: number;
  accepted: number;
  messagePending: number;
  messageSent: number;
}

export interface LinkedInPendingConfirmation {
  id: string;
  profileUrl: string;
  name: string;
  draftedMessage: string;
}

export interface LinkedInAgentSnapshot {
  stats: LinkedInAgentStats;
  session: InstagramSessionStatus;
  groq: GroqDashboardStatus;
  stopRequested: boolean;
  running: boolean;
  pendingConfirmation: LinkedInPendingConfirmation | null;
  pendingConnections: LinkedInPendingConnection[];
  activityLog: Array<{ id: string; timestamp: string; message: string; level: string }>;
}

type StateListener = (s: LinkedInAgentSnapshot) => void;
type SecurityListener = (reason: string) => void;

// ─── Agent ────────────────────────────────────────────────────────────────────

export class LinkedInAgent {
  private readonly browserManager: BrowserManager;
  private readonly sessionStore: SessionStore;
  private readonly liStore: LinkedInStore;
  private readonly liConfig: LinkedInConfig;
  private groqStatus: GroqDashboardStatus;

  private stopRequested = false;
  private running = false;

  private pendingConfirmation: LinkedInPendingConfirmation | null = null;
  private confirmationResolver: ((d: 'approve' | 'reject') => void) | null = null;

  private stats: LinkedInAgentStats;
  private listeners = new Set<StateListener>();
  private securityListeners = new Set<SecurityListener>();

  constructor(
    private readonly config: AppConfig,
    private readonly groq: GroqService,
    private readonly prospectStore: ProspectStore,
    private readonly templates: TemplateLibrary,
    liConfig?: Partial<LinkedInConfig>,
    liStorePath = './data/linkedin-store.json',
  ) {
    this.browserManager = new BrowserManager(config.linkedInBrowser);
    this.sessionStore = new SessionStore(
      config.linkedInBrowser.userDataDir,
      config.linkedInSessionMetaFile,
      'No saved LinkedIn login yet',
    );
    this.liStore = new LinkedInStore(liStorePath);
    this.liConfig = { ...defaultLinkedInConfig(config), ...liConfig };
    this.groqStatus = groq.getStatus();
    this.stats = this.buildStats();
  }

  // ── Public getters ────────────────────────────────────────────────────────────

  isRunning(): boolean { return this.running; }

  getLinkedInStore(): LinkedInStore { return this.liStore; }

  getLinkedInConfig(): LinkedInConfig { return { ...this.liConfig }; }

  // ── Snapshot ──────────────────────────────────────────────────────────────────

  private buildStats(): LinkedInAgentStats {
    const limits = this.liStore.getLimits();
    const storeStats = this.liStore.getStats();
    return {
      status: 'idle',
      dryRun: this.config.dryRun,
      lastError: '',
      currentSearch: '',
      currentProfile: '',
      profilesInspected: 0,
      profilesQualified: 0,
      profilesSkipped: 0,
      connectionsUsed: limits.connectionsUsed,
      connectionsRemaining: this.liStore.connectionsRemaining(this.liConfig.connectionLimit.maximum),
      messagesUsed: limits.messagesUsed,
      messagesRemaining: this.liStore.messagesRemaining(this.liConfig.messageLimit.maximum),
      pendingConnections: storeStats.connectionSent,
      accepted: storeStats.accepted,
      messagePending: storeStats.messagePending,
      messageSent: storeStats.messageSent,
    };
  }

  getSnapshot(): LinkedInAgentSnapshot {
    return {
      stats: { ...this.stats },
      session: this.sessionStatus(),
      groq: { ...this.groqStatus },
      stopRequested: this.stopRequested,
      running: this.running,
      pendingConfirmation: this.pendingConfirmation,
      pendingConnections: this.liStore.list({
        status: ['CONNECTION_SENT', 'PENDING', 'ACCEPTED', 'MESSAGE_READY', 'MESSAGE_SENT'],
      }),
      activityLog: this.liStore.getActivityLog(80),
    };
  }

  private sessionStatus(): InstagramSessionStatus {
    const m = this.sessionStore.getMeta();
    return { saved: m.saved, savedAt: m.savedAt, lastVerifiedAt: m.lastVerifiedAt, username: m.username, note: m.note };
  }

  // ── Listeners ─────────────────────────────────────────────────────────────────

  onState(listener: StateListener): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  onSecurityStop(listener: SecurityListener): () => void {
    this.securityListeners.add(listener);
    return () => this.securityListeners.delete(listener);
  }

  private emit(): void {
    const snap = this.getSnapshot();
    for (const l of this.listeners) { try { l(snap); } catch { /* ignore */ } }
  }

  private setStatus(status: AgentStatus, extra: Partial<LinkedInAgentStats> = {}): void {
    const limits = this.liStore.getLimits();
    const storeStats = this.liStore.getStats();
    this.stats = {
      ...this.stats,
      status,
      connectionsUsed: limits.connectionsUsed,
      connectionsRemaining: this.liStore.connectionsRemaining(this.liConfig.connectionLimit.maximum),
      messagesUsed: limits.messagesUsed,
      messagesRemaining: this.liStore.messagesRemaining(this.liConfig.messageLimit.maximum),
      pendingConnections: storeStats.connectionSent,
      accepted: storeStats.accepted,
      messagePending: storeStats.messagePending,
      messageSent: storeStats.messageSent,
      ...extra,
    };
    this.emit();
  }

  // ── Control ───────────────────────────────────────────────────────────────────

  requestStop(): void {
    this.stopRequested = true;
    if (this.confirmationResolver) {
      this.confirmationResolver('reject');
      this.confirmationResolver = null;
      this.pendingConfirmation = null;
    }
    this.setStatus('stopped');
    this.liStore.logActivity('Stop requested by user', 'warn');
  }

  respondToConfirmation(id: string, decision: 'approve' | 'reject'): boolean {
    if (!this.pendingConfirmation || this.pendingConfirmation.id !== id) return false;
    if (this.confirmationResolver) {
      this.confirmationResolver(decision);
      this.confirmationResolver = null;
    }
    return true;
  }

  private waitForConfirmation(pending: LinkedInPendingConfirmation): Promise<'approve' | 'reject'> {
    this.pendingConfirmation = pending;
    this.setStatus('awaiting_confirmation');
    return new Promise((resolve) => {
      this.confirmationResolver = (d) => {
        this.pendingConfirmation = null;
        resolve(d);
      };
    });
  }

  private throwIfStopped(): void {
    if (this.stopRequested) throw new StopRequestedError();
  }

  // ── Session management ────────────────────────────────────────────────────────

  async closeBrowser(): Promise<void> {
    if (this.running) this.requestStop();
    await this.browserManager.close();
    this.emit();
  }

  async clearSavedLogin(): Promise<InstagramSessionStatus> {
    if (this.running) { this.requestStop(); await new Promise((r) => setTimeout(r, 1000)); }
    await this.browserManager.close();
    this.sessionStore.clearSession();
    this.emit();
    return this.sessionStatus();
  }

  async loginOnly(): Promise<void> {
    if (this.running) throw new Error('LinkedIn agent already running');
    this.running = true;
    this.stopRequested = false;
    try {
      const page = await this.browserManager.launch();
      this.setStatus('waiting_login');
      await waitForLinkedInLogin(() => this.browserManager.getPage(), {
        onWaiting: () => this.setStatus('waiting_login'),
        onChallenge: (r) => this.setStatus('waiting_login', { lastError: r }),
      });
      this.sessionStore.markLoggedIn('linkedin-user');
      await this.browserManager.saveStorageState(this.config.linkedInBrowser.storageStateFile);
      this.setStatus('idle');
      this.liStore.logActivity('LinkedIn login saved. Browser left open.');
      void page; // page used implicitly via getPage()
    } finally {
      this.running = false;
      this.emit();
    }
  }

  // ── Groq qualification pipeline ───────────────────────────────────────────────

  private toProfileSnapshot(lp: {
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
  }): ProfileSnapshot {
    return {
      profileUrl: lp.profileUrl,
      username: lp.profileId,
      displayedName: lp.name,
      firstName: lp.firstName ?? lp.name.split(' ')[0] ?? lp.name,
      bio: [lp.headline, lp.about].filter(Boolean).join(' | ').slice(0, 500),
      followers: null,
      following: null,
      posts: null,
      isVerified: false,
      isPrivate: false,
      accountTypeHints: [lp.headline ?? '', lp.industry ?? ''].filter(Boolean),
      locationText: lp.location ?? '',
    };
  }

  private passesLocalFilters(lp: {
    name: string;
    headline: string | null;
    about: string | null;
    location: string | null;
  }): { passes: boolean; reason: string } {
    const q = this.liConfig.qualification;
    const haystack = [lp.name, lp.headline, lp.about, lp.location]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    for (const kw of q.excludedKeywords) {
      if (kw.trim() && haystack.includes(kw.trim().toLowerCase())) {
        return { passes: false, reason: `Excluded keyword: ${kw}` };
      }
    }

    if (q.requiredKeywords.length > 0) {
      const hasRequired = q.requiredKeywords.some(
        (kw) => kw.trim() && haystack.includes(kw.trim().toLowerCase()),
      );
      if (!hasRequired) {
        return { passes: false, reason: `Missing required keywords: ${q.requiredKeywords.join(', ')}` };
      }
    }

    if (q.locations.length > 0) {
      const locHaystack = [lp.location, lp.headline, lp.about]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      const hasLocation = q.locations.some(
        (loc) => loc.trim() && locHaystack.includes(loc.trim().toLowerCase()),
      );
      if (!hasLocation) {
        return { passes: false, reason: `Location not in target list: ${q.locations.join(', ')}` };
      }
    }

    return { passes: true, reason: 'Passes local filters' };
  }

  // ── Stage 1 — Process new prospects ───────────────────────────────────────────

  async processNewProspects(): Promise<void> {
    this.throwIfStopped();
    const page = this.browserManager.getPage();
    const connMax = this.liConfig.connectionLimit.maximum;

    for (const query of this.liConfig.searches) {
      this.throwIfStopped();
      if (this.liConfig.connectionLimit.enabled && this.liStore.connectionsRemaining(connMax) <= 0) {
        this.liStore.logActivity('CONNECTION LIMIT REACHED — stopping new prospect search', 'warn');
        this.setStatus('idle', { lastError: 'Connection limit reached' });
        break;
      }

      this.setStatus('searching', { currentSearch: query });
      this.liStore.logActivity(`Search started: ${query}`);

      let hits;
      try {
        hits = await searchLinkedInPeople(page, query, this.liConfig.maximumProfilesPerSearch);
      } catch (err) {
        if (err instanceof SecurityChallengeError || err instanceof StopRequestedError) throw err;
        this.liStore.logActivity(`Search failed for "${query}": ${String(err)}`, 'error');
        continue;
      }

      for (const hit of hits) {
        this.throwIfStopped();
        if (this.liConfig.connectionLimit.enabled && this.liStore.connectionsRemaining(connMax) <= 0) {
          this.liStore.logActivity('CONNECTION LIMIT REACHED during search loop', 'warn');
          break;
        }

        // Duplicate protection
        if (this.liStore.hasConnectionSent(hit.profileUrl)) {
          logger.info(`[LinkedIn] Already processed, skipping: ${hit.profileUrl}`);
          continue;
        }

        this.stats.profilesInspected += 1;
        this.setStatus('inspecting_profile', { currentProfile: hit.profileUrl });
        this.prospectStore.trackEvent('linkedin', this.config.campaignId, 'discovered');

        try {
          await page.goto(hit.profileUrl, { waitUntil: 'domcontentloaded' });
          await page.waitForTimeout(2000);
          await assertNoLinkedInChallenge(page);

          const lp = await readLinkedInProfile(page, hit.profileUrl);

          // Stage 1a — local deterministic filter
          const local = this.passesLocalFilters(lp);
          if (!local.passes) {
            this.stats.profilesSkipped += 1;
            this.liStore.logActivity(`Profile skipped (local filter): ${lp.name} — ${local.reason}`);
            this.liStore.upsert({
              id: randomUUID(),
              platform: 'linkedin',
              profileUrl: lp.profileUrl,
              profileId: lp.profileId,
              name: lp.name,
              firstName: lp.firstName,
              company: lp.company,
              role: lp.jobTitle,
              headline: lp.headline,
              location: lp.location,
              searchQuery: query,
              qualification: { qualified: false, confidence: 0, reason: local.reason },
              connectionStatus: 'SKIPPED',
              connectionSentAt: null,
              messageSentAt: null,
              messageStatus: 'NONE',
              draftedMessage: null,
              lastCheckedAt: new Date().toISOString(),
            });
            await page.waitForTimeout(this.config.delays.betweenProfilesMs);
            continue;
          }

          // Stage 1b — Groq semantic qualification (cached)
          this.setStatus('qualifying', { currentProfile: hit.profileUrl });
          const snapshot = this.toProfileSnapshot(lp);

          let scored;
          try {
            scored = await this.groq.scoreAndQualifyProspect({
              platform: 'linkedin',
              profile: snapshot,
              localRules: this.config.qualification,
              platformRules: this.config.platformQualification.linkedin,
              linkedInExtras: {
                headline: lp.headline ?? undefined,
                jobTitle: lp.jobTitle ?? undefined,
                company: lp.company ?? undefined,
                about: lp.about ?? undefined,
                industry: lp.industry ?? undefined,
                location: lp.location ?? undefined,
              },
            });
          } catch (err) {
            if (err instanceof AiProcessingError) {
              this.liStore.logActivity(`AI error for ${lp.name}: ${err.message}`, 'error');
              this.stats.profilesSkipped += 1;
              if (this.config.stopOnAiError) throw new StopRequestedError(err.message);
              continue;
            }
            throw err;
          }

          const priority = calculatePriority(scored.score, this.config.priority);
          const passes =
            scored.qualified &&
            scored.score >= this.config.platformQualification.linkedin.minimumScore &&
            this.config.processPriority.includes(priority);

          if (!passes) {
            this.stats.profilesSkipped += 1;
            this.liStore.logActivity(`Profile skipped: ${lp.name} — score=${scored.score} ${scored.reason}`);
            this.prospectStore.trackEvent('linkedin', this.config.campaignId, 'skipped');
            this.liStore.upsert({
              id: randomUUID(),
              platform: 'linkedin',
              profileUrl: lp.profileUrl,
              profileId: lp.profileId,
              name: lp.name,
              firstName: lp.firstName,
              company: lp.company ?? scored.company ?? null,
              role: lp.jobTitle ?? scored.role ?? null,
              headline: lp.headline,
              location: lp.location ?? scored.location ?? null,
              searchQuery: query,
              qualification: { qualified: false, confidence: scored.confidence, reason: scored.reason },
              connectionStatus: 'SKIPPED',
              connectionSentAt: null,
              messageSentAt: null,
              messageStatus: 'NONE',
              draftedMessage: null,
              lastCheckedAt: new Date().toISOString(),
            });
            await page.waitForTimeout(this.config.delays.betweenProfilesMs);
            continue;
          }

          // Qualified — check if Connect button is visible
          this.stats.profilesQualified += 1;
          this.liStore.logActivity(`Profile qualified: ${lp.name} (score=${scored.score})`);
          this.prospectStore.trackEvent('linkedin', this.config.campaignId, 'qualified');

          const connState = await detectConnectionState(page);
          if (connState === 'connected' || connState === 'pending') {
            this.liStore.logActivity(`Already connected/pending: ${lp.name} — skipping`);
            this.liStore.upsert({
              id: randomUUID(),
              platform: 'linkedin',
              profileUrl: lp.profileUrl,
              profileId: lp.profileId,
              name: lp.name,
              firstName: lp.firstName,
              company: lp.company ?? scored.company ?? null,
              role: lp.jobTitle ?? scored.role ?? null,
              headline: lp.headline,
              location: lp.location ?? scored.location ?? null,
              searchQuery: query,
              qualification: { qualified: true, confidence: scored.confidence, reason: scored.reason },
              connectionStatus: connState === 'connected' ? 'ACCEPTED' : 'PENDING',
              connectionSentAt: null,
              messageSentAt: null,
              messageStatus: connState === 'connected' ? 'MESSAGE_PENDING' : 'NONE',
              draftedMessage: null,
              lastCheckedAt: new Date().toISOString(),
            });
            await page.waitForTimeout(this.config.delays.betweenProfilesMs);
            continue;
          }

          if (connState === 'none' || connState === 'unknown') {
            // Dry-run: skip sending
            if (this.config.dryRun) {
              this.liStore.logActivity(`[DRY-RUN] Would send connection to ${lp.name}`);
              this.liStore.upsert({
                id: randomUUID(),
                platform: 'linkedin',
                profileUrl: lp.profileUrl,
                profileId: lp.profileId,
                name: lp.name,
                firstName: lp.firstName,
                company: lp.company ?? scored.company ?? null,
                role: lp.jobTitle ?? scored.role ?? null,
                headline: lp.headline,
                location: lp.location ?? scored.location ?? null,
                searchQuery: query,
                qualification: { qualified: true, confidence: scored.confidence, reason: scored.reason },
                connectionStatus: 'QUALIFIED',
                connectionSentAt: null,
                messageSentAt: null,
                messageStatus: 'NONE',
                draftedMessage: null,
                lastCheckedAt: new Date().toISOString(),
              });
              await page.waitForTimeout(this.config.delays.betweenProfilesMs);
              continue;
            }

            // Send connection request
            const sent = await sendConnectionRequest(page);
            if (sent) {
              this.liStore.incrementConnections();
              const now = new Date().toISOString();
              this.liStore.upsert({
                id: randomUUID(),
                platform: 'linkedin',
                profileUrl: lp.profileUrl,
                profileId: lp.profileId,
                name: lp.name,
                firstName: lp.firstName,
                company: lp.company ?? scored.company ?? null,
                role: lp.jobTitle ?? scored.role ?? null,
                headline: lp.headline,
                location: lp.location ?? scored.location ?? null,
                searchQuery: query,
                qualification: { qualified: true, confidence: scored.confidence, reason: scored.reason },
                connectionStatus: 'PENDING',
                connectionSentAt: now,
                messageSentAt: null,
                messageStatus: 'NONE',
                draftedMessage: null,
                lastCheckedAt: now,
              });
              this.prospectStore.trackEvent('linkedin', this.config.campaignId, 'connection_sent');
              this.prospectStore.trackEvent('linkedin', this.config.campaignId, 'connection_pending');
              this.liStore.logActivity(`Connection request sent: ${lp.name}`);
              this.setStatus('searching', { currentSearch: query });
            } else {
              this.liStore.logActivity(`Could not send connection to ${lp.name} — no visible button`, 'warn');
              this.liStore.upsert({
                id: randomUUID(),
                platform: 'linkedin',
                profileUrl: lp.profileUrl,
                profileId: lp.profileId,
                name: lp.name,
                firstName: lp.firstName,
                company: lp.company ?? scored.company ?? null,
                role: lp.jobTitle ?? scored.role ?? null,
                headline: lp.headline,
                location: lp.location ?? scored.location ?? null,
                searchQuery: query,
                qualification: { qualified: true, confidence: scored.confidence, reason: scored.reason },
                connectionStatus: 'SKIPPED',
                connectionSentAt: null,
                messageSentAt: null,
                messageStatus: 'NONE',
                draftedMessage: null,
                lastCheckedAt: new Date().toISOString(),
              });
            }
          }

          // Upsert into shared prospect store too
          this.prospectStore.upsert({
            platform: 'linkedin',
            campaignId: this.config.campaignId,
            profileUrl: lp.profileUrl,
            username: lp.profileId,
            name: lp.name,
            firstName: lp.firstName,
            role: scored.role ?? lp.jobTitle ?? null,
            company: scored.company ?? lp.company ?? null,
            location: scored.location ?? lp.location ?? null,
            bio: lp.about ?? null,
            headline: lp.headline ?? null,
            leadScore: scored.score,
            leadConfidence: scored.confidence,
            priority,
            prospectType: scored.prospectType,
            qualificationReason: scored.reason,
            qualified: passes,
            scoringFactors: scored.factors,
            templateId: null,
            originalMessage: null,
            personalizedMessage: null,
            personalizationReason: null,
            connectionStatus: 'pending',
            messageStatus: 'connection_note_prepared',
            conversationStatus: 'CONTACTED',
            lastReplyText: null,
            lastAiCategory: null,
            lastSuggestedReply: null,
            suggestedReplyStatus: null,
            approvedReplyText: null,
            lastInteractionAt: new Date().toISOString(),
          });

        } catch (err) {
          if (err instanceof SecurityChallengeError || err instanceof StopRequestedError) throw err;
          this.liStore.logActivity(`Error on ${hit.profileUrl}: ${String(err)}`, 'error');
          this.stats.profilesSkipped += 1;
        }

        await page.waitForTimeout(this.config.delays.betweenProfilesMs);
      }
    }
  }

  // ── Stage 2 — Process pending connections ─────────────────────────────────────

  async processPendingConnections(): Promise<void> {
    this.throwIfStopped();
    const page = this.browserManager.getPage();
    const pending = this.liStore.getPending();
    const msgMax = this.liConfig.messageLimit.maximum;

    this.liStore.logActivity(`Processing ${pending.length} pending connection(s)...`);

    for (const conn of pending) {
      this.throwIfStopped();
      this.setStatus('inspecting_profile', { currentProfile: conn.profileUrl });

      try {
        await page.goto(conn.profileUrl, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2000);
        await assertNoLinkedInChallenge(page);

        const connState = await detectConnectionState(page);

        if (connState === 'pending') {
          // Still pending — leave in bucket, update lastCheckedAt
          this.liStore.upsert({
            ...conn,
            lastCheckedAt: new Date().toISOString(),
          });
          continue;
        }

        if (connState === 'connected') {
          // Connection accepted!
          this.liStore.logActivity(`Connection accepted: ${conn.name}`);
          this.prospectStore.trackEvent('linkedin', this.config.campaignId, 'connection_accepted');

          // Check message limit before proceeding
          if (this.liConfig.messageLimit.enabled && this.liStore.messagesRemaining(msgMax) <= 0) {
            this.liStore.logActivity('MESSAGE LIMIT REACHED — leaving as MESSAGE_PENDING', 'warn');
            this.liStore.upsert({
              ...conn,
              connectionStatus: 'ACCEPTED',
              messageStatus: 'MESSAGE_PENDING',
              lastCheckedAt: new Date().toISOString(),
            });
            continue;
          }

          // Already sent a message? Skip.
          if (conn.messageStatus === 'MESSAGE_SENT') {
            this.liStore.upsert({
              ...conn,
              connectionStatus: 'MESSAGE_SENT',
              lastCheckedAt: new Date().toISOString(),
            });
            continue;
          }

          // Read fresh profile data for personalization
          const lp = await readLinkedInProfile(page, conn.profileUrl);
          const snapshot = this.toProfileSnapshot(lp);

          // Select template
          const template = this.templates.select({
            platform: 'linkedin',
            stage: 'post_connection',
            prospectType: undefined,
            preferredId: this.config.selectedTemplateId || undefined,
          });

          // Personalize message
          let draftedMessage = '';
          try {
            const personalized = await this.groq.personalizeFromTemplate({
              templateBody: template.body,
              profile: snapshot,
              firstName: lp.firstName,
              role: lp.jobTitle,
              company: lp.company,
              location: lp.location,
              config: this.config.personalization,
            });
            draftedMessage = personalized.personalizedMessage;
          } catch (err) {
            if (err instanceof AiProcessingError) {
              // Fallback to template with substitution only
              const firstName = lp.firstName ?? lp.name.split(' ')[0] ?? 'there';
              draftedMessage = template.body
                .replaceAll('{first_name}', firstName)
                .replaceAll('{greeting_name}', firstName)
                .replaceAll('{name}', lp.name)
                .replaceAll('{company}', lp.company ?? 'your organisation')
                .replaceAll('{role}', lp.jobTitle ?? 'your field');
            } else {
              throw err;
            }
          }

          // Confirmation gate
          if (this.liConfig.requireConfirmationBeforeSend && !this.config.dryRun) {
            const pendingConf: LinkedInPendingConfirmation = {
              id: randomUUID(),
              profileUrl: conn.profileUrl,
              name: lp.name,
              draftedMessage,
            };
            this.liStore.logActivity(`Awaiting confirmation for message to ${lp.name}`);
            const decision = await this.waitForConfirmation(pendingConf);
            this.throwIfStopped();
            if (decision === 'reject') {
              this.liStore.logActivity(`Message rejected by user for ${lp.name}`);
              this.liStore.upsert({
                ...conn,
                connectionStatus: 'ACCEPTED',
                messageStatus: 'MESSAGE_PENDING',
                draftedMessage,
                lastCheckedAt: new Date().toISOString(),
              });
              continue;
            }
          }

          // Dry-run: never actually send
          if (this.config.dryRun) {
            this.liStore.logActivity(`[DRY-RUN] Would send message to ${lp.name}: ${draftedMessage.slice(0, 60)}...`);
            this.liStore.upsert({
              ...conn,
              connectionStatus: 'MESSAGE_SENT',
              messageStatus: 'MESSAGE_SENT',
              messageSentAt: new Date().toISOString(),
              draftedMessage,
              lastCheckedAt: new Date().toISOString(),
            });
            continue;
          }

          // Actually send
          const sent = await sendLinkedInMessage(page, draftedMessage);
          if (sent) {
            this.liStore.incrementMessages();
            this.liStore.upsert({
              ...conn,
              connectionStatus: 'MESSAGE_SENT',
              messageStatus: 'MESSAGE_SENT',
              messageSentAt: new Date().toISOString(),
              draftedMessage,
              lastCheckedAt: new Date().toISOString(),
            });
            this.prospectStore.trackEvent('linkedin', this.config.campaignId, 'message_sent');
            this.liStore.logActivity(`Message sent: ${lp.name}`);
          } else {
            this.liStore.logActivity(`Could not send message to ${lp.name} — no visible composer`, 'warn');
            this.liStore.upsert({
              ...conn,
              connectionStatus: 'ACCEPTED',
              messageStatus: 'MESSAGE_PENDING',
              draftedMessage,
              lastCheckedAt: new Date().toISOString(),
            });
          }

        } else {
          // unknown — update lastCheckedAt, keep in bucket
          this.liStore.upsert({
            ...conn,
            lastCheckedAt: new Date().toISOString(),
          });
        }

      } catch (err) {
        if (err instanceof SecurityChallengeError || err instanceof StopRequestedError) throw err;
        this.liStore.logActivity(`Error processing pending ${conn.profileUrl}: ${String(err)}`, 'error');
      }

      await page.waitForTimeout(this.config.delays.betweenProfilesMs);
    }

    this.liStore.logActivity('Pending connections processing complete.');
  }

  // ── Process a single pending connection manually ───────────────────────────────

  async processSinglePending(id: string): Promise<void> {
    const conn = this.liStore.getById(id);
    if (!conn) throw new Error(`Pending connection ${id} not found`);
    if (this.running) throw new Error('Agent is already running');
    this.running = true;
    this.stopRequested = false;
    try {
      this.groqStatus = await this.groq.checkConnection();
      await this.browserManager.launch();
      this.setStatus('waiting_login');
      await waitForLinkedInLogin(() => this.browserManager.getPage(), {
        onWaiting: () => this.setStatus('waiting_login'),
        onChallenge: (r) => this.setStatus('waiting_login', { lastError: r }),
      });
      this.sessionStore.markLoggedIn(undefined);
      // process only this specific connection
      // process only this specific connection
      await this.processSingleConnectionRecord(conn);
      this.setStatus('completed');
    } catch (err) {
      this.handleError(err);
    } finally {
      this.running = false;
      this.emit();
    }
  }

  private async processSingleConnectionRecord(conn: LinkedInPendingConnection): Promise<void> {
    const page = this.browserManager.getPage();
    await page.goto(conn.profileUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    await assertNoLinkedInChallenge(page);
    const connState = await detectConnectionState(page);
    if (connState === 'connected') {
      const lp = await readLinkedInProfile(page, conn.profileUrl);
      const snapshot = this.toProfileSnapshot(lp);
      const template = this.templates.select({
        platform: 'linkedin',
        stage: 'post_connection',
        preferredId: this.config.selectedTemplateId || undefined,
      });
      let draftedMessage = template.body
        .replaceAll('{first_name}', lp.firstName ?? 'there')
        .replaceAll('{greeting_name}', lp.firstName ?? 'there')
        .replaceAll('{name}', lp.name)
        .replaceAll('{company}', lp.company ?? 'your organisation');
      try {
        const p = await this.groq.personalizeFromTemplate({
          templateBody: template.body,
          profile: snapshot,
          firstName: lp.firstName,
          role: lp.jobTitle,
          company: lp.company,
          location: lp.location,
          config: this.config.personalization,
        });
        draftedMessage = p.personalizedMessage;
      } catch { /* use fallback */ }

      if (!this.config.dryRun) {
        const sent = await sendLinkedInMessage(page, draftedMessage);
        if (sent) {
          this.liStore.incrementMessages();
          this.liStore.upsert({ ...conn, connectionStatus: 'MESSAGE_SENT', messageStatus: 'MESSAGE_SENT', messageSentAt: new Date().toISOString(), draftedMessage, lastCheckedAt: new Date().toISOString() });
          this.liStore.logActivity(`Message sent (manual): ${lp.name}`);
        }
      } else {
        this.liStore.logActivity(`[DRY-RUN] Would message ${lp.name}`);
      }
    } else {
      this.liStore.upsert({ ...conn, lastCheckedAt: new Date().toISOString() });
    }
  }

  // ── Full run (Stage 2 then Stage 1) ──────────────────────────────────────────

  async start(): Promise<void> {
    if (this.running) { logger.warn('[LinkedIn] Agent already running'); return; }
    this.running = true;
    this.stopRequested = false;
    this.stats = {
      ...this.buildStats(),
      status: 'starting',
      profilesInspected: 0,
      profilesQualified: 0,
      profilesSkipped: 0,
    };
    this.emit();

    try {
      this.groqStatus = await this.groq.checkConnection();
      this.emit();

      await this.browserManager.launch();
      this.setStatus('waiting_login');
      await waitForLinkedInLogin(() => this.browserManager.getPage(), {
        onWaiting: () => this.setStatus('waiting_login'),
        onChallenge: (r) => {
          this.setStatus('waiting_login', { lastError: r });
          for (const l of this.securityListeners) { try { l(r); } catch { /* ignore */ } }
        },
      });
      this.sessionStore.markLoggedIn('linkedin-user');
      await this.browserManager
        .saveStorageState(this.config.linkedInBrowser.storageStateFile)
        .catch((e) => logger.warn(`[LinkedIn] Could not save storage state: ${String(e)}`));

      this.throwIfStopped();

      // Stage 2 first: process existing pending connections
      this.liStore.logActivity('Stage 2: Processing pending connections...');
      await this.processPendingConnections();
      this.throwIfStopped();

      // Stage 1: discover new prospects
      this.liStore.logActivity('Stage 1: Discovering new prospects...');
      await this.processNewProspects();

      this.setStatus(this.stopRequested ? 'stopped' : 'completed');
      this.liStore.logActivity('LinkedIn agent run complete.');
    } catch (err) {
      this.handleError(err);
    } finally {
      this.running = false;
      this.emit();
      logger.info('[LinkedIn] Agent finished — browser left open.');
    }
  }

  /** Run only Stage 1 (find + connect new prospects) */
  async startNewProspectsOnly(): Promise<void> {
    if (this.running) { logger.warn('[LinkedIn] Agent already running'); return; }
    this.running = true;
    this.stopRequested = false;
    this.stats = { ...this.buildStats(), status: 'starting', profilesInspected: 0, profilesQualified: 0, profilesSkipped: 0 };
    this.emit();
    try {
      this.groqStatus = await this.groq.checkConnection();
      await this.browserManager.launch();
      this.setStatus('waiting_login');
      await waitForLinkedInLogin(() => this.browserManager.getPage(), {
        onWaiting: () => this.setStatus('waiting_login'),
        onChallenge: (r) => this.setStatus('waiting_login', { lastError: r }),
      });
      this.sessionStore.markLoggedIn(undefined);
      await this.browserManager.saveStorageState(this.config.linkedInBrowser.storageStateFile).catch(() => undefined);
      this.throwIfStopped();
      await this.processNewProspects();
      this.setStatus(this.stopRequested ? 'stopped' : 'completed');
    } catch (err) {
      this.handleError(err);
    } finally {
      this.running = false;
      this.emit();
    }
  }

  /** Run only Stage 2 (process pending connections) */
  async startPendingOnly(): Promise<void> {
    if (this.running) { logger.warn('[LinkedIn] Agent already running'); return; }
    this.running = true;
    this.stopRequested = false;
    this.stats = { ...this.buildStats(), status: 'starting' };
    this.emit();
    try {
      this.groqStatus = await this.groq.checkConnection();
      await this.browserManager.launch();
      this.setStatus('waiting_login');
      await waitForLinkedInLogin(() => this.browserManager.getPage(), {
        onWaiting: () => this.setStatus('waiting_login'),
        onChallenge: (r) => this.setStatus('waiting_login', { lastError: r }),
      });
      this.sessionStore.markLoggedIn(undefined);
      await this.browserManager.saveStorageState(this.config.linkedInBrowser.storageStateFile).catch(() => undefined);
      this.throwIfStopped();
      await this.processPendingConnections();
      this.setStatus(this.stopRequested ? 'stopped' : 'completed');
    } catch (err) {
      this.handleError(err);
    } finally {
      this.running = false;
      this.emit();
    }
  }

  private handleError(err: unknown): void {
    if (err instanceof SecurityChallengeError) {
      this.setStatus('security_stop', { lastError: err.message });
      this.liStore.logActivity(`SECURITY STOP: ${err.message}`, 'error');
      for (const l of this.securityListeners) { try { l(err.message); } catch { /* ignore */ } }
      logger.warn('[LinkedIn] SECURITY STOP — browser left open for manual resolution');
    } else if (err instanceof StopRequestedError) {
      this.setStatus('stopped');
    } else {
      const msg = String(err);
      this.setStatus('error', { lastError: msg });
      this.liStore.logActivity(`Fatal error: ${msg}`, 'error');
    }
  }
}
