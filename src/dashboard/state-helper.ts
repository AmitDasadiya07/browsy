import config from '../../config';
import { OutreachAgent } from '../agent/outreach-agent';
import { LinkedInAgent } from '../agent/linkedin-agent';
import { GroqService } from '../services/groq';
import { ProspectStore } from '../core/prospect-store';
import { TemplateLibrary } from '../core/template-library';

/**
 * Helper used by Vercel serverless functions to obtain the same combined state
 * that the original Express dashboard used. It **does NOT start browsers** –
 * it merely constructs the core objects and returns a snapshot.
 */
export async function getCombinedState() {
  const runtimeConfig = config;
  const groq = new GroqService();
  const prospects = new ProspectStore(runtimeConfig.prospectsFile);
  const templates = new TemplateLibrary(runtimeConfig.templatesDir);
  const instagram = new OutreachAgent(runtimeConfig, groq, {
    prospectStore: prospects,
    templates,
  });
  const linkedin = new LinkedInAgent(runtimeConfig, groq, prospects, templates);

  // No `.start()` – we only need snapshot data.
  return {
    instagram: instagram.getSnapshot(),
    linkedin: linkedin.getSnapshot(),
    leadIntelligence: prospects.leadIntelligenceSummary('all'),
    analytics: {
      instagram: prospects.getAnalytics('instagram', runtimeConfig.campaignId),
      linkedin: prospects.getAnalytics('linkedin', runtimeConfig.campaignId),
    },
    campaign: {
      id: runtimeConfig.campaignId,
      name: runtimeConfig.campaignName,
    },
    selectedTemplateId: runtimeConfig.selectedTemplateId,
    groq: groq.getStatus(),
  };
}
