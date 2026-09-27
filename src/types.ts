import type {
  PersonalizationConfig,
  Platform,
  PlatformQualificationConfig,
  PriorityTierConfig,
} from './core/lead-types';

export type AccountVisibility = 'public' | 'private' | 'any';

export interface QualificationRules {
  verifiedRequired: boolean;
  verifiedOptional: boolean;
  minFollowers: number;
  maxFollowers: number;
  accountVisibility: AccountVisibility;
  requiredBioKeywords: string[];
  excludedBioKeywords: string[];
  requiredLocationKeywords: string[];
  requiredAccountTypeKeywords: string[];
}

export interface BrowserConfig {
  headless: boolean;
  userDataDir: string;
  executablePath: string;
  useSystemChrome: boolean;
  storageStateFile: string;
  slowMoMs: number;
  navigationTimeoutMs: number;
  actionTimeoutMs: number;
}

export interface DelayConfig {
  betweenProfilesMs: number;
  afterSearchMs: number;
  afterOpenProfileMs: number;
  typingDelayMs: number;
}

export interface AppConfig {
  campaignId: string;
  campaignName: string;
  /** Active platform for primary Start control; LinkedIn has its own controls */
  activePlatform: Platform;
  searchQueries: string[];
  linkedInSearchQueries: string[];
  qualification: QualificationRules;
  /** Per-platform AI scoring / intelligent qualification */
  platformQualification: {
    instagram: PlatformQualificationConfig;
    linkedin: PlatformQualificationConfig;
  };
  priority: PriorityTierConfig;
  processPriority: Array<'A' | 'B' | 'C' | 'D'>;
  personalization: PersonalizationConfig;
  /** Preferred template id (optional); auto-select if empty */
  selectedTemplateId: string;
  templatesDir: string;
  prospectsFile: string;
  messageTemplate: string;
  maximumProfilesPerSearch: number;
  /** Lower bound for messages per run (inclusive) */
  minimumMessagesPerCampaign: number;
  /** Upper bound for messages per run (inclusive) */
  maximumMessagesPerCampaign: number;
  /** After a completed run, auto-start again after this many ms (0 = off) */
  autoRestartAfterMs: number;
  requireConfirmationBeforeSend: boolean;
  /** Auto-send conversation suggested replies (default false) */
  autoSendConversationReplies: boolean;
  continueAutomaticallyAfterSearch: boolean;
  dryRun: boolean;
  allowAiMessagePersonalization: boolean;
  stopOnAiError: boolean;
  minAiQualificationConfidence: number;
  outputDir: string;
  resultsLogFile: string;
  processedProfilesFile: string;
  aiCacheFile: string;
  sessionMetaFile: string;
  linkedInSessionMetaFile: string;
  linkedInBrowser: BrowserConfig;
  dashboardPort: number;
  browser: BrowserConfig;
  delays: DelayConfig;
}

export type AgentStatus =
  | 'idle'
  | 'starting'
  | 'waiting_login'
  | 'searching'
  | 'inspecting_profile'
  | 'qualifying'
  | 'awaiting_confirmation'
  | 'messaging'
  | 'paused'
  | 'stopped'
  | 'completed'
  | 'error'
  | 'security_stop';

export type MessageStatus =
  | 'not_attempted'
  | 'skipped_no_message_button'
  | 'skipped_not_qualified'
  | 'skipped_already_processed'
  | 'skipped_limit'
  | 'skipped_ai_error'
  | 'awaiting_confirmation'
  | 'rejected_by_user'
  | 'sent'
  | 'dry_run_drafted'
  | 'failed';

export interface ProfileSnapshot {
  profileUrl: string;
  username: string;
  displayedName: string;
  firstName: string;
  bio: string;
  followers: number | null;
  following: number | null;
  posts: number | null;
  isVerified: boolean;
  isPrivate: boolean | null;
  accountTypeHints: string[];
  locationText: string;
}

export interface QualificationResult {
  qualifies: boolean;
  reasons: string[];
  /** Present when Groq AI qualification was used */
  ai?: {
    confidence: number;
    reason: string;
    fromCache: boolean;
  };
}

export interface AiProfileInsight {
  profileUrl: string;
  username: string;
  displayedName: string;
  qualified: boolean;
  confidence: number;
  reason: string;
  extractedFirstName: string | null;
  generatedMessage: string;
  fromCache: boolean;
  error?: string;
  timestamp: string;
  /** Lead intelligence */
  leadScore?: number;
  priority?: 'A' | 'B' | 'C' | 'D';
  priorityLabel?: string;
  prospectType?: string;
  scoringFactors?: Record<string, number>;
  templateId?: string;
  templateName?: string;
  originalMessage?: string;
  personalizationReason?: string;
}

export interface OutreachRecord {
  id: string;
  timestamp: string;
  searchQuery: string;
  profileUrl: string;
  username: string;
  displayedName: string;
  qualification: QualificationResult;
  messageStatus: MessageStatus;
  draftedMessage?: string;
  aiConfidence?: number;
  aiReason?: string;
  extractedFirstName?: string | null;
  leadScore?: number;
  priority?: string;
  prospectType?: string;
  error?: string;
}

export interface PendingConfirmation {
  id: string;
  profileUrl: string;
  username: string;
  displayedName: string;
  draftedMessage: string;
  searchQuery: string;
}

export interface PendingConversationReply {
  id: string;
  prospectId: string;
  platform: 'instagram' | 'linkedin';
  name: string;
  category: string;
  confidence: number;
  summary: string;
  suggestedReply: string;
  lastMessage: string;
}

export interface GroqDashboardStatus {
  status: 'connected' | 'error' | 'unconfigured';
  model: string;
  message: string;
}

export interface InstagramSessionStatus {
  saved: boolean;
  savedAt: string | null;
  lastVerifiedAt: string | null;
  username: string | null;
  note: string;
}

export interface AgentStats {
  profilesInspected: number;
  profilesQualified: number;
  profilesSkipped: number;
  messagesSent: number;
  messagesRemaining: number;
  currentSearch: string;
  currentProfile: string;
  status: AgentStatus;
  lastError: string;
  dryRun: boolean;
}

export interface AgentStateSnapshot {
  stats: AgentStats;
  recentErrors: string[];
  pendingConfirmation: PendingConfirmation | null;
  pendingConversationReply: PendingConversationReply | null;
  recentRecords: OutreachRecord[];
  stopRequested: boolean;
  groq: GroqDashboardStatus;
  currentAi: AiProfileInsight | null;
  session: InstagramSessionStatus;
  linkedInSession: InstagramSessionStatus;
  activePlatform: 'instagram' | 'linkedin';
  selectedTemplateId: string;
}

export type DashboardEvent =
  | { type: 'state'; payload: AgentStateSnapshot }
  | { type: 'log'; payload: { level: string; message: string; timestamp: string } }
  | { type: 'confirmation_needed'; payload: PendingConfirmation }
  | { type: 'security_stop'; payload: { reason: string } };

export class SecurityChallengeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecurityChallengeError';
  }
}

export class StopRequestedError extends Error {
  constructor(message = 'Stop requested by user') {
    super(message);
    this.name = 'StopRequestedError';
  }
}
