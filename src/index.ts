import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import config from '../config';
import { OutreachAgent } from './agent/outreach-agent';
import { LinkedInAgent } from './agent/linkedin-agent';
import { startDashboard } from './dashboard/server';
import { logger } from './logger';
import type { AppConfig } from './types';
import { GroqService } from './services/groq';
import { ProspectStore } from './core/prospect-store';
import { TemplateLibrary } from './core/template-library';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

function applyCliOverrides(base: AppConfig): AppConfig {
  const args = process.argv.slice(2);
  const next: AppConfig = {
    ...base,
    browser: { ...base.browser },
    linkedInBrowser: { ...base.linkedInBrowser },
    qualification: { ...base.qualification },
    delays: { ...base.delays },
    platformQualification: {
      instagram: { ...base.platformQualification.instagram, scoring: { ...base.platformQualification.instagram.scoring } },
      linkedin: { ...base.platformQualification.linkedin, scoring: { ...base.platformQualification.linkedin.scoring } },
    },
    priority: { ...base.priority },
    personalization: { ...base.personalization },
    processPriority: [...base.processPriority],
  };

  if (args.includes('--dry-run')) next.dryRun = true;
  if (args.includes('--auto-send')) next.requireConfirmationBeforeSend = false;
  if (args.includes('--headless')) {
    next.browser.headless = true;
    next.linkedInBrowser.headless = true;
  }
  if (args.includes('--ai-personalize')) {
    next.allowAiMessagePersonalization = true;
    next.personalization.enabled = true;
  }
  const portArg = args.find((a) => a.startsWith('--port='));
  if (portArg) next.dashboardPort = Number(portArg.split('=')[1]) || next.dashboardPort;
  return next;
}

async function main(): Promise<void> {
  const runtimeConfig = applyCliOverrides(config);
  fs.mkdirSync(path.resolve(runtimeConfig.outputDir), { recursive: true });

  logger.info(`Starting outreach app · campaign=${runtimeConfig.campaignName}`);
  const groq = new GroqService();
  const prospects = new ProspectStore(runtimeConfig.prospectsFile);
  const templates = new TemplateLibrary(runtimeConfig.templatesDir);
  const instagram = new OutreachAgent(runtimeConfig, groq, { prospectStore: prospects, templates });
  const linkedin = new LinkedInAgent(runtimeConfig, groq, prospects, templates);

  await startDashboard({
    config: runtimeConfig,
    instagram,
    linkedin,
    prospects,
    templates,
    groq,
  });

  const groqStatus = await groq.checkConnection();
  logger.info(`Groq: ${groqStatus.status} · ${groqStatus.model}`);
  logger.info(`Dashboard: http://localhost:${runtimeConfig.dashboardPort}`);
  logger.info('Instagram and LinkedIn run as separate flows from the sidebar.');

  if (process.argv.includes('--start')) void instagram.start();
  if (process.argv.includes('--start-linkedin')) void linkedin.start();
}

main().catch((err) => {
  logger.error(`Failed to start: ${String(err)}`);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled rejection: ${String(reason)}`);
});
process.on('uncaughtException', (err) => {
  logger.error(`Uncaught exception: ${String(err)}`);
});
