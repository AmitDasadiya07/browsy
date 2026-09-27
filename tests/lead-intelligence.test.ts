import { describe, expect, it, vi } from 'vitest';
import {
  calculatePriority,
  computeRates,
  emptyPlatformAnalytics,
  LeadScoreSchema,
  ConversationAnalysisSchema,
} from '../src/core/lead-types';
import { TemplateLibrary } from '../src/core/template-library';
import { ProspectStore } from '../src/core/prospect-store';
import { GroqService, type GroqChatClient } from '../src/services/groq';
import { resolveGreetingName, applyMessageTemplate } from '../src/message-template';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ProfileSnapshot, QualificationRules } from '../src/types';

const priorityConfig = {
  A: { minimumScore: 80, label: 'High Priority' },
  B: { minimumScore: 65, label: 'Good' },
  C: { minimumScore: 50, label: 'Low Priority' },
  D: { label: 'Skip' },
};

const sampleProfile: ProfileSnapshot = {
  profileUrl: 'https://www.instagram.com/drjane/',
  username: 'drjane',
  displayedName: 'Jane Smith MD',
  firstName: 'Jane',
  bio: 'Board-certified dermatologist',
  followers: 25000,
  following: 100,
  posts: 50,
  isVerified: true,
  isPrivate: false,
  accountTypeHints: ['Doctor'],
  locationText: 'Delhi',
};

const rules: QualificationRules = {
  verifiedRequired: false,
  verifiedOptional: true,
  minFollowers: 10000,
  maxFollowers: 500000,
  accountVisibility: 'public',
  requiredBioKeywords: [],
  excludedBioKeywords: [],
  requiredLocationKeywords: [],
  requiredAccountTypeKeywords: [],
};

function mockClient(responses: string[]): GroqChatClient {
  let i = 0;
  return {
    chat: {
      completions: {
        create: vi.fn(async () => {
          const content = responses[Math.min(i, responses.length - 1)] ?? '';
          i += 1;
          return { choices: [{ message: { content } }] };
        }),
      },
    },
  };
}

describe('Priority calculation', () => {
  it('maps score boundaries', () => {
    expect(calculatePriority(100, priorityConfig)).toBe('A');
    expect(calculatePriority(80, priorityConfig)).toBe('A');
    expect(calculatePriority(79, priorityConfig)).toBe('B');
    expect(calculatePriority(65, priorityConfig)).toBe('B');
    expect(calculatePriority(50, priorityConfig)).toBe('C');
    expect(calculatePriority(49, priorityConfig)).toBe('D');
    expect(calculatePriority(0, priorityConfig)).toBe('D');
  });
});

describe('Lead scoring schema', () => {
  it('accepts valid score response', () => {
    const parsed = LeadScoreSchema.safeParse({
      score: 87,
      qualified: true,
      confidence: 0.94,
      reason: 'Strong match',
      prospectType: 'doctor',
      factors: { roleMatch: 25, industryMatch: 20 },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects out-of-bound scores', () => {
    expect(LeadScoreSchema.safeParse({ score: 120, qualified: true, confidence: 1, reason: 'x', prospectType: 'doctor', factors: {} }).success).toBe(false);
  });
});

describe('Groq lead scoring', () => {
  it('scores and qualifies with mocked Groq', async () => {
    const groq = new GroqService({
      client: mockClient([
        JSON.stringify({
          score: 87,
          qualified: true,
          confidence: 0.94,
          reason: 'Dermatologist match',
          prospectType: 'dermatologist',
          factors: {
            roleMatch: 25,
            industryMatch: 20,
            locationMatch: 15,
            profileQuality: 12,
            audienceSize: 7,
            decisionMakerLikelihood: 8,
          },
          role: 'Dermatologist',
          company: null,
          location: 'Delhi',
        }),
      ]),
    });
    const result = await groq.scoreAndQualifyProspect({
      platform: 'instagram',
      profile: sampleProfile,
      localRules: rules,
      platformRules: {
        minimumScore: 70,
        scoring: {
          roleMatch: 25,
          industryMatch: 20,
          locationMatch: 15,
          profileQuality: 15,
          audienceSize: 10,
          decisionMakerLikelihood: 15,
        },
        targetProspectTypes: ['doctor', 'dermatologist'],
        campaignGoal: 'find doctors',
      },
    });
    expect(result.score).toBe(87);
    expect(result.qualified).toBe(true);
  });

  it('handles invalid JSON then failure', async () => {
    const groq = new GroqService({ client: mockClient(['nope', 'still-bad']) });
    await expect(
      groq.scoreAndQualifyProspect({
        platform: 'instagram',
        profile: sampleProfile,
        localRules: rules,
        platformRules: {
          minimumScore: 70,
          scoring: {
            roleMatch: 25,
            industryMatch: 20,
            locationMatch: 15,
            profileQuality: 15,
            audienceSize: 10,
            decisionMakerLikelihood: 15,
          },
          targetProspectTypes: ['doctor'],
          campaignGoal: 'x',
        },
      }),
    ).rejects.toThrow();
  });
});

describe('Name / greeting / personalization', () => {
  it('extracts person greeting', () => {
    expect(resolveGreetingName({ firstName: 'Jane', displayedName: 'Jane Smith' })).toBe('Jane');
  });
  it('uses brand team for clinics', () => {
    expect(
      resolveGreetingName({ firstName: null, displayedName: 'SKIN+ Clinic by Euromedica Group' }),
    ).toMatch(/team$/i);
  });
  it('applies template vars', () => {
    const msg = applyMessageTemplate('Hi {greeting_name}', {
      firstName: 'Jane',
      displayedName: 'Jane Smith',
      greetingName: 'Jane',
    });
    expect(msg).toBe('Hi Jane');
  });
  it('personalizes with mock when enabled', async () => {
    const groq = new GroqService({
      client: mockClient([
        JSON.stringify({
          personalizedMessage: 'Hi Jane, noticed your dermatology work.',
          personalizationReason: 'Used bio specialty',
        }),
      ]),
    });
    const result = await groq.personalizeFromTemplate({
      templateBody: 'Hi {first_name}, hello',
      profile: sampleProfile,
      firstName: 'Jane',
      config: { enabled: true, maximumLength: 300, allowedProfileFields: ['first_name', 'bio'] },
    });
    expect(result.personalizedMessage.toLowerCase()).toContain('jane');
  });
});

describe('Template selection', () => {
  it('selects doctor template for instagram', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpl-'));
    const lib = new TemplateLibrary(dir);
    const t = lib.select({ platform: 'instagram', stage: 'initial_contact', prospectType: 'dermatologist' });
    expect(t.platform).toBe('instagram');
    expect(t.body.length).toBeGreaterThan(10);
  });
});

describe('Conversation classification', () => {
  it('classifies interested replies', async () => {
    const groq = new GroqService({
      client: mockClient([
        JSON.stringify({
          category: 'INTERESTED',
          confidence: 0.92,
          sentiment: 'positive',
          summary: 'Interested',
          suggestedReply: 'Happy to share more.',
        }),
      ]),
    });
    const result = await groq.analyzeConversation({
      platform: 'instagram',
      conversationText: 'Sure, send more info',
    });
    expect(result.category).toBe('INTERESTED');
    expect(ConversationAnalysisSchema.safeParse(result).success).toBe(true);
  });
});

describe('Analytics + prospect store separation', () => {
  it('tracks instagram and linkedin separately and caches prospects', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pros-'));
    const store = new ProspectStore(path.join(dir, 'prospects.json'));
    store.trackEvent('instagram', 'c1', 'inspected');
    store.trackEvent('instagram', 'c1', 'qualified');
    store.trackEvent('instagram', 'c1', 'message_sent');
    store.trackEvent('linkedin', 'c1', 'connection_sent');
    store.trackEvent('linkedin', 'c1', 'connection_accepted');
    const ig = store.getAnalytics('instagram', 'c1');
    const li = store.getAnalytics('linkedin', 'c1');
    expect(ig.profilesInspected).toBe(1);
    expect(ig.messagesSent).toBe(1);
    expect(li.connectionsSent).toBe(1);
    expect(li.connectionsAccepted).toBe(1);
    expect(ig.messagesSent).not.toBe(li.messagesSent);

    store.upsert({
      platform: 'instagram',
      campaignId: 'c1',
      profileUrl: 'https://www.instagram.com/a/',
      username: 'a',
      name: 'A',
      firstName: 'A',
      role: null,
      company: null,
      location: null,
      bio: null,
      headline: null,
      leadScore: 90,
      leadConfidence: 0.9,
      priority: 'A',
      prospectType: 'doctor',
      qualificationReason: 'x',
      qualified: true,
      scoringFactors: {},
      templateId: null,
      originalMessage: null,
      personalizedMessage: null,
      personalizationReason: null,
      connectionStatus: 'not_applicable',
      messageStatus: 'sent',
      conversationStatus: 'CONTACTED',
      lastReplyText: null,
      lastAiCategory: null,
      lastSuggestedReply: null,
      lastInteractionAt: new Date().toISOString(),
    });
    expect(store.get('instagram', 'https://www.instagram.com/a/')?.leadScore).toBe(90);
    const rates = computeRates(emptyPlatformAnalytics('instagram'));
    expect(rates.qualificationRate).toBe(0);
  });
});

describe('Unknown profile fields', () => {
  it('keeps unknown followers as unknown in greeting fallback', () => {
    const name = resolveGreetingName({
      firstName: null,
      displayedName: '',
      username: 'mystery',
    });
    expect(name).toBe('mystery');
  });
});

describe('Groq API failure', () => {
  it('surfaces API failures', async () => {
    const groq = new GroqService({
      client: {
        chat: {
          completions: {
            create: vi.fn(async () => {
              throw new Error('network down');
            }),
          },
        },
      },
    });
    await expect(groq.extractFirstName(sampleProfile)).rejects.toThrow(/Groq API failure/);
  });
});
