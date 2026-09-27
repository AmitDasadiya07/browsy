import { describe, expect, it, vi, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  AiProcessingError,
  GroqService,
  type GroqChatClient,
} from '../src/services/groq';
import {
  AiNameExtractionSchema,
  AiQualificationSchema,
  AiReplyClassificationSchema,
} from '../src/services/ai-schemas';
import { LocalStore } from '../src/state/local-store';
import type { ProfileSnapshot, QualificationRules } from '../src/types';

const sampleProfile: ProfileSnapshot = {
  profileUrl: 'https://www.instagram.com/drjane/',
  username: 'drjane',
  displayedName: 'Jane Smith MD',
  firstName: 'Jane',
  bio: 'Board-certified dermatologist in NYC',
  followers: 25000,
  following: 400,
  posts: 120,
  isVerified: true,
  isPrivate: false,
  accountTypeHints: ['Professional'],
  locationText: 'New York',
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

function failingClient(message = 'API down'): GroqChatClient {
  return {
    chat: {
      completions: {
        create: vi.fn(async () => {
          throw new Error(message);
        }),
      },
    },
  };
}

describe('Groq connection', () => {
  it('reports unconfigured when API key missing', async () => {
    const prev = process.env.GROQ_API_KEY;
    delete process.env.GROQ_API_KEY;
    const groq = new GroqService({ apiKey: '', model: 'openai/gpt-oss-20b' });
    const status = await groq.checkConnection();
    expect(status.status).toBe('unconfigured');
    expect(status.model).toBe('openai/gpt-oss-20b');
    process.env.GROQ_API_KEY = prev;
  });

  it('reports connected when mock chat succeeds', async () => {
    const groq = new GroqService({
      client: mockClient(['{"ok":true}']),
      model: 'openai/gpt-oss-20b',
    });
    const status = await groq.checkConnection();
    expect(status.status).toBe('connected');
  });

  it('reports error on Groq API failure without exposing secrets', async () => {
    const groq = new GroqService({
      client: failingClient('Unauthorized gsk_SECRETkey123 Bearer tok'),
      model: 'openai/gpt-oss-20b',
    });
    const status = await groq.checkConnection();
    expect(status.status).toBe('error');
    expect(status.message).not.toMatch(/gsk_/);
    expect(status.message).not.toMatch(/SECRETkey/);
  });
});

describe('Qualification responses', () => {
  it('accepts a valid qualification response', async () => {
    const groq = new GroqService({
      client: mockClient([
        JSON.stringify({
          qualified: true,
          confidence: 0.94,
          reason: 'Profile appears to be a legitimate dermatologist.',
        }),
      ]),
    });
    const result = await groq.qualifyProfile(sampleProfile, rules);
    expect(result).toEqual({
      qualified: true,
      confidence: 0.94,
      reason: 'Profile appears to be a legitimate dermatologist.',
    });
    expect(AiQualificationSchema.safeParse(result).success).toBe(true);
  });

  it('retries once then fails on invalid Groq response', async () => {
    const client = mockClient(['not-json', 'still-bad']);
    const groq = new GroqService({ client });
    await expect(groq.qualifyProfile(sampleProfile, rules)).rejects.toBeInstanceOf(
      AiProcessingError,
    );
    expect(client.chat.completions.create).toHaveBeenCalledTimes(2);
  });

  it('recovers when first response is invalid and second is valid', async () => {
    const groq = new GroqService({
      client: mockClient([
        'oops',
        JSON.stringify({ qualified: false, confidence: 0.4, reason: 'Unclear specialty' }),
      ]),
    });
    const result = await groq.qualifyProfile(sampleProfile, rules);
    expect(result.qualified).toBe(false);
    expect(result.confidence).toBe(0.4);
  });
});

describe('Name extraction', () => {
  it('extracts a reliable first name', async () => {
    const groq = new GroqService({
      client: mockClient([JSON.stringify({ first_name: 'Jane', confidence: 0.96 })]),
    });
    const result = await groq.extractFirstName(sampleProfile);
    expect(result.first_name).toBe('Jane');
    expect(AiNameExtractionSchema.safeParse(result).success).toBe(true);
  });

  it('returns null when name cannot be determined', async () => {
    const groq = new GroqService({
      client: mockClient([JSON.stringify({ first_name: null, confidence: 0 })]),
    });
    const result = await groq.extractFirstName(sampleProfile);
    expect(result.first_name).toBeNull();
    expect(result.confidence).toBe(0);
  });
});

describe('Message personalization', () => {
  it('substitutes placeholders without AI when personalization disabled', async () => {
    const create = vi.fn();
    const groq = new GroqService({
      client: { chat: { completions: { create } } },
    });
    const msg = await groq.personalizeMessage({
      template: 'Hi {first_name}, interested in collab?',
      firstName: 'Jane',
      displayedName: 'Jane Smith',
      profile: sampleProfile,
      allowPersonalization: false,
    });
    expect(msg).toBe('Hi Jane, interested in collab?');
    expect(create).not.toHaveBeenCalled();
  });

  it('uses AI personalization when enabled and falls back on empty AI output', async () => {
    const groq = new GroqService({
      client: mockClient(['Hi Jane, loved your dermatology work — open to a quick chat?']),
    });
    const msg = await groq.personalizeMessage({
      template: 'Hi {first_name}, I wanted to reach out regarding...',
      firstName: 'Jane',
      displayedName: 'Jane Smith',
      profile: sampleProfile,
      allowPersonalization: true,
    });
    expect(msg.toLowerCase()).toContain('jane');
  });
});

describe('Reply classification', () => {
  it('classifies a reply as INTERESTED', async () => {
    const groq = new GroqService({
      client: mockClient([
        JSON.stringify({
          category: 'INTERESTED',
          confidence: 0.91,
          suggested_reply: 'Great — happy to share more details.',
        }),
      ]),
    });
    const result = await groq.classifyReply('Yes this sounds interesting!');
    expect(result.category).toBe('INTERESTED');
    expect(AiReplyClassificationSchema.safeParse(result).success).toBe(true);
  });
});

describe('AI response caching', () => {
  let dir: string;
  let store: LocalStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-ai-cache-'));
    store = new LocalStore(
      path.join(dir, 'processed.json'),
      path.join(dir, 'results.jsonl'),
      path.join(dir, 'ai-cache.json'),
    );
  });

  it('stores and reuses AI qualification cache for the same profile', () => {
    expect(store.getAiCache(sampleProfile.profileUrl)).toBeNull();
    store.setAiCache({
      profileUrl: sampleProfile.profileUrl,
      username: sampleProfile.username,
      displayedName: sampleProfile.displayedName,
      qualified: true,
      confidence: 0.9,
      reason: 'Dermatologist match',
      extractedFirstName: 'Jane',
      generatedMessage: 'Hi Jane, hello',
      timestamp: new Date().toISOString(),
    });
    const cached = store.getAiCache(sampleProfile.profileUrl);
    expect(cached?.qualified).toBe(true);
    expect(cached?.confidence).toBe(0.9);
    // second read should hit same entry (never call Groq twice)
    expect(store.getAiCache('https://www.instagram.com/drjane/')).toEqual(cached);
  });
});

describe('Groq API failure handling', () => {
  it('throws AiProcessingError on API failure during qualification', async () => {
    const groq = new GroqService({ client: failingClient('rate limited') });
    await expect(groq.qualifyProfile(sampleProfile, rules)).rejects.toThrow(/Groq API failure/);
  });
});
