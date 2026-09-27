import type { AppConfig } from './src/types';

const sharedScoring = {
  roleMatch: 25,
  industryMatch: 20,
  locationMatch: 15,
  profileQuality: 15,
  audienceSize: 10,
  decisionMakerLikelihood: 15,
};

/**
 * Campaign configuration for the outreach agent (Instagram + LinkedIn).
 */
const config: AppConfig = {
  campaignId: 'coaches-creators',
  campaignName: 'Coaches & Creators',
  activePlatform: 'instagram',

  searchQueries: [
    'course creator',
    'business coach',
    'marketing coach',
    'online educator',
    'real estate coach',
    'fitness coach',
  ],
  linkedInSearchQueries: [
    'business coach',
    'course creator',
    'marketing coach',
    'fitness coach',
  ],

  qualification: {
    verifiedRequired: false,
    verifiedOptional: true,
    minFollowers: 50,
    maxFollowers: 2_500_000,
    accountVisibility: 'public',
    requiredBioKeywords: [],
    excludedBioKeywords: [],
    requiredLocationKeywords: [],
    requiredAccountTypeKeywords: [],
  },

  platformQualification: {
    instagram: {
      minimumScore: 30,
      scoring: { ...sharedScoring },
      targetProspectTypes: [
        'course_creator',
        'business_coach',
        'marketing_coach',
        'fitness_coach',
        'online_educator',
        'real_estate_coach',
        'coach',
        'founder',
        'clinic',
        'clinic_owner',
        'doctor',
        'telehealth',
        'health_tech',
        'startup',
        'agency',
        'healthcare_provider'
      ],
      campaignGoal:
        'Find coaches, course creators, online educators, telehealth businesses, clinics, and healthtech startups who may need software/AI help',
    },
    linkedin: {
      minimumScore: 30,
      scoring: { ...sharedScoring },
      targetProspectTypes: [
        'course_creator',
        'business_coach',
        'marketing_coach',
        'fitness_coach',
        'online_educator',
        'coach',
        'founder',
        'clinic',
        'clinic_owner',
        'doctor',
        'telehealth',
        'health_tech',
        'startup',
        'agency',
        'healthcare_provider'
      ],
      campaignGoal:
        'Find coaches, course creators, telehealth businesses, clinics, and healthtech startups who may need software/AI help',
    },
  },

  priority: {
    A: { minimumScore: 60, label: 'High Priority' },
    B: { minimumScore: 40, label: 'Good' },
    C: { minimumScore: 20, label: 'Low Priority' },
    D: { label: 'Skip' },
  },

  processPriority: ['A', 'B', 'C'],

  personalization: {
    enabled: true,
    maximumLength: 900,
    allowedProfileFields: ['first_name', 'role', 'company', 'location', 'bio', 'name'],
  },

  selectedTemplateId: '',
  templatesDir: './templates',
  prospectsFile: './data/prospects.json',

  messageTemplate: `Hello {greeting_name},

Amit here.

I'm a Full-Stack + AI developer. I build products and internal systems end-to-end — from idea → architecture → development → deployment.

Rather than pitching you a service, I wanted to ask one simple thing:

-> Is there any technical problem, repetitive process, or product idea in your company that you wish someone would just take care of?

If yes, send it to me. I'll take a look and tell you what I'd build.

Worth a shot. 🙂`,

  maximumProfilesPerSearch: 100,
  minimumMessagesPerCampaign: 20,
  maximumMessagesPerCampaign: 60,
  /** Restart Instagram automation 1 hour after a completed run (while app is running) */
  autoRestartAfterMs: 60 * 60 * 1000,
  requireConfirmationBeforeSend: true,
  autoSendConversationReplies: false,
  continueAutomaticallyAfterSearch: true,
  dryRun: false,
  allowAiMessagePersonalization: true,
  stopOnAiError: false,
  minAiQualificationConfidence: 0.55,

  outputDir: './data',
  resultsLogFile: './data/results.jsonl',
  processedProfilesFile: './data/processed-profiles.json',
  aiCacheFile: './data/ai-cache.json',
  sessionMetaFile: './data/instagram-session.json',
  linkedInSessionMetaFile: './data/linkedin-session.json',

  dashboardPort: 3847,

  browser: {
    headless: false,
    userDataDir: './data/browser-profile',
    executablePath: '',
    useSystemChrome: true,
    storageStateFile: './data/instagram-storage.json',
    slowMoMs: 50,
    navigationTimeoutMs: 45_000,
    actionTimeoutMs: 15_000,
  },

  linkedInBrowser: {
    headless: false,
    userDataDir: './data/linkedin-browser-profile',
    executablePath: '',
    useSystemChrome: true,
    storageStateFile: './data/linkedin-storage.json',
    slowMoMs: 50,
    navigationTimeoutMs: 45_000,
    actionTimeoutMs: 15_000,
  },

  delays: {
    betweenProfilesMs: 35_000,
    afterSearchMs: 5_000,
    afterOpenProfileMs: 4_000,
    typingDelayMs: 60,
  },
};

export default config;
