import express from 'express';
import path from 'path';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import type { AppConfig } from '../types';
import type { OutreachAgent } from '../agent/outreach-agent';
import type { LinkedInAgent } from '../agent/linkedin-agent';
import { logger } from '../logger';
import type { ProspectStore } from '../core/prospect-store';
import type { TemplateLibrary } from '../core/template-library';
import type { Platform, TemplateDefinition } from '../core/lead-types';
import { GroqService } from '../services/groq';

export interface DashboardDeps {
  config: AppConfig;
  instagram: OutreachAgent;
  linkedin: LinkedInAgent;
  prospects: ProspectStore;
  templates: TemplateLibrary;
  groq: GroqService;
}

export async function startDashboard(deps: DashboardDeps): Promise<http.Server> {
  const { config, instagram, linkedin, prospects, templates, groq } = deps;
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  const publicDir = path.resolve(__dirname, '../../dashboard/public');
  app.use(express.static(publicDir));

  const combinedState = () => ({
    instagram: instagram.getSnapshot(),
    linkedin: linkedin.getSnapshot(),
    leadIntelligence: prospects.leadIntelligenceSummary('all'),
    analytics: {
      instagram: prospects.getAnalytics('instagram', config.campaignId),
      linkedin: prospects.getAnalytics('linkedin', config.campaignId),
    },
    campaign: {
      id: config.campaignId,
      name: config.campaignName,
    },
    selectedTemplateId: config.selectedTemplateId,
    groq: groq.getStatus(),
  });

  // ── State ─────────────────────────────────────────────────────────────────────
  app.get('/api/state', (_req, res) => { res.json(combinedState()); });

  app.get('/api/config', (_req, res) => {
    res.json({
      campaignId: config.campaignId,
      campaignName: config.campaignName,
      searchQueries: config.searchQueries,
      linkedInSearchQueries: config.linkedInSearchQueries,
      qualification: config.qualification,
      platformQualification: config.platformQualification,
      priority: config.priority,
      processPriority: config.processPriority,
      personalization: config.personalization,
      selectedTemplateId: config.selectedTemplateId,
      dryRun: config.dryRun,
      requireConfirmationBeforeSend: config.requireConfirmationBeforeSend,
      autoSendConversationReplies: config.autoSendConversationReplies,
      maximumProfilesPerSearch: config.maximumProfilesPerSearch,
      maximumMessagesPerCampaign: config.maximumMessagesPerCampaign,
      groqModel: groq.getModel(),
      linkedInConfig: linkedin.getLinkedInConfig(),
    });
  });

  app.get('/api/groq/status', async (_req, res) => { res.json(await groq.checkConnection()); });

  // ── Leads / Analytics / Templates ────────────────────────────────────────────
  app.get('/api/leads', (req, res) => {
    const platform = (req.query.platform as Platform | 'all') || 'all';
    const priority = req.query.priority as 'A' | 'B' | 'C' | 'D' | undefined;
    const prospectType = req.query.prospectType as string | undefined;
    const conversationStatus = req.query.conversationStatus as string | undefined;
    const minScore = req.query.minScore ? Number(req.query.minScore) : undefined;
    res.json(prospects.list({ platform, priority, prospectType, conversationStatus, minScore, campaignId: (req.query.campaign as string) || undefined }));
  });

  app.get('/api/leads/:id', (req, res) => {
    const lead = prospects.getById(req.params.id);
    if (!lead) { res.status(404).json({ error: 'Not found' }); return; }
    res.json(lead);
  });

  app.get('/api/analytics', (req, res) => {
    const platform = (req.query.platform as Platform | 'all') || 'all';
    if (platform === 'all') {
      res.json({ instagram: prospects.getAnalytics('instagram', config.campaignId), linkedin: prospects.getAnalytics('linkedin', config.campaignId), summary: prospects.leadIntelligenceSummary('all') });
      return;
    }
    res.json({ [platform]: prospects.getAnalytics(platform, config.campaignId), summary: prospects.leadIntelligenceSummary(platform) });
  });

  app.get('/api/templates', (req, res) => {
    const platform = req.query.platform as Platform | undefined;
    res.json(templates.list(platform));
  });

  app.post('/api/templates/select', (req, res) => {
    const { id } = req.body as { id?: string };
    config.selectedTemplateId = id || '';
    instagram.setSelectedTemplateId(config.selectedTemplateId);
    res.json({ ok: true, selectedTemplateId: config.selectedTemplateId });
  });

  app.post('/api/templates', (req, res) => {
    const body = req.body as TemplateDefinition;
    if (!body?.id || !body.body || !body.platform) { res.status(400).json({ ok: false, error: 'id, platform, body required' }); return; }
    templates.save(body);
    res.json({ ok: true });
  });

  // ── Conversation ──────────────────────────────────────────────────────────────
  app.post('/api/conversation/analyze', async (req, res) => {
    const { prospectId, conversationText } = req.body as { prospectId?: string; conversationText?: string };
    const lead = prospectId ? prospects.getById(prospectId) : null;
    if (!lead || !conversationText) { res.status(400).json({ ok: false, error: 'prospectId and conversationText required' }); return; }
    try {
      const analysis = await groq.analyzeConversation({ platform: lead.platform, conversationText, prospectName: lead.name });
      const statusMap: Record<string, string> = { INTERESTED: 'INTERESTED', QUESTION: 'QUESTION', PRICING: 'PRICING', CALL_REQUEST: 'CALL_REQUESTED', NOT_INTERESTED: 'NOT_INTERESTED', LATER: 'FOLLOW_UP', NEEDS_INFORMATION: 'QUESTION', WRONG_PERSON: 'CLOSED', OTHER: 'REPLIED' };
      prospects.upsert({ ...lead, conversationStatus: (statusMap[analysis.category] || 'REPLIED') as typeof lead.conversationStatus, lastReplyText: conversationText, lastAiCategory: analysis.category, lastSuggestedReply: analysis.suggestedReply, suggestedReplyStatus: 'pending', approvedReplyText: null, lastInteractionAt: new Date().toISOString() });
      prospects.trackEvent(lead.platform, config.campaignId, 'reply_received');
      if (analysis.category === 'INTERESTED') prospects.trackEvent(lead.platform, config.campaignId, 'interested');
      res.json({ ok: true, analysis, lead: prospects.getById(lead.id) });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  app.post('/api/conversation/reply-decision', (req, res) => {
    const { prospectId, decision, editedReply } = req.body as { prospectId?: string; decision?: 'approve' | 'edit' | 'skip'; editedReply?: string };
    const lead = prospectId ? prospects.getById(prospectId) : null;
    if (!lead || !decision || !['approve', 'edit', 'skip'].includes(decision)) { res.status(400).json({ ok: false, error: 'prospectId and decision (approve|edit|skip) required' }); return; }
    if (decision === 'skip') {
      prospects.upsert({ ...lead, suggestedReplyStatus: 'skipped', lastInteractionAt: new Date().toISOString() });
      res.json({ ok: true, lead: prospects.getById(lead.id), note: 'Suggested reply skipped.' });
      return;
    }
    const text = (decision === 'edit' ? editedReply : editedReply || lead.lastSuggestedReply || '')?.trim() ?? '';
    if (!text) { res.status(400).json({ ok: false, error: 'Reply text required' }); return; }
    prospects.upsert({ ...lead, suggestedReplyStatus: decision === 'edit' ? 'edited' : 'approved', approvedReplyText: text, lastSuggestedReply: text, lastInteractionAt: new Date().toISOString() });
    res.json({ ok: true, lead: prospects.getById(lead.id), note: 'Reply approved and stored.' });
  });

  // ── Instagram controls ────────────────────────────────────────────────────────
  app.post('/api/instagram/start', (_req, res) => {
    if (instagram.isRunning()) { res.status(409).json({ ok: false, error: 'Instagram agent already running' }); return; }
    res.json({ ok: true });
    void instagram.start();
  });

  // Query store API — get current seeds + preview
  app.get('/api/instagram/queries', (_req, res) => {
    const qs = instagram.getQueryStore();
    res.json({
      seeds: qs.getSeeds(),
      preview: qs.previewNextRun(6),
      data: qs.getData(),
    });
  });

  // Set seeds from CSV string
  app.post('/api/instagram/queries', (req, res) => {
    const { csv } = req.body as { csv?: string };
    if (!csv || typeof csv !== 'string') {
      res.status(400).json({ ok: false, error: 'csv string required' });
      return;
    }
    instagram.getQueryStore().setSeeds(csv);
    const qs = instagram.getQueryStore();
    res.json({ ok: true, seeds: qs.getSeeds(), preview: qs.previewNextRun(6) });
  });
  app.post('/api/instagram/stop', (_req, res) => { instagram.requestStop(); res.json({ ok: true }); });
  app.post('/api/instagram/login', (_req, res) => {
    if (instagram.isRunning()) { res.status(409).json({ ok: false, error: 'Already running' }); return; }
    res.json({ ok: true });
    void instagram.loginOnly().catch(() => undefined);
  });
  app.post('/api/instagram/browser/close', async (_req, res) => { await instagram.closeBrowser(); res.json({ ok: true }); });
  app.post('/api/instagram/session/clear', async (_req, res) => { res.json({ ok: true, session: await instagram.clearSavedLogin() }); });
  app.post('/api/instagram/session/replace', async (_req, res) => { res.json({ ok: true, session: await instagram.replaceSavedLogin() }); });
  app.post('/api/instagram/confirm', (req, res) => {
    const { id, decision } = req.body as { id?: string; decision?: string };
    if (!id || (decision !== 'approve' && decision !== 'reject')) { res.status(400).json({ ok: false }); return; }
    res.json({ ok: instagram.respondToConfirmation(id, decision) });
  });

  // Legacy aliases
  app.post('/api/start', (_req, res) => {
    if (instagram.isRunning()) { res.status(409).json({ ok: false, error: 'Instagram agent already running' }); return; }
    res.json({ ok: true });
    void instagram.start();
  });
  app.post('/api/stop', (_req, res) => { instagram.requestStop(); res.json({ ok: true }); });
  app.post('/api/session/login', (_req, res) => {
    if (instagram.isRunning()) { res.status(409).json({ ok: false, error: 'Already running' }); return; }
    res.json({ ok: true });
    void instagram.loginOnly().catch(() => undefined);
  });
  app.post('/api/browser/close', async (_req, res) => { await instagram.closeBrowser(); res.json({ ok: true }); });
  app.post('/api/session/clear', async (_req, res) => { res.json({ ok: true, session: await instagram.clearSavedLogin() }); });
  app.post('/api/session/replace', async (_req, res) => { res.json({ ok: true, session: await instagram.replaceSavedLogin() }); });
  app.post('/api/confirm', (req, res) => {
    const { id, decision } = req.body as { id?: string; decision?: string };
    if (!id || (decision !== 'approve' && decision !== 'reject')) { res.status(400).json({ ok: false }); return; }
    res.json({ ok: instagram.respondToConfirmation(id, decision) });
  });

  // ── LinkedIn controls ─────────────────────────────────────────────────────────
  app.post('/api/linkedin/start', (_req, res) => {
    if (linkedin.isRunning()) { res.status(409).json({ ok: false, error: 'LinkedIn agent already running' }); return; }
    res.json({ ok: true });
    void linkedin.start();
  });
  app.post('/api/linkedin/stop', (_req, res) => { linkedin.requestStop(); res.json({ ok: true }); });
  app.post('/api/linkedin/login', (_req, res) => {
    if (linkedin.isRunning()) { res.status(409).json({ ok: false, error: 'Already running' }); return; }
    res.json({ ok: true });
    void linkedin.loginOnly().catch(() => undefined);
  });
  app.post('/api/linkedin/browser/close', async (_req, res) => { await linkedin.closeBrowser(); res.json({ ok: true }); });
  app.post('/api/linkedin/session/clear', async (_req, res) => { res.json({ ok: true, session: await linkedin.clearSavedLogin() }); });
  app.post('/api/linkedin/start-new', (_req, res) => {
    if (linkedin.isRunning()) { res.status(409).json({ ok: false, error: 'LinkedIn agent already running' }); return; }
    res.json({ ok: true });
    void linkedin.startNewProspectsOnly();
  });
  app.post('/api/linkedin/start-pending', (_req, res) => {
    if (linkedin.isRunning()) { res.status(409).json({ ok: false, error: 'LinkedIn agent already running' }); return; }
    res.json({ ok: true });
    void linkedin.startPendingOnly();
  });
  app.post('/api/linkedin/confirm', (req, res) => {
    const { id, decision } = req.body as { id?: string; decision?: string };
    if (!id || (decision !== 'approve' && decision !== 'reject')) { res.status(400).json({ ok: false }); return; }
    res.json({ ok: linkedin.respondToConfirmation(id, decision) });
  });
  app.post('/api/linkedin/pending/:id/process', async (req, res) => {
    const { id } = req.params;
    try {
      void linkedin.processSinglePending(id);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ ok: false, error: String(err) });
    }
  });
  app.post('/api/linkedin/limits/reset', (_req, res) => {
    linkedin.getLinkedInStore().resetLimits();
    res.json({ ok: true });
  });
  app.get('/api/linkedin/pending', (_req, res) => {
    res.json(linkedin.getLinkedInStore().list({
      status: ['CONNECTION_SENT', 'PENDING', 'ACCEPTED', 'MESSAGE_READY', 'MESSAGE_SENT'],
    }));
  });
  app.get('/api/linkedin/stats', (_req, res) => {
    res.json({
      ...linkedin.getLinkedInStore().getStats(),
      limits: linkedin.getLinkedInStore().getLimits(),
      config: linkedin.getLinkedInConfig(),
    });
  });
  app.get('/api/linkedin/activity', (req, res) => {
    const limit = Number(req.query.limit) || 100;
    res.json(linkedin.getLinkedInStore().getActivityLog(limit));
  });

  // ── WebSocket ─────────────────────────────────────────────────────────────────
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  const broadcast = (event: unknown) => {
    const data = JSON.stringify(event);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(data);
    }
  };

  instagram.onState(() => broadcast({ type: 'state', payload: combinedState() }));
  linkedin.onState(() => broadcast({ type: 'state', payload: combinedState() }));
  logger.on((level, message, timestamp) => broadcast({ type: 'log', payload: { level, message, timestamp } }));
  instagram.onSecurityStop((reason) => broadcast({ type: 'security_stop', payload: { reason, platform: 'instagram' } }));
  linkedin.onSecurityStop((reason) => broadcast({ type: 'security_stop', payload: { reason, platform: 'linkedin' } }));

  wss.on('connection', (socket) => {
    socket.send(JSON.stringify({ type: 'state', payload: combinedState() }));
  });

  return new Promise<http.Server>((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Port ${config.dashboardPort} is already in use. Stop the other process or use --port=3851`));
        return;
      }
      reject(err);
    });
    server.listen(config.dashboardPort, () => {
      logger.info(`Dashboard listening at http://localhost:${config.dashboardPort}`);
      resolve(server);
    });
  });
}
