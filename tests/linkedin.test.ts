/**
 * LinkedIn business logic unit tests.
 * All browser and Groq interactions are mocked — no real browser or API calls.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { LinkedInStore } from '../src/state/linkedin-store';
import type { LinkedInPendingConnection } from '../src/state/linkedin-store';
import { GroqService, type GroqChatClient } from '../src/services/groq';
import { defaultLinkedInConfig } from '../src/agent/linkedin-agent';
import type { AppConfig } from '../src/types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function tempStore(): LinkedInStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'li-store-'));
  return new LinkedInStore(path.join(dir, 'linkedin-store.json'));
}

function mockGroqClient(responses: string[]): GroqChatClient {
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

function sampleConnection(overrides: Partial<LinkedInPendingConnection> = {}): Omit<LinkedInPendingConnection, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    platform: 'linkedin',
    profileUrl: 'https://www.linkedin.com/in/johndoe',
    profileId: 'johndoe',
    name: 'John Doe',
    firstName: 'John',
    company: 'ABC Clinic',
    role: 'Doctor',
    headline: 'Dermatologist | ABC Clinic',
    location: 'Mumbai, India',
    searchQuery: 'dermatologist',
    qualification: { qualified: true, confidence: 0.9, reason: 'Dermatologist match' },
    connectionStatus: 'PENDING',
    connectionSentAt: new Date().toISOString(),
    messageSentAt: null,
    messageStatus: 'NONE',
    draftedMessage: null,
    lastCheckedAt: new Date().toISOString(),
    ...overrides,
  };
}

const minimalConfig: Partial<AppConfig> = {
  linkedInSearchQueries: ['dermatologist'],
  requireConfirmationBeforeSend: true,
  maximumProfilesPerSearch: 10,
};

// ── LinkedInStore ─────────────────────────────────────────────────────────────

describe('LinkedInStore — basic CRUD', () => {
  it('stores and retrieves a pending connection', () => {
    const store = tempStore();
    store.upsert(sampleConnection());
    const found = store.get('https://www.linkedin.com/in/johndoe');
    expect(found).not.toBeNull();
    expect(found?.name).toBe('John Doe');
    expect(found?.connectionStatus).toBe('PENDING');
  });

  it('normalises trailing slashes in profile URLs', () => {
    const store = tempStore();
    store.upsert(sampleConnection({ profileUrl: 'https://www.linkedin.com/in/johndoe/' }));
    expect(store.get('https://www.linkedin.com/in/johndoe')).not.toBeNull();
    expect(store.get('https://www.linkedin.com/in/johndoe/')).not.toBeNull();
  });

  it('updates an existing record on upsert', () => {
    const store = tempStore();
    store.upsert(sampleConnection());
    store.upsert(sampleConnection({ connectionStatus: 'ACCEPTED' }));
    const found = store.get('https://www.linkedin.com/in/johndoe');
    expect(found?.connectionStatus).toBe('ACCEPTED');
    // id should remain stable
    const all = store.list();
    expect(all.length).toBe(1);
  });

  it('persists data across store instances (survives restart)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'li-persist-'));
    const filePath = path.join(dir, 'linkedin-store.json');
    const store1 = new LinkedInStore(filePath);
    store1.upsert(sampleConnection());
    // New instance reads from disk
    const store2 = new LinkedInStore(filePath);
    expect(store2.get('https://www.linkedin.com/in/johndoe')).not.toBeNull();
  });
});

// ── Duplicate protection ──────────────────────────────────────────────────────

describe('LinkedInStore — duplicate protection', () => {
  it('hasConnectionSent returns true for PENDING status', () => {
    const store = tempStore();
    store.upsert(sampleConnection({ connectionStatus: 'PENDING' }));
    expect(store.hasConnectionSent('https://www.linkedin.com/in/johndoe')).toBe(true);
  });

  it('hasConnectionSent returns true for ACCEPTED status', () => {
    const store = tempStore();
    store.upsert(sampleConnection({ connectionStatus: 'ACCEPTED' }));
    expect(store.hasConnectionSent('https://www.linkedin.com/in/johndoe')).toBe(true);
  });

  it('hasConnectionSent returns true for MESSAGE_SENT status', () => {
    const store = tempStore();
    store.upsert(sampleConnection({ connectionStatus: 'MESSAGE_SENT', messageStatus: 'MESSAGE_SENT' }));
    expect(store.hasConnectionSent('https://www.linkedin.com/in/johndoe')).toBe(true);
  });

  it('hasConnectionSent returns false for unknown profile', () => {
    const store = tempStore();
    expect(store.hasConnectionSent('https://www.linkedin.com/in/unknown')).toBe(false);
  });

  it('hasConnectionSent returns false for SKIPPED status', () => {
    const store = tempStore();
    store.upsert(sampleConnection({ connectionStatus: 'SKIPPED' }));
    expect(store.hasConnectionSent('https://www.linkedin.com/in/johndoe')).toBe(false);
  });

  it('hasMessageSent returns true only when MESSAGE_SENT', () => {
    const store = tempStore();
    store.upsert(sampleConnection({ connectionStatus: 'MESSAGE_SENT', messageStatus: 'MESSAGE_SENT' }));
    expect(store.hasMessageSent('https://www.linkedin.com/in/johndoe')).toBe(true);
  });

  it('hasMessageSent returns false when MESSAGE_PENDING', () => {
    const store = tempStore();
    store.upsert(sampleConnection({ messageStatus: 'MESSAGE_PENDING' }));
    expect(store.hasMessageSent('https://www.linkedin.com/in/johndoe')).toBe(false);
  });
});

// ── Connection / message limits ───────────────────────────────────────────────

describe('LinkedInStore — limits', () => {
  it('tracks connection and message usage separately', () => {
    const store = tempStore();
    store.incrementConnections();
    store.incrementConnections();
    store.incrementMessages();
    const limits = store.getLimits();
    expect(limits.connectionsUsed).toBe(2);
    expect(limits.messagesUsed).toBe(1);
  });

  it('connectionsRemaining calculates correctly', () => {
    const store = tempStore();
    store.incrementConnections();
    store.incrementConnections();
    expect(store.connectionsRemaining(10)).toBe(8);
    expect(store.messagesRemaining(10)).toBe(10);
  });

  it('never conflates connection and message limits', () => {
    const store = tempStore();
    for (let i = 0; i < 20; i++) store.incrementConnections();
    // Connections exhausted, messages still available
    expect(store.connectionsRemaining(20)).toBe(0);
    expect(store.messagesRemaining(20)).toBe(20);
  });

  it('resetLimits sets both counters to 0', () => {
    const store = tempStore();
    store.incrementConnections();
    store.incrementMessages();
    store.resetLimits();
    expect(store.getLimits().connectionsUsed).toBe(0);
    expect(store.getLimits().messagesUsed).toBe(0);
  });
});

// ── Filtering ─────────────────────────────────────────────────────────────────

describe('LinkedInStore — filtering', () => {
  let store: LinkedInStore;

  beforeEach(() => {
    store = tempStore();
    store.upsert(sampleConnection({ connectionStatus: 'PENDING', profileUrl: 'https://www.linkedin.com/in/a', profileId: 'a', name: 'Alice' }));
    store.upsert(sampleConnection({ connectionStatus: 'ACCEPTED', profileUrl: 'https://www.linkedin.com/in/b', profileId: 'b', name: 'Bob', messageStatus: 'MESSAGE_PENDING' }));
    store.upsert(sampleConnection({ connectionStatus: 'MESSAGE_SENT', messageStatus: 'MESSAGE_SENT', profileUrl: 'https://www.linkedin.com/in/c', profileId: 'c', name: 'Carol' }));
    store.upsert(sampleConnection({ connectionStatus: 'SKIPPED', profileUrl: 'https://www.linkedin.com/in/d', profileId: 'd', name: 'Dave' }));
  });

  it('getPending returns only PENDING and CONNECTION_SENT', () => {
    const pending = store.getPending();
    expect(pending.every((r) => ['PENDING', 'CONNECTION_SENT'].includes(r.connectionStatus))).toBe(true);
    expect(pending.some((r) => r.name === 'Alice')).toBe(true);
    expect(pending.some((r) => r.name === 'Bob')).toBe(false);
  });

  it('getAccepted returns only ACCEPTED', () => {
    const accepted = store.getAccepted();
    expect(accepted.every((r) => r.connectionStatus === 'ACCEPTED')).toBe(true);
  });

  it('getMessageReady returns accepted connections with MESSAGE_PENDING', () => {
    const ready = store.getMessageReady();
    expect(ready.some((r) => r.name === 'Bob')).toBe(true);
    expect(ready.some((r) => r.name === 'Carol')).toBe(false);
  });

  it('getStats counts correctly', () => {
    const stats = store.getStats();
    expect(stats.skipped).toBe(1);
    expect(stats.messageSent).toBe(1);
    expect(stats.messagePending).toBe(1);
  });
});

// ── Activity log ──────────────────────────────────────────────────────────────

describe('LinkedInStore — activity log', () => {
  it('logs activities and returns them in reverse-chron order', () => {
    const store = tempStore();
    store.logActivity('First entry');
    store.logActivity('Second entry');
    const log = store.getActivityLog();
    expect(log[0].message).toBe('Second entry');
    expect(log[1].message).toBe('First entry');
  });

  it('caps log at 500 entries', () => {
    const store = tempStore();
    for (let i = 0; i < 600; i++) store.logActivity(`Entry ${i}`);
    expect(store.getActivityLog(1000).length).toBeLessThanOrEqual(500);
  });
});

// ── defaultLinkedInConfig ─────────────────────────────────────────────────────

describe('defaultLinkedInConfig', () => {
  it('inherits search queries from AppConfig', () => {
    const cfg = defaultLinkedInConfig({
      linkedInSearchQueries: ['dermatologist', 'clinic founder'],
      requireConfirmationBeforeSend: true,
      maximumProfilesPerSearch: 50,
    } as unknown as AppConfig);
    expect(cfg.searches).toEqual(['dermatologist', 'clinic founder']);
    expect(cfg.connectionLimit.maximum).toBe(20);
    expect(cfg.messageLimit.maximum).toBe(20);
  });

  it('treats connection and message limits as independent', () => {
    const cfg = defaultLinkedInConfig({
      linkedInSearchQueries: [],
      requireConfirmationBeforeSend: false,
      maximumProfilesPerSearch: 10,
    } as unknown as AppConfig);
    expect(cfg.connectionLimit.maximum).not.toBe(undefined);
    expect(cfg.messageLimit.maximum).not.toBe(undefined);
    // Must be independently configurable — they are separate fields
    expect(cfg.connectionLimit).not.toBe(cfg.messageLimit);
  });
});

// ── Groq qualification for LinkedIn ──────────────────────────────────────────

describe('Groq qualification for LinkedIn profiles', () => {
  it('qualifies a LinkedIn profile via scoreAndQualifyProspect', async () => {
    const groq = new GroqService({
      client: mockGroqClient([
        JSON.stringify({
          score: 82,
          qualified: true,
          confidence: 0.91,
          reason: 'Practicing dermatologist in India',
          prospectType: 'dermatologist',
          factors: {
            roleMatch: 25,
            industryMatch: 18,
            locationMatch: 14,
            profileQuality: 12,
            audienceSize: 5,
            decisionMakerLikelihood: 8,
          },
          role: 'Dermatologist',
          company: 'Skin Care Clinic',
          location: 'Mumbai, India',
        }),
      ]),
    });

    const result = await groq.scoreAndQualifyProspect({
      platform: 'linkedin',
      profile: {
        profileUrl: 'https://www.linkedin.com/in/drtest',
        username: 'drtest',
        displayedName: 'Dr Test',
        firstName: 'Test',
        bio: 'Dermatologist | Skin Care Clinic',
        followers: null,
        following: null,
        posts: null,
        isVerified: false,
        isPrivate: false,
        accountTypeHints: ['Dermatologist'],
        locationText: 'Mumbai, India',
      },
      localRules: {
        verifiedRequired: false,
        verifiedOptional: false,
        minFollowers: 0,
        maxFollowers: 999999,
        accountVisibility: 'any',
        requiredBioKeywords: [],
        excludedBioKeywords: [],
        requiredLocationKeywords: [],
        requiredAccountTypeKeywords: [],
      },
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
        targetProspectTypes: ['dermatologist', 'doctor'],
        campaignGoal: 'Find dermatologists',
      },
      linkedInExtras: {
        headline: 'Dermatologist | Skin Care Clinic',
        location: 'Mumbai, India',
      },
    });

    expect(result.score).toBe(82);
    expect(result.qualified).toBe(true);
    expect(result.prospectType).toBe('dermatologist');
  });

  it('disqualifies a student profile', async () => {
    const groq = new GroqService({
      client: mockGroqClient([
        JSON.stringify({
          score: 15,
          qualified: false,
          confidence: 0.95,
          reason: 'Medical student, not a practicing doctor',
          prospectType: 'medical_student',
          factors: { roleMatch: 5, industryMatch: 5, locationMatch: 5, profileQuality: 0, audienceSize: 0, decisionMakerLikelihood: 0 },
          role: 'Student',
          company: null,
          location: 'Delhi',
        }),
      ]),
    });

    const result = await groq.scoreAndQualifyProspect({
      platform: 'linkedin',
      profile: {
        profileUrl: 'https://www.linkedin.com/in/student',
        username: 'student',
        displayedName: 'Med Student',
        firstName: 'Med',
        bio: 'MBBS student | Delhi',
        followers: null,
        following: null,
        posts: null,
        isVerified: false,
        isPrivate: false,
        accountTypeHints: [],
        locationText: 'Delhi',
      },
      localRules: {
        verifiedRequired: false,
        verifiedOptional: false,
        minFollowers: 0,
        maxFollowers: 999999,
        accountVisibility: 'any',
        requiredBioKeywords: [],
        excludedBioKeywords: ['student'],
        requiredLocationKeywords: [],
        requiredAccountTypeKeywords: [],
      },
      platformRules: {
        minimumScore: 70,
        scoring: { roleMatch: 25, industryMatch: 20, locationMatch: 15, profileQuality: 15, audienceSize: 10, decisionMakerLikelihood: 15 },
        targetProspectTypes: ['dermatologist', 'doctor'],
        campaignGoal: 'Find dermatologists',
      },
    });

    expect(result.qualified).toBe(false);
    expect(result.score).toBeLessThan(70);
  });
});

// ── Message template for LinkedIn ─────────────────────────────────────────────

describe('LinkedIn message template substitution', () => {
  it('replaces {first_name} correctly', async () => {
    const groq = new GroqService({
      client: mockGroqClient([
        JSON.stringify({
          personalizedMessage: 'Hi John, thanks for connecting. I build healthcare AI.',
          personalizationReason: 'Used first name',
        }),
      ]),
    });

    const result = await groq.personalizeFromTemplate({
      templateBody: 'Hi {first_name}, thanks for connecting.',
      profile: {
        profileUrl: 'https://www.linkedin.com/in/johndoe',
        username: 'johndoe',
        displayedName: 'John Doe',
        firstName: 'John',
        bio: 'Dermatologist',
        followers: null,
        following: null,
        posts: null,
        isVerified: false,
        isPrivate: false,
        accountTypeHints: [],
        locationText: 'Mumbai',
      },
      firstName: 'John',
      config: { enabled: true, maximumLength: 500, allowedProfileFields: ['first_name'] },
    });

    expect(result.personalizedMessage.toLowerCase()).toContain('john');
  });

  it('falls back gracefully when Groq fails', async () => {
    const groq = new GroqService({
      client: mockGroqClient(['bad-json', 'also-bad']),
    });

    const result = await groq.personalizeFromTemplate({
      templateBody: 'Hi {first_name}, would like to connect.',
      profile: {
        profileUrl: 'https://www.linkedin.com/in/fallback',
        username: 'fallback',
        displayedName: 'Fallback User',
        firstName: 'Fallback',
        bio: '',
        followers: null,
        following: null,
        posts: null,
        isVerified: false,
        isPrivate: false,
        accountTypeHints: [],
        locationText: '',
      },
      firstName: 'Fallback',
      config: { enabled: true, maximumLength: 300, allowedProfileFields: ['first_name'] },
    });

    // Should fall back to template substitution, not throw
    expect(result.personalizedMessage).toContain('Fallback');
  });
});

// ── URL normalisation ─────────────────────────────────────────────────────────

describe('LinkedInStore — URL normalisation', () => {
  it('handles query params in profile URLs', () => {
    const store = tempStore();
    store.upsert(sampleConnection({ profileUrl: 'https://www.linkedin.com/in/johndoe?trk=search' }));
    // Should be findable without query params
    expect(store.get('https://www.linkedin.com/in/johndoe')).not.toBeNull();
  });

  it('extractProfileId works for standard /in/ URLs', () => {
    const store = tempStore();
    expect(store.extractProfileId('https://www.linkedin.com/in/johndoe')).toBe('johndoe');
    expect(store.extractProfileId('https://www.linkedin.com/in/dr-jane-smith-123')).toBe('dr-jane-smith-123');
  });
});
