import { z } from 'zod';

export type Platform = 'instagram' | 'linkedin';
export type PriorityTier = 'A' | 'B' | 'C' | 'D';

export type ConversationStatus =
  | 'NEW'
  | 'CONTACTED'
  | 'REPLIED'
  | 'INTERESTED'
  | 'QUESTION'
  | 'PRICING'
  | 'CALL_REQUESTED'
  | 'FOLLOW_UP'
  | 'NOT_INTERESTED'
  | 'CLOSED';

export type ConnectionStatus =
  | 'none'
  | 'pending'
  | 'accepted'
  | 'withdrawn'
  | 'not_applicable';

export interface ScoringWeights {
  roleMatch: number;
  industryMatch: number;
  locationMatch: number;
  profileQuality: number;
  audienceSize: number;
  decisionMakerLikelihood: number;
  [key: string]: number;
}

export interface PlatformQualificationConfig {
  minimumScore: number;
  scoring: ScoringWeights;
  targetProspectTypes: string[];
  campaignGoal: string;
}

export interface PriorityTierConfig {
  A: { minimumScore: number; label: string };
  B: { minimumScore: number; label: string };
  C: { minimumScore: number; label: string };
  D: { label: string };
}

export interface PersonalizationConfig {
  enabled: boolean;
  maximumLength: number;
  allowedProfileFields: string[];
}

export interface TemplateDefinition {
  id: string;
  name: string;
  platform: Platform;
  stage: string;
  prospectTypes: string[];
  body: string;
}

export interface ProspectRecord {
  id: string;
  platform: Platform;
  campaignId: string;
  profileUrl: string;
  username: string;
  name: string;
  firstName: string | null;
  role: string | null;
  company: string | null;
  location: string | null;
  bio: string | null;
  headline: string | null;

  leadScore: number;
  leadConfidence: number;
  priority: PriorityTier;
  prospectType: string;
  qualificationReason: string;
  qualified: boolean;
  scoringFactors: Record<string, number>;

  templateId: string | null;
  originalMessage: string | null;
  personalizedMessage: string | null;
  personalizationReason: string | null;

  connectionStatus: ConnectionStatus;
  messageStatus: string;
  conversationStatus: ConversationStatus;

  lastReplyText: string | null;
  lastAiCategory: string | null;
  lastSuggestedReply: string | null;
  suggestedReplyStatus: 'pending' | 'approved' | 'edited' | 'skipped' | null;
  approvedReplyText: string | null;

  lastInteractionAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationAnalysis {
  category: string;
  confidence: number;
  sentiment: string;
  summary: string;
  suggestedReply: string;
}

export interface PlatformAnalytics {
  platform: Platform;
  profilesDiscovered: number;
  profilesInspected: number;
  profilesQualified: number;
  profilesSkipped: number;
  messagesPrepared: number;
  messagesSent: number;
  repliesReceived: number;
  interested: number;
  questions: number;
  notInterested: number;
  followUps: number;
  conversions: number;
  connectionsSent: number;
  connectionsAccepted: number;
  connectionsPending: number;
  qualificationRate: number;
  connectionAcceptanceRate: number;
  messageReplyRate: number;
  interestRate: number;
  followUpRate: number;
  conversionRate: number;
  priorityCounts: Record<PriorityTier, number>;
}

export const LeadScoreSchema = z.object({
  score: z.number().min(0).max(100),
  qualified: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1),
  prospectType: z.string().min(1),
  factors: z.record(z.number()),
  role: z.string().nullable().optional(),
  company: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
});

export const ConversationAnalysisSchema = z.object({
  category: z.enum([
    'INTERESTED',
    'QUESTION',
    'PRICING',
    'CALL_REQUEST',
    'NOT_INTERESTED',
    'LATER',
    'NEEDS_INFORMATION',
    'WRONG_PERSON',
    'OTHER',
  ]),
  confidence: z.number().min(0).max(1),
  sentiment: z.string(),
  summary: z.string(),
  suggestedReply: z.string(),
});

export const PersonalizationResultSchema = z.object({
  personalizedMessage: z.string().min(1),
  personalizationReason: z.string(),
});

export type LeadScoreResult = z.infer<typeof LeadScoreSchema>;
export type PersonalizationResult = z.infer<typeof PersonalizationResultSchema>;

export function calculatePriority(
  score: number,
  config: PriorityTierConfig,
): PriorityTier {
  if (score >= config.A.minimumScore) return 'A';
  if (score >= config.B.minimumScore) return 'B';
  if (score >= config.C.minimumScore) return 'C';
  return 'D';
}

export function priorityLabel(tier: PriorityTier, config: PriorityTierConfig): string {
  if (tier === 'D') return `D — ${config.D.label}`;
  return `${tier} — ${config[tier].label}`;
}

export function emptyPlatformAnalytics(platform: Platform): PlatformAnalytics {
  return {
    platform,
    profilesDiscovered: 0,
    profilesInspected: 0,
    profilesQualified: 0,
    profilesSkipped: 0,
    messagesPrepared: 0,
    messagesSent: 0,
    repliesReceived: 0,
    interested: 0,
    questions: 0,
    notInterested: 0,
    followUps: 0,
    conversions: 0,
    connectionsSent: 0,
    connectionsAccepted: 0,
    connectionsPending: 0,
    qualificationRate: 0,
    connectionAcceptanceRate: 0,
    messageReplyRate: 0,
    interestRate: 0,
    followUpRate: 0,
    conversionRate: 0,
    priorityCounts: { A: 0, B: 0, C: 0, D: 0 },
  };
}

export function computeRates(a: PlatformAnalytics): PlatformAnalytics {
  const qualBase = a.profilesInspected || 0;
  const sent = a.messagesSent || 0;
  const replies = a.repliesReceived || 0;
  const connSent = a.connectionsSent || 0;
  return {
    ...a,
    qualificationRate: qualBase ? (a.profilesQualified / qualBase) * 100 : 0,
    connectionAcceptanceRate: connSent ? (a.connectionsAccepted / connSent) * 100 : 0,
    messageReplyRate: sent ? (replies / sent) * 100 : 0,
    interestRate: replies ? (a.interested / replies) * 100 : 0,
    followUpRate: sent ? (a.followUps / sent) * 100 : 0,
    conversionRate: sent ? (a.conversions / sent) * 100 : 0,
  };
}
