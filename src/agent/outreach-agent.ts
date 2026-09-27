import { randomUUID } from 'crypto';
import type {
  AgentStateSnapshot,
  AgentStats,
  AgentStatus,
  AiProfileInsight,
  AppConfig,
  GroqDashboardStatus,
  OutreachRecord,
  PendingConfirmation,
  QualificationResult,
} from '../types';
import { SecurityChallengeError, StopRequestedError } from '../types';
import { logger } from '../logger';
import { BrowserManager } from '../browser/browser-manager';
import { waitForLoggedInSession, readLoggedInUsername } from '../browser/instagram/security';
import { openProfile, searchProfiles } from '../browser/instagram/search';
import {
  clickMessageButton,
  hasVisibleMessageButton,
  readVisibleProfile,
} from '../browser/instagram/profile';
import {
  clickSend,
  typeMessage,
  waitForMessageComposer,
} from '../browser/instagram/messaging';
import { evaluateProfile } from '../qualification';
import { LocalStore } from '../state/local-store';
import { SessionStore } from '../state/session-store';
import { QueryStore } from '../state/query-store';
import { AiProcessingError, GroqService } from '../services/groq';
import type { InstagramSessionStatus, PendingConversationReply } from '../types';
import { ProspectStore } from '../core/prospect-store';
import { TemplateLibrary } from '../core/template-library';
import { calculatePriority, priorityLabel } from '../core/lead-types';
import type { PriorityTier } from '../core/lead-types';

type StateListener = (state: AgentStateSnapshot) => void;
type SecurityListener = (reason: string) => void;

export class OutreachAgent {
  private browserManager: BrowserManager;
  private store: LocalStore;
  private sessionStore: SessionStore;
  private queryStore: QueryStore;
  private prospectStore: ProspectStore;
  private templates: TemplateLibrary;
  private groq: GroqService;
  private stopRequested = false;
  private running = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private messageLimitThisRun = 50;
  private pendingConfirmation: PendingConfirmation | null = null;
  private confirmationResolver:
    | ((decision: 'approve' | 'reject') => void)
    | null = null;
  private pendingConversationReply: PendingConversationReply | null = null;
  private conversationResolver:
    | ((decision: 'approve' | 'edit' | 'skip', edited?: string) => void)
    | null = null;
  private recentErrors: string[] = [];
  private listeners = new Set<StateListener>();
  private securityListeners = new Set<SecurityListener>();
  private currentAi: AiProfileInsight | null = null;
  private selectedTemplateId: string;
  private groqStatus: GroqDashboardStatus = {
    status: 'unconfigured',
    model: '',
    message: 'Not checked',
  };

  private stats: AgentStats = {
    profilesInspected: 0,
    profilesQualified: 0,
    profilesSkipped: 0,
    messagesSent: 0,
    messagesRemaining: 0,
    currentSearch: '',
    currentProfile: '',
    status: 'idle',
    lastError: '',
    dryRun: false,
  };

  constructor(
    private readonly config: AppConfig,
    groq?: GroqService,
    shared?: { prospectStore?: ProspectStore; templates?: TemplateLibrary },
  ) {
    this.browserManager = new BrowserManager(config.browser);
    this.store = new LocalStore(
      config.processedProfilesFile,
      config.resultsLogFile,
      config.aiCacheFile,
    );
    this.sessionStore = new SessionStore(
      config.browser.userDataDir,
      config.sessionMetaFile,
    );
    this.queryStore = new QueryStore('./data/instagram-queries.json', 'instagram');
    this.prospectStore = shared?.prospectStore ?? new ProspectStore(config.prospectsFile);
    this.templates = shared?.templates ?? new TemplateLibrary(config.templatesDir);
    this.groq = groq ?? new GroqService();
    this.groqStatus = this.groq.getStatus();
    this.stats.dryRun = config.dryRun;
    this.stats.messagesRemaining = config.maximumMessagesPerCampaign;
    this.selectedTemplateId = config.selectedTemplateId || '';
  }

  getProspectStore(): ProspectStore {
    return this.prospectStore;
  }

  getTemplates(): TemplateLibrary {
    return this.templates;
  }

  getQueryStore(): QueryStore {
    return this.queryStore;
  }

  setSelectedTemplateId(id: string): void {
    this.selectedTemplateId = id;
    this.emit();
  }

  onState(listener: StateListener): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  onSecurityStop(listener: SecurityListener): () => void {
    this.securityListeners.add(listener);
    return () => this.securityListeners.delete(listener);
  }

  private sessionStatus(): InstagramSessionStatus {
    const meta = this.sessionStore.getMeta();
    return {
      saved: meta.saved,
      savedAt: meta.savedAt,
      lastVerifiedAt: meta.lastVerifiedAt,
      username: meta.username,
      note: meta.note,
    };
  }

  getSnapshot(): AgentStateSnapshot {
    return {
      stats: { ...this.stats },
      recentErrors: [...this.recentErrors],
      pendingConfirmation: this.pendingConfirmation,
      pendingConversationReply: this.pendingConversationReply,
      recentRecords: this.store.getRecentRecords(30),
      stopRequested: this.stopRequested,
      groq: { ...this.groqStatus },
      currentAi: this.currentAi,
      session: this.sessionStatus(),
      linkedInSession: {
        saved: false,
        savedAt: null,
        lastVerifiedAt: null,
        username: null,
        note: 'Managed by LinkedIn agent',
      },
      activePlatform: 'instagram',
      selectedTemplateId: this.selectedTemplateId,
    };
  }

  getGroq(): GroqService {
    return this.groq;
  }

  /**
   * Remove saved Instagram login (browser profile + metadata).
   * Next Start will require signing in again.
   * Stops a running campaign first so profile files are not locked.
   */
  async clearSavedLogin(): Promise<InstagramSessionStatus> {
    if (this.running) {
      this.requestStop();
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (this.browserManager.isOpen()) {
      await this.browserManager.close();
    }
    this.sessionStore.clearSession();
    logger.info('Saved Instagram login cleared via dashboard');
    this.emit();
    return this.sessionStatus();
  }

  /**
   * Clear the current saved login so the next Start can replace it with a new account.
   */
  async replaceSavedLogin(): Promise<InstagramSessionStatus> {
    if (this.running) {
      this.requestStop();
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (this.browserManager.isOpen()) {
      await this.browserManager.close();
    }
    this.sessionStore.clearSession(
      'Previous login removed. Click Start and sign into Instagram once — it will be saved until you clear it again.',
    );
    logger.info('Saved Instagram login marked for replace via dashboard');
    this.emit();
    return this.sessionStatus();
  }

  async refreshGroqConnection(): Promise<GroqDashboardStatus> {
    this.groqStatus = await this.groq.checkConnection();
    this.emit();
    return this.groqStatus;
  }

  private emit(): void {
    const snap = this.getSnapshot();
    for (const l of this.listeners) {
      try {
        l(snap);
      } catch {
        // ignore
      }
    }
  }

  private setStatus(status: AgentStatus, extra?: Partial<AgentStats>): void {
    this.stats = { ...this.stats, status, ...extra };
    this.emit();
  }

  private setCurrentAi(insight: AiProfileInsight | null): void {
    this.currentAi = insight;
    this.emit();
  }

  private pushError(message: string): void {
    this.stats.lastError = message;
    this.recentErrors.unshift(message);
    if (this.recentErrors.length > 40) this.recentErrors.pop();
    logger.error(message);
    this.emit();
  }

  private throwIfStopped(): void {
    if (this.stopRequested) {
      throw new StopRequestedError();
    }
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  private scheduleAutoRestart(): void {
    const delay = this.config.autoRestartAfterMs;
    if (!delay || delay <= 0) return;
    this.clearRestartTimer();
    logger.info(
      `Instagram automation will restart in ${Math.round(delay / 60_000)} minute(s) if the app stays running`,
    );
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.running) {
        logger.info('Skipping auto-restart — agent already running');
        return;
      }
      logger.info('Auto-restarting Instagram automation after wait');
      void this.start().catch((err) => logger.error(`Auto-restart failed: ${String(err)}`));
    }, delay);
  }

  private pickMessageLimitThisRun(): number {
    const min = Math.max(1, this.config.minimumMessagesPerCampaign || 20);
    const max = Math.max(min, this.config.maximumMessagesPerCampaign || 50);
    return min + Math.floor(Math.random() * (max - min + 1));
  }

  requestStop(): void {
    logger.warn('STOP requested — workflow will halt as soon as possible');
    this.clearRestartTimer();
    this.stopRequested = true;
    if (this.confirmationResolver) {
      this.confirmationResolver('reject');
      this.confirmationResolver = null;
      this.pendingConfirmation = null;
    }
    this.setStatus('stopped');
  }

  respondToConfirmation(id: string, decision: 'approve' | 'reject'): boolean {
    if (!this.pendingConfirmation || this.pendingConfirmation.id !== id) {
      return false;
    }
    if (this.confirmationResolver) {
      this.confirmationResolver(decision);
      this.confirmationResolver = null;
    }
    return true;
  }

  private waitForConfirmation(pending: PendingConfirmation): Promise<'approve' | 'reject'> {
    this.pendingConfirmation = pending;
    this.setStatus('awaiting_confirmation');
    return new Promise((resolve) => {
      let settled = false;

      // Auto-approve after 10 seconds if no user action
      const autoApproveTimer = setTimeout(() => {
        if (!settled) {
          settled = true;
          logger.info(`Auto-approved message for @${pending.username} (10s timeout)`);
          this.confirmationResolver = null;
          this.pendingConfirmation = null;
          resolve('approve');
        }
      }, 10_000);

      this.confirmationResolver = (decision) => {
        if (!settled) {
          settled = true;
          clearTimeout(autoApproveTimer);
          this.pendingConfirmation = null;
          resolve(decision);
        }
      };
    });
  }

  private record(partial: Omit<OutreachRecord, 'id' | 'timestamp'>): OutreachRecord {
    const record: OutreachRecord = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      ...partial,
    };
    this.store.appendResult(record);
    this.emit();
    return record;
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * Local filters → Groq score/qualify → priority → template → personalization.
   * Caches AI score per profile; always rebuilds message from current template.
   */
  private async runAiPipeline(
    profile: Awaited<ReturnType<typeof readVisibleProfile>>,
    forceRefresh = false,
  ): Promise<{
    qualification: QualificationResult;
    insight: AiProfileInsight;
    priority: PriorityTier;
  }> {
    const platformRules = this.config.platformQualification.instagram;
    const existing = this.prospectStore.get('instagram', profile.profileUrl);
    const cachedAi = forceRefresh ? null : this.store.getAiCache(profile.profileUrl);

    let leadScore = existing?.leadScore;
    let confidence = existing?.leadConfidence;
    let reason = existing?.qualificationReason;
    let prospectType = existing?.prospectType;
    let factors = existing?.scoringFactors;
    let qualified = existing?.qualified;
    let role = existing?.role ?? null;
    let company = existing?.company ?? null;
    let location = existing?.location ?? profile.locationText ?? null;
    let fromCache = false;

    if (
      !forceRefresh &&
      cachedAi &&
      typeof (cachedAi as { leadScore?: number }).leadScore === 'number'
    ) {
      const c = cachedAi as typeof cachedAi & {
        leadScore: number;
        leadConfidence?: number;
        prospectType?: string;
        scoringFactors?: Record<string, number>;
        role?: string | null;
        company?: string | null;
        location?: string | null;
        qualified?: boolean;
        reason?: string;
      };
      leadScore = c.leadScore;
      confidence = c.leadConfidence ?? c.confidence;
      reason = c.reason ?? cachedAi.reason;
      prospectType = c.prospectType ?? 'unknown';
      factors = c.scoringFactors ?? {};
      qualified = c.qualified ?? cachedAi.qualified;
      role = c.role ?? null;
      company = c.company ?? null;
      location = c.location ?? profile.locationText ?? null;
      fromCache = true;
      logger.info(`Using cached lead score for @${profile.username}: ${leadScore}`);
    } else {
      const scored = await this.groq.scoreAndQualifyProspect({
        platform: 'instagram',
        profile,
        localRules: this.config.qualification,
        platformRules,
      });
      leadScore = scored.score;
      confidence = scored.confidence;
      reason = scored.reason;
      prospectType = scored.prospectType;
      factors = scored.factors;
      qualified = scored.qualified;
      role = scored.role ?? null;
      company = scored.company ?? null;
      location = scored.location ?? profile.locationText ?? null;
      this.store.setAiCache({
        profileUrl: profile.profileUrl,
        username: profile.username,
        displayedName: profile.displayedName,
        qualified: Boolean(qualified),
        confidence: confidence ?? 0,
        reason: reason ?? '',
        extractedFirstName: null,
        generatedMessage: '',
        timestamp: new Date().toISOString(),
        leadScore,
        leadConfidence: confidence,
        prospectType,
        scoringFactors: factors,
        role,
        company,
        location,
      });
    }

    const score = leadScore ?? 0;
    const priority = calculatePriority(score, this.config.priority);
    const pLabel = priorityLabel(priority, this.config.priority);
    const passesTier = this.config.processPriority.includes(priority);
    const finalQualified = Boolean(qualified) && score >= platformRules.minimumScore && passesTier;

    let extractedFirstName: string | null = existing?.firstName ?? null;
    let generatedMessage = '';
    let originalMessage = '';
    let personalizationReason = '';
    let templateId = '';
    let templateName = '';

    if (finalQualified) {
      if (!extractedFirstName) {
        const nameResult = await this.groq.extractFirstName(profile);
        extractedFirstName = nameResult.first_name;
      }
      const template = this.templates.select({
        platform: 'instagram',
        stage: 'initial_contact',
        prospectType: prospectType || undefined,
        preferredId: this.selectedTemplateId || undefined,
      });
      templateId = template.id;
      templateName = template.name;
      originalMessage = template.body;

      const personalized = await this.groq.personalizeFromTemplate({
        templateBody: template.body,
        profile,
        firstName: extractedFirstName,
        role,
        company,
        location,
        config: this.config.personalization,
      });
      generatedMessage = personalized.personalizedMessage;
      personalizationReason = personalized.personalizationReason;

      this.prospectStore.trackEvent('instagram', this.config.campaignId, 'qualified');
      this.prospectStore.trackEvent('instagram', this.config.campaignId, 'message_prepared');
    } else {
      this.prospectStore.trackEvent('instagram', this.config.campaignId, 'skipped', {
        priority,
        score,
      });
    }

    this.prospectStore.upsert({
      platform: 'instagram',
      campaignId: this.config.campaignId,
      profileUrl: profile.profileUrl,
      username: profile.username,
      name: profile.displayedName,
      firstName: extractedFirstName,
      role,
      company,
      location,
      bio: profile.bio || null,
      headline: null,
      leadScore: score,
      leadConfidence: confidence ?? 0,
      priority,
      prospectType: prospectType || 'unknown',
      qualificationReason: reason || '',
      qualified: finalQualified,
      scoringFactors: factors || {},
      templateId: templateId || null,
      originalMessage: originalMessage || null,
      personalizedMessage: generatedMessage || null,
      personalizationReason: personalizationReason || null,
      connectionStatus: 'not_applicable',
      messageStatus: finalQualified ? 'prepared' : 'skipped_not_qualified',
      conversationStatus: 'NEW',
      lastReplyText: null,
      lastAiCategory: null,
      lastSuggestedReply: null,
      suggestedReplyStatus: null,
      approvedReplyText: null,
      lastInteractionAt: new Date().toISOString(),
    });

    const insight: AiProfileInsight = {
      profileUrl: profile.profileUrl,
      username: profile.username,
      displayedName: profile.displayedName,
      qualified: finalQualified,
      confidence: confidence ?? 0,
      reason: reason || '',
      extractedFirstName,
      generatedMessage,
      fromCache,
      timestamp: new Date().toISOString(),
      leadScore: score,
      priority,
      priorityLabel: pLabel,
      prospectType: prospectType || 'unknown',
      scoringFactors: factors || {},
      templateId,
      templateName,
      originalMessage,
      personalizationReason,
    };
    this.setCurrentAi(insight);

    logger.info(
      `Lead @${profile.username}: score=${score} priority=${priority} type=${prospectType} qualified=${finalQualified}`,
    );

    return {
      qualification: {
        qualifies: finalQualified,
        reasons: [
          reason || '',
          `Score ${score}/100 · ${pLabel}`,
          passesTier ? '' : `Tier ${priority} not in processPriority`,
        ].filter(Boolean),
        ai: {
          confidence: confidence ?? 0,
          reason: reason || '',
          fromCache,
        },
      },
      insight,
      priority,
    };
  }

  async start(): Promise<void> {
    if (this.running) {
      logger.warn('Agent already running');
      return;
    }
    this.clearRestartTimer();
    this.running = true;
    this.stopRequested = false;
    this.currentAi = null;
    this.messageLimitThisRun = this.pickMessageLimitThisRun();
    this.stats = {
      profilesInspected: 0,
      profilesQualified: 0,
      profilesSkipped: 0,
      messagesSent: 0,
      messagesRemaining: this.messageLimitThisRun,
      currentSearch: '',
      currentProfile: '',
      status: 'starting',
      lastError: '',
      dryRun: this.config.dryRun,
    };
    this.emit();
    logger.info(
      `Instagram run message limit: ${this.messageLimitThisRun} (range ${this.config.minimumMessagesPerCampaign}–${this.config.maximumMessagesPerCampaign})`,
    );

    try {
      this.groqStatus = await this.groq.checkConnection();
      this.emit();

      const page =       await this.browserManager.launch();
      this.setStatus('waiting_login');
      if (this.sessionStore.getMeta().saved) {
        logger.info('Reusing saved Instagram browser session (no login required unless expired)');
      } else {
        logger.info('No saved Instagram login — sign in once in the browser; it will be kept for future runs');
      }
      await waitForLoggedInSession(() => this.browserManager.getPage(), {
        onWaiting: () => this.setStatus('waiting_login'),
        onSecurityChallenge: (reason) => {
          this.setStatus('waiting_login', {
            lastError: `Security check in progress — complete it in the browser (window stays open). ${reason}`,
          });
          this.emit();
        },
      });
      const username = await readLoggedInUsername(this.browserManager.getPage());
      this.sessionStore.markLoggedIn(username);
      await this.browserManager
        .saveStorageState(this.config.browser.storageStateFile)
        .catch((err) => logger.warn(`Could not save storage state: ${String(err)}`));
      this.emit();
      this.throwIfStopped();

      let campaignMessages = 0;

      // ── Query sets for this run ───────────────────────────────────────────────
      // Set 1 first. If message target (20–50) is not reached, run set 2 next.
      const MAX_QUERIES_PER_SET = 999;
      const MAX_QUERY_SETS = 2;
      const storeSeeds = this.queryStore.getSeeds();

      for (let setIndex = 0; setIndex < MAX_QUERY_SETS; setIndex += 1) {
        this.throwIfStopped();
        if (campaignMessages >= this.messageLimitThisRun) {
          logger.info('Campaign message limit reached');
          break;
        }

        let activeQueries: string[];
        if (storeSeeds.length > 0) {
          activeQueries = this.queryStore.getQueriesForRun(MAX_QUERIES_PER_SET);
          const preview = this.queryStore.previewNextRun(MAX_QUERIES_PER_SET);
          logger.info(
            `[Instagram] Query set ${setIndex + 1}/${MAX_QUERY_SETS}: ${activeQueries.join(', ')}`,
          );
          logger.info(`[Instagram] Following set preview (${preview.round}): ${preview.queries.join(', ')}`);
        } else {
          const start = setIndex * MAX_QUERIES_PER_SET;
          activeQueries = this.config.searchQueries.slice(start, start + MAX_QUERIES_PER_SET);
          if (!activeQueries.length) {
            logger.info('[Instagram] No more config search queries for another set');
            break;
          }
          logger.info(
            `[Instagram] Query set ${setIndex + 1}/${MAX_QUERY_SETS} (config): ${activeQueries.join(', ')}`,
          );
        }

        if (!activeQueries.length) break;

        if (setIndex > 0) {
          logger.info(
            `Message target ${this.messageLimitThisRun} not reached yet (${campaignMessages}) — executing next query set`,
          );
        }

      for (const query of activeQueries) {
        this.throwIfStopped();
        const page = this.browserManager.getPage();
        if (campaignMessages >= this.messageLimitThisRun) {
          logger.info('Campaign message limit reached');
          break;
        }

        this.setStatus('searching', { currentSearch: query, currentProfile: '' });
        let hits;
        try {
          // Collect all visible results for this query — no artificial early stop.
          // maximumProfilesPerSearch acts as a hard ceiling only.
          hits = await searchProfiles(page, query, this.config.maximumProfilesPerSearch * 3);
          await page.waitForTimeout(this.config.delays.afterSearchMs);
          for (let i = 0; i < hits.length; i++) {
            this.prospectStore.trackEvent('instagram', this.config.campaignId, 'discovered');
          }
        } catch (err) {
          if (err instanceof SecurityChallengeError) throw err;
          this.pushError(`Search failed for "${query}": ${String(err)}`);
          if (!this.config.continueAutomaticallyAfterSearch) break;
          continue;
        }

        if (!hits.length) {
          this.pushError(`Search results not loading / empty for "${query}"`);
          if (!this.config.continueAutomaticallyAfterSearch) break;
          continue;
        }

        logger.info(`[Instagram] "${query}" — ${hits.length} profiles to evaluate`);
        let profilesThisSearch = 0;
        let messagesThisSearch = 0;

        for (const hit of hits) {
          this.throwIfStopped();
          // Hard ceiling — safety net only; we want to process ALL hits
          if (profilesThisSearch >= this.config.maximumProfilesPerSearch) {
            logger.info(`Safety ceiling reached for "${query}" (${this.config.maximumProfilesPerSearch})`);
            break;
          }
          if (campaignMessages >= this.messageLimitThisRun) {
            break;
          }

          if (this.store.hasProcessed(hit.profileUrl)) {
            logger.info(`Skipping already-processed profile ${hit.username}`);
            this.stats.profilesSkipped += 1;
            this.record({
              searchQuery: query,
              profileUrl: hit.profileUrl,
              username: hit.username,
              displayedName: '',
              qualification: { qualifies: false, reasons: ['Already processed'] },
              messageStatus: 'skipped_already_processed',
            });
            this.emit();
            continue;
          }

          profilesThisSearch += 1;
          this.setStatus('inspecting_profile', {
            currentProfile: hit.profileUrl,
            profilesInspected: this.stats.profilesInspected + 1,
          });
          this.stats.profilesInspected += 1;

          try {
            const page = this.browserManager.getPage();
            await openProfile(page, hit.profileUrl, this.config.delays.afterOpenProfileMs);
            this.throwIfStopped();

            this.setStatus('qualifying');
            const profile = await readVisibleProfile(page, hit.profileUrl);

            // 1) Deterministic local filters — skip Groq if these fail
            const localQualification = evaluateProfile(profile, this.config.qualification);
            if (!localQualification.qualifies) {
              logger.info(
                `Local filter reject @${profile.username}: ${localQualification.reasons.join('; ')}`,
              );
              this.stats.profilesSkipped += 1;
              this.setCurrentAi(null);
              this.record({
                searchQuery: query,
                profileUrl: profile.profileUrl,
                username: profile.username,
                displayedName: profile.displayedName,
                qualification: localQualification,
                messageStatus: 'skipped_not_qualified',
              });
              this.emit();
              await page.waitForTimeout(this.config.delays.betweenProfilesMs);
              continue;
            }

            // 2) Groq AI qualification (cached)
            let qualification: QualificationResult;
            let insight: AiProfileInsight;
            try {
              ({ qualification, insight } = await this.runAiPipeline(profile));
              this.prospectStore.trackEvent('instagram', this.config.campaignId, 'inspected');
            } catch (err) {
              const msg =
                err instanceof AiProcessingError
                  ? err.message
                  : `AI ERROR — Unable to process this profile. ${String(err)}`;
              this.pushError(`AI ERROR — Unable to process @${profile.username}. ${msg}`);
              this.setCurrentAi({
                profileUrl: profile.profileUrl,
                username: profile.username,
                displayedName: profile.displayedName,
                qualified: false,
                confidence: 0,
                reason: 'AI ERROR — Unable to process this profile.',
                extractedFirstName: null,
                generatedMessage: '',
                fromCache: false,
                error: msg,
                timestamp: new Date().toISOString(),
              });
              this.stats.profilesSkipped += 1;
              this.record({
                searchQuery: query,
                profileUrl: profile.profileUrl,
                username: profile.username,
                displayedName: profile.displayedName,
                qualification: {
                  qualifies: false,
                  reasons: ['AI ERROR — Unable to process this profile.'],
                },
                messageStatus: 'skipped_ai_error',
                error: msg,
              });
              if (this.config.stopOnAiError) {
                throw new StopRequestedError('Stopped due to AI error (stopOnAiError=true)');
              }
              await page.waitForTimeout(this.config.delays.betweenProfilesMs);
              continue;
            }

            if (!qualification.qualifies) {
              logger.info(
                `AI not qualified @${profile.username}: ${qualification.reasons.join('; ')}`,
              );
              this.stats.profilesSkipped += 1;
              this.record({
                searchQuery: query,
                profileUrl: profile.profileUrl,
                username: profile.username,
                displayedName: profile.displayedName,
                qualification,
                messageStatus: 'skipped_not_qualified',
                aiConfidence: qualification.ai?.confidence,
                aiReason: qualification.ai?.reason,
                extractedFirstName: insight.extractedFirstName,
              });
              this.emit();
              await page.waitForTimeout(this.config.delays.betweenProfilesMs);
              continue;
            }

            this.stats.profilesQualified += 1;
            this.emit();

            const drafted = insight.generatedMessage;
            if (!drafted?.trim()) {
              this.pushError(`AI ERROR — No generated message for @${profile.username}`);
              this.stats.profilesSkipped += 1;
              this.record({
                searchQuery: query,
                profileUrl: profile.profileUrl,
                username: profile.username,
                displayedName: profile.displayedName,
                qualification,
                messageStatus: 'skipped_ai_error',
                aiConfidence: qualification.ai?.confidence,
                aiReason: qualification.ai?.reason,
                error: 'Malformed/empty AI message — not sending',
              });
              if (this.config.stopOnAiError) {
                throw new StopRequestedError('Stopped due to AI error (stopOnAiError=true)');
              }
              continue;
            }

            // Dry-run: AI ran; do not open composer / send
            if (this.config.dryRun) {
              logger.info(`[DRY-RUN] AI message for @${profile.username}: ${drafted}`);
              campaignMessages += 1;
              messagesThisSearch += 1;
              this.stats.messagesSent += 1;
              this.stats.messagesRemaining = Math.max(
                0,
                this.messageLimitThisRun - campaignMessages,
              );
              this.record({
                searchQuery: query,
                profileUrl: profile.profileUrl,
                username: profile.username,
                displayedName: profile.displayedName,
                qualification,
                messageStatus: 'dry_run_drafted',
                draftedMessage: drafted,
                aiConfidence: qualification.ai?.confidence,
                aiReason: qualification.ai?.reason,
                extractedFirstName: insight.extractedFirstName,
              });
              this.emit();
              await page.waitForTimeout(this.config.delays.betweenProfilesMs);
              continue;
            }

            const canMessage = await hasVisibleMessageButton(page);
            if (!canMessage) {
              logger.info(`No Message button for @${profile.username} — skipping`);
              this.stats.profilesSkipped += 1;
              this.record({
                searchQuery: query,
                profileUrl: profile.profileUrl,
                username: profile.username,
                displayedName: profile.displayedName,
                qualification,
                messageStatus: 'skipped_no_message_button',
                aiConfidence: qualification.ai?.confidence,
                aiReason: qualification.ai?.reason,
                draftedMessage: drafted,
                extractedFirstName: insight.extractedFirstName,
              });
              this.emit();
              await page.waitForTimeout(this.config.delays.betweenProfilesMs);
              continue;
            }

            this.setStatus('messaging');
            await clickMessageButton(page);
            try {
              await waitForMessageComposer(page);
            } catch (err) {
              this.pushError(`Message composer unavailable for @${profile.username}: ${String(err)}`);
              this.stats.profilesSkipped += 1;
              this.record({
                searchQuery: query,
                profileUrl: profile.profileUrl,
                username: profile.username,
                displayedName: profile.displayedName,
                qualification,
                messageStatus: 'failed',
                error: 'Message composer unavailable',
                draftedMessage: drafted,
                aiConfidence: qualification.ai?.confidence,
                aiReason: qualification.ai?.reason,
              });
              continue;
            }

            await typeMessage(page, drafted, this.config.delays.typingDelayMs);
            this.throwIfStopped();

            let shouldSend = !this.config.requireConfirmationBeforeSend;
            if (this.config.requireConfirmationBeforeSend) {
              const pending: PendingConfirmation = {
                id: randomUUID(),
                profileUrl: profile.profileUrl,
                username: profile.username,
                displayedName: profile.displayedName,
                draftedMessage: drafted,
                searchQuery: query,
              };
              const decision = await this.waitForConfirmation(pending);
              this.throwIfStopped();
              shouldSend = decision === 'approve';
              if (!shouldSend) {
                this.stats.profilesSkipped += 1;
                this.record({
                  searchQuery: query,
                  profileUrl: profile.profileUrl,
                  username: profile.username,
                  displayedName: profile.displayedName,
                  qualification,
                  messageStatus: 'rejected_by_user',
                  draftedMessage: drafted,
                  aiConfidence: qualification.ai?.confidence,
                  aiReason: qualification.ai?.reason,
                  extractedFirstName: insight.extractedFirstName,
                });
                this.emit();
                await page.waitForTimeout(this.config.delays.betweenProfilesMs);
                continue;
              }
            }

            if (shouldSend) {
              await clickSend(page);
              campaignMessages += 1;
              messagesThisSearch += 1;
              this.stats.messagesSent += 1;
              this.stats.messagesRemaining = Math.max(
                0,
                this.messageLimitThisRun - campaignMessages,
              );
              logger.info(`Message sent to @${profile.username}`);
              this.prospectStore.trackEvent('instagram', this.config.campaignId, 'message_sent');
              const existingProspect = this.prospectStore.get('instagram', profile.profileUrl);
              if (existingProspect) {
                this.prospectStore.upsert({
                  ...existingProspect,
                  messageStatus: 'sent',
                  conversationStatus: 'CONTACTED',
                  lastInteractionAt: new Date().toISOString(),
                });
              }
              this.record({
                searchQuery: query,
                profileUrl: profile.profileUrl,
                username: profile.username,
                displayedName: profile.displayedName,
                qualification,
                messageStatus: 'sent',
                draftedMessage: drafted,
                aiConfidence: qualification.ai?.confidence,
                aiReason: qualification.ai?.reason,
                extractedFirstName: insight.extractedFirstName,
                leadScore: insight.leadScore,
                priority: insight.priority,
                prospectType: insight.prospectType,
              });
              this.emit();
            }
          } catch (err) {
            if (err instanceof SecurityChallengeError || err instanceof StopRequestedError) {
              throw err;
            }
            this.pushError(`Error on profile ${hit.profileUrl}: ${String(err)}`);
            this.stats.profilesSkipped += 1;
            this.record({
              searchQuery: query,
              profileUrl: hit.profileUrl,
              username: hit.username,
              displayedName: '',
              qualification: { qualifies: false, reasons: ['Error during processing'] },
              messageStatus: 'failed',
              error: String(err),
            });
          }

          await page.waitForTimeout(this.config.delays.betweenProfilesMs);
        }

        logger.info(
          `Finished search "${query}" — profiles opened this search: ${profilesThisSearch}, messages: ${messagesThisSearch}`,
        );

        if (!this.config.continueAutomaticallyAfterSearch) {
          logger.info('continueAutomaticallyAfterSearch=false — stopping after this search');
          break;
        }
      }

        if (campaignMessages >= this.messageLimitThisRun) break;
        if (!this.config.continueAutomaticallyAfterSearch) break;
      }

      this.setStatus(this.stopRequested ? 'stopped' : 'completed', {
        currentProfile: '',
      });
      logger.info('Campaign finished');
    } catch (err) {
      if (err instanceof StopRequestedError) {
        this.setStatus('stopped');
        logger.warn(`Workflow stopped: ${err.message}`);
      } else if (err instanceof SecurityChallengeError) {
        this.setStatus('security_stop', { lastError: err.message });
        this.pushError(err.message);
        logger.warn(
          'SECURITY STOP — browser stays open. Finish Instagram verification there, then click Start again.',
        );
        for (const l of this.securityListeners) {
          try {
            l(err.message);
          } catch {
            // ignore
          }
        }
      } else {
        this.setStatus('error', { lastError: String(err) });
        this.pushError(`Fatal agent error: ${String(err)}`);
      }
    } finally {
      // Never auto-close the browser after login / campaign.
      // Closing mid-CAPTCHA was wiping the window; user closes via dashboard or Clear login.
      const shouldAutoRestart = this.stats.status === 'completed';
      this.running = false;
      this.pendingConfirmation = null;
      this.confirmationResolver = null;
      this.emit();
      logger.info(
        'Browser left open. Use dashboard "Close browser" when done, or Clear/Replace login to wipe the session.',
      );
      if (shouldAutoRestart) {
        this.scheduleAutoRestart();
      }
    }
  }

  /**
   * Open browser and wait for Instagram login only (no outreach).
   * Use this first if the window keeps closing during campaign Start.
   */
  async loginOnly(): Promise<void> {
    if (this.running) {
      throw new Error('Agent is already running — press STOP first');
    }
    this.running = true;
    this.stopRequested = false;
    this.setStatus('waiting_login', { lastError: '' });
    try {
      await this.browserManager.launch();
      logger.info('Login-only mode: sign in / finish CAPTCHA in the browser. Window will stay open.');
      await waitForLoggedInSession(() => this.browserManager.getPage(), {
        onWaiting: () => this.setStatus('waiting_login'),
        onSecurityChallenge: (reason) => {
          this.setStatus('waiting_login', {
            lastError: `Complete security check in the browser — do not close it. ${reason}`,
          });
        },
      });
      const username = await readLoggedInUsername(this.browserManager.getPage());
      this.sessionStore.markLoggedIn(username);
      await this.browserManager
        .saveStorageState(this.config.browser.storageStateFile)
        .catch((err) => logger.warn(`Could not save storage state: ${String(err)}`));
      this.setStatus('idle', {
        lastError: '',
      });
      logger.info(
        `Login saved${username ? ` (@${username})` : ''}. Browser stays open — click Start when ready to run outreach.`,
      );
    } catch (err) {
      this.setStatus('error', { lastError: String(err) });
      this.pushError(`Login failed: ${String(err)}`);
      throw err;
    } finally {
      this.running = false;
      this.emit();
      logger.info('Login-only finished — browser left open on purpose');
    }
  }

  /** Explicitly close the Playwright window (does not delete saved login). */
  async closeBrowser(): Promise<void> {
    if (this.running) {
      this.requestStop();
      await new Promise((r) => setTimeout(r, 800));
    }
    await this.browserManager.close();
    logger.info('Browser closed from dashboard');
    this.emit();
  }
}
