import Groq from 'groq-sdk';
import { z } from 'zod';
import { logger } from '../logger';
import type { ProfileSnapshot, QualificationRules } from '../types';
import type {
  ConversationAnalysis,
  LeadScoreResult,
  PersonalizationConfig,
  PersonalizationResult,
  PlatformQualificationConfig,
} from '../core/lead-types';
import {
  ConversationAnalysisSchema,
  LeadScoreSchema,
  PersonalizationResultSchema,
} from '../core/lead-types';
import {
  AiNameExtractionSchema,
  AiQualificationSchema,
  AiReplyClassificationSchema,
  type AiNameExtraction,
  type AiQualification,
  type AiReplyClassification,
} from './ai-schemas';
import { applyMessageTemplate, resolveGreetingName } from '../message-template';

export const DEFAULT_GROQ_MODEL = 'openai/gpt-oss-20b';

export type GroqConnectionStatus = 'connected' | 'error' | 'unconfigured';

export interface GroqStatus {
  status: GroqConnectionStatus;
  model: string;
  message: string;
}

/** Minimal chat surface so unit tests can inject a mock without the real SDK. */
export interface GroqChatClient {
  chat: {
    completions: {
      create: (body: {
        model: string;
        messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
        temperature?: number;
        response_format?: { type: 'json_object' };
      }) => Promise<{ choices: Array<{ message?: { content?: string | null } }> }>;
    };
  };
}

export class AiProcessingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiProcessingError';
  }
}

function sanitizeErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/gsk_[A-Za-z0-9]+/g, '[REDACTED]').replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
}

function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) return fence[1].trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

function profilePayload(profile: ProfileSnapshot): Record<string, unknown> {
  return {
    profileUrl: profile.profileUrl,
    username: profile.username || 'unknown',
    displayedName: profile.displayedName || 'unknown',
    bio: profile.bio || 'unknown',
    followers: profile.followers === null ? 'unknown' : profile.followers,
    following: profile.following === null ? 'unknown' : profile.following,
    posts: profile.posts === null ? 'unknown' : profile.posts,
    verified: profile.isVerified,
    private: profile.isPrivate === null ? 'unknown' : profile.isPrivate,
    categoryHints: profile.accountTypeHints.length ? profile.accountTypeHints : ['unknown'],
    locationText: profile.locationText || 'unknown',
  };
}

export class GroqService {
  private readonly model: string;
  private readonly client: GroqChatClient | null;
  private status: GroqStatus;

  constructor(options?: {
    apiKey?: string;
    model?: string;
    client?: GroqChatClient;
  }) {
    const apiKey = (options?.apiKey ?? process.env.GROQ_API_KEY ?? '').trim();
    this.model = (options?.model ?? process.env.GROQ_MODEL ?? DEFAULT_GROQ_MODEL).trim() || DEFAULT_GROQ_MODEL;

    if (options?.client) {
      this.client = options.client;
      this.status = {
        status: 'connected',
        model: this.model,
        message: 'Using injected Groq client',
      };
      return;
    }

    if (!apiKey) {
      this.client = null;
      this.status = {
        status: 'unconfigured',
        model: this.model,
        message: 'GROQ_API_KEY is not set',
      };
      return;
    }

    this.client = new Groq({ apiKey });
    this.status = {
      status: 'error',
      model: this.model,
      message: 'Not verified yet',
    };
  }

  getModel(): string {
    return this.model;
  }

  getStatus(): GroqStatus {
    return { ...this.status };
  }

  /** Lightweight connectivity check — never logs the API key. */
  async checkConnection(): Promise<GroqStatus> {
    if (!this.client) {
      this.status = {
        status: 'unconfigured',
        model: this.model,
        message: 'GROQ_API_KEY is not set',
      };
      return this.getStatus();
    }

    try {
      await this.client.chat.completions.create({
        model: this.model,
        temperature: 0,
        messages: [
          {
            role: 'user',
            content: 'Reply with a json object exactly like: {"ok":true}',
          },
        ],
        response_format: { type: 'json_object' },
      });
      this.status = {
        status: 'connected',
        model: this.model,
        message: 'Connected',
      };
      logger.info(`Groq connected (model=${this.model})`);
    } catch (err) {
      this.status = {
        status: 'error',
        model: this.model,
        message: sanitizeErrorMessage(err),
      };
      logger.error(`Groq connection error: ${this.status.message}`);
    }
    return this.getStatus();
  }

  private async complete(system: string, user: string): Promise<string> {
    if (!this.client) {
      throw new AiProcessingError('Groq is not configured (missing GROQ_API_KEY)');
    }
    try {
      const completion = await this.client.chat.completions.create({
        model: this.model,
        temperature: 0.1,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        response_format: { type: 'json_object' },
      });
      const content = completion.choices[0]?.message?.content;
      if (!content?.trim()) {
        throw new AiProcessingError('Empty response from Groq');
      }
      return content;
    } catch (err) {
      if (err instanceof AiProcessingError) throw err;
      throw new AiProcessingError(`Groq API failure: ${sanitizeErrorMessage(err)}`);
    }
  }

  private async completeText(system: string, user: string): Promise<string> {
    if (!this.client) {
      throw new AiProcessingError('Groq is not configured (missing GROQ_API_KEY)');
    }
    try {
      const completion = await this.client.chat.completions.create({
        model: this.model,
        temperature: 0.2,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      });
      const content = completion.choices[0]?.message?.content;
      if (!content?.trim()) {
        throw new AiProcessingError('Empty response from Groq');
      }
      return content.trim();
    } catch (err) {
      if (err instanceof AiProcessingError) throw err;
      throw new AiProcessingError(`Groq API failure: ${sanitizeErrorMessage(err)}`);
    }
  }

  /**
   * Parse model output with Zod. On schema/JSON failure, one safe retry is attempted.
   */
  async parseWithRetry<T>(
    schema: z.ZodType<T>,
    system: string,
    user: string,
    repairHint: string,
  ): Promise<T> {
    const first = await this.complete(system, user);
    const parsedFirst = this.tryParse(schema, first);
    if (parsedFirst.ok) return parsedFirst.value;

    logger.warn(`Invalid Groq JSON/schema — retrying once: ${parsedFirst.error}`);
    const second = await this.complete(
      system,
      `${user}\n\nYour previous reply was invalid (${parsedFirst.error}). ${repairHint}\nPrevious reply:\n${first}`,
    );
    const parsedSecond = this.tryParse(schema, second);
    if (parsedSecond.ok) return parsedSecond.value;

    throw new AiProcessingError(
      `AI response validation failed after retry: ${parsedSecond.error}`,
    );
  }

  private tryParse<T>(
    schema: z.ZodType<T>,
    raw: string,
  ): { ok: true; value: T } | { ok: false; error: string } {
    try {
      const jsonText = extractJsonObject(raw);
      const data: unknown = JSON.parse(jsonText);
      const result = schema.safeParse(data);
      if (!result.success) {
        return { ok: false, error: result.error.issues.map((i) => i.message).join('; ') };
      }
      return { ok: true, value: result.data };
    } catch (err) {
      return { ok: false, error: sanitizeErrorMessage(err) };
    }
  }

  async qualifyProfile(
    profile: ProfileSnapshot,
    rules: QualificationRules,
  ): Promise<AiQualification> {
    const system = [
      'You qualify Instagram profiles for outreach using ONLY the provided visible data.',
      'Do not invent facts. If a field is "unknown", treat it as unknown — do not guess.',
      'Return a strict json object only with keys: qualified (boolean), confidence (0-1), reason (string).',
    ].join(' ');

    const user = JSON.stringify(
      {
        task: 'qualify_profile',
        rules,
        profile: profilePayload(profile),
      },
      null,
      2,
    );

    return this.parseWithRetry(
      AiQualificationSchema,
      system,
      user,
      'Return valid JSON: {"qualified":boolean,"confidence":number,"reason":string}',
    );
  }

  async extractFirstName(profile: ProfileSnapshot): Promise<AiNameExtraction> {
    const system = [
      'Extract a usable personal first name from visible Instagram profile data.',
      'Do not guess. If unreliable, return first_name null and confidence 0.',
      'Business/brand names that are not a person should yield first_name null.',
      'Return a strict json object: {"first_name": string|null, "confidence": number}',
    ].join(' ');

    const user = JSON.stringify(
      {
        task: 'extract_first_name',
        profile: profilePayload(profile),
      },
      null,
      2,
    );

    const result = await this.parseWithRetry(
      AiNameExtractionSchema,
      system,
      user,
      'Return valid JSON: {"first_name":string|null,"confidence":number}',
    );

    if (result.first_name === null) {
      return { first_name: null, confidence: 0 };
    }
    return result;
  }

  /**
   * Builds the outreach message from the template.
   * When allowPersonalization is false, only placeholder substitution is applied (no LLM rewrite).
   */
  async personalizeMessage(options: {
    template: string;
    firstName: string | null;
    displayedName: string;
    profile: ProfileSnapshot;
    allowPersonalization: boolean;
  }): Promise<string> {
    const greetingName = resolveGreetingName({
      firstName: options.firstName,
      displayedName: options.displayedName,
      username: options.profile.username,
    });
    const base = applyMessageTemplate(options.template, {
      firstName: options.firstName?.trim() || greetingName,
      displayedName: options.displayedName || greetingName,
      greetingName,
      username: options.profile.username,
    });

    if (!options.allowPersonalization) {
      return base;
    }

    const system = [
      'You lightly personalize an outreach message.',
      'Keep the user intent and meaning. Do NOT completely rewrite.',
      'Only small adjustments are allowed (tone, one short relevant visible detail).',
      'Do not invent facts, pricing, guarantees, or claims.',
      'Keep the greeting name as provided (person name, brand, or "Brand team").',
      'Return ONLY the final message as plain text (no JSON, no markdown).',
    ].join(' ');

    const user = JSON.stringify(
      {
        task: 'personalize_message',
        templateMessage: base,
        profile: profilePayload(options.profile),
        firstName: options.firstName,
        greetingName,
      },
      null,
      2,
    );

    try {
      const text = await this.completeText(system, user);
      if (!text || text.length < 5) {
        throw new AiProcessingError('Personalized message was empty');
      }
      if (text.trim().startsWith('{')) {
        throw new AiProcessingError('Personalized message looked like JSON');
      }
      return text;
    } catch (err) {
      logger.warn(`Message personalization failed; using template substitution. ${sanitizeErrorMessage(err)}`);
      return base;
    }
  }

  async classifyReply(replyText: string): Promise<AiReplyClassification> {
    const system = [
      'Classify an incoming Instagram reply for outreach follow-up.',
      'Categories: INTERESTED, QUESTION, PRICING, CALL_REQUEST, NOT_INTERESTED, LATER, OTHER.',
      'suggested_reply must not invent facts, pricing, guarantees, or claims.',
      'Return a strict json object: {"category":"...","confidence":number,"suggested_reply":"..."}',
    ].join(' ');

    const user = JSON.stringify(
      {
        task: 'classify_reply',
        replyText: replyText || 'unknown',
      },
      null,
      2,
    );

    return this.parseWithRetry(
      AiReplyClassificationSchema,
      system,
      user,
      'Return valid JSON with category, confidence, suggested_reply',
    );
  }

  /**
   * Combined lead scoring + intelligent prospect understanding (one Groq call).
   */
  async scoreAndQualifyProspect(options: {
    platform: 'instagram' | 'linkedin';
    profile: ProfileSnapshot;
    localRules: QualificationRules;
    platformRules: PlatformQualificationConfig;
    linkedInExtras?: {
      headline?: string;
      jobTitle?: string;
      company?: string;
      about?: string;
      industry?: string;
      location?: string;
    };
  }): Promise<LeadScoreResult> {
    const factorKeys = Object.keys(options.platformRules.scoring);
    const system = [
      `You score and classify a ${options.platform} outreach prospect using ONLY visible profile data.`,
      'Do not invent facts. Unknown fields stay unknown.',
      'Distinguish prospect types such as: doctor, medical_student, clinic_owner, healthcare_employee, healthcare_influencer, recruiter, marketing_agency, founder, irrelevant.',
      `Score 0-100 using these max weights: ${JSON.stringify(options.platformRules.scoring)}.`,
      'Factor values must sum to score (approximately) and each factor must be <= its max weight.',
      'qualified=true only if the prospect matches campaign targets and score >= minimumScore.',
      'Return strict json: score, qualified, confidence, reason, prospectType, factors, role, company, location.',
    ].join(' ');

    const user = JSON.stringify(
      {
        task: 'score_and_qualify',
        platform: options.platform,
        minimumScore: options.platformRules.minimumScore,
        scoringWeights: options.platformRules.scoring,
        targetProspectTypes: options.platformRules.targetProspectTypes,
        campaignGoal: options.platformRules.campaignGoal,
        localFilters: options.localRules,
        profile: {
          ...profilePayload(options.profile),
          ...(options.linkedInExtras ?? {}),
        },
        requiredFactorKeys: factorKeys,
      },
      null,
      2,
    );

    const result = await this.parseWithRetry(
      LeadScoreSchema,
      system,
      user,
      'Return valid JSON with score(0-100), qualified, confidence, reason, prospectType, factors',
    );

    // Clamp score/factors
    const score = Math.max(0, Math.min(100, Math.round(result.score)));
    const factors: Record<string, number> = {};
    for (const [k, max] of Object.entries(options.platformRules.scoring)) {
      const raw = Number(result.factors?.[k] ?? 0);
      factors[k] = Math.max(0, Math.min(max, Number.isFinite(raw) ? raw : 0));
    }
    const qualified = Boolean(result.qualified) && score >= options.platformRules.minimumScore;

    return {
      ...result,
      score,
      factors,
      qualified,
      role: result.role ?? null,
      company: result.company ?? null,
      location: result.location ?? null,
    };
  }

  async personalizeFromTemplate(options: {
    templateBody: string;
    profile: ProfileSnapshot;
    firstName: string | null;
    role?: string | null;
    company?: string | null;
    location?: string | null;
    config: PersonalizationConfig;
  }): Promise<PersonalizationResult> {
    const greetingName = resolveGreetingName({
      firstName: options.firstName,
      displayedName: options.profile.displayedName,
      username: options.profile.username,
    });
    const vars: Record<string, string> = {
      greeting_name: greetingName,
      first_name: options.firstName?.trim() || greetingName,
      name: options.profile.displayedName || greetingName,
      company: options.company || 'your company',
      role: options.role || 'your work',
      location: options.location || options.profile.locationText || '',
      bio: options.profile.bio || '',
    };
    let base = options.templateBody;
    for (const [k, v] of Object.entries(vars)) {
      base = base.replaceAll(`{${k}}`, v);
    }

    if (!options.config.enabled) {
      return {
        personalizedMessage: base.slice(0, options.config.maximumLength),
        personalizationReason: 'Personalization disabled — template variables only',
      };
    }

    const system = [
      'Lightly personalize an outreach template using ONLY allowed visible profile fields.',
      'Do NOT invent achievements, relationships, product usage, prior conversations, or company facts.',
      'Preserve the original purpose and CTA. Do not fully rewrite.',
      `Max length ~${options.config.maximumLength} characters.`,
      'Return strict json: {"personalizedMessage":"...","personalizationReason":"..."}',
    ].join(' ');

    const allowed: Record<string, string> = {};
    for (const field of options.config.allowedProfileFields) {
      if (field === 'first_name') allowed.first_name = vars.first_name;
      if (field === 'role') allowed.role = vars.role;
      if (field === 'company') allowed.company = vars.company;
      if (field === 'location') allowed.location = vars.location;
      if (field === 'bio') allowed.bio = vars.bio;
      if (field === 'name') allowed.name = vars.name;
    }

    const user = JSON.stringify({
      task: 'personalize_template',
      templateMessage: base,
      allowedVisibleFields: allowed,
    });

    try {
      const result = await this.parseWithRetry(
        PersonalizationResultSchema,
        system,
        user,
        'Return JSON with personalizedMessage and personalizationReason',
      );
      return {
        personalizedMessage: result.personalizedMessage.slice(0, options.config.maximumLength),
        personalizationReason: result.personalizationReason,
      };
    } catch (err) {
      logger.warn(`Template personalization failed; using base. ${sanitizeErrorMessage(err)}`);
      return {
        personalizedMessage: base.slice(0, options.config.maximumLength),
        personalizationReason: 'Fallback to template substitution',
      };
    }
  }

  async analyzeConversation(options: {
    platform: 'instagram' | 'linkedin';
    conversationText: string;
    prospectName?: string;
  }): Promise<ConversationAnalysis> {
    const system = [
      `Classify an incoming ${options.platform} reply for outreach follow-up.`,
      'Categories: INTERESTED, QUESTION, PRICING, CALL_REQUEST, NOT_INTERESTED, LATER, NEEDS_INFORMATION, WRONG_PERSON, OTHER.',
      'Do not invent prices, services, guarantees, company facts, product claims, availability, or prior conversations.',
      'If information is missing, say so in suggestedReply instead of fabricating.',
      'Return strict json: category, confidence, sentiment, summary, suggestedReply.',
    ].join(' ');

    const user = JSON.stringify({
      task: 'analyze_conversation',
      prospectName: options.prospectName || 'unknown',
      conversationText: options.conversationText || 'unknown',
    });

    return this.parseWithRetry(
      ConversationAnalysisSchema,
      system,
      user,
      'Return valid conversation analysis JSON',
    );
  }
}
