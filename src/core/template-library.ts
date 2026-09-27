import fs from 'fs';
import path from 'path';
import type { Platform, TemplateDefinition } from './lead-types';
import { logger } from '../logger';

const DEFAULT_TEMPLATES: TemplateDefinition[] = [
  {
    id: 'instagram-doctor-introduction',
    name: 'Doctor Introduction',
    platform: 'instagram',
    stage: 'initial_contact',
    prospectTypes: ['doctor', 'dermatologist', 'physician'],
    body: `Hello {greeting_name},

Amit here.

I'm a Full-Stack + AI developer. I build products and internal systems end-to-end — from idea → architecture → development → deployment.

Rather than pitching you a service, I wanted to ask one simple thing:

-> Is there any technical problem, repetitive process, or product idea in your company that you wish someone would just take care of?

If yes, send it to me. I'll take a look and tell you what I'd build.

Worth a shot. 🙂`,
  },
  {
    id: 'instagram-clinic-introduction',
    name: 'Clinic Introduction',
    platform: 'instagram',
    stage: 'initial_contact',
    prospectTypes: ['clinic_owner', 'skin_clinic', 'clinic'],
    body: `Hello {greeting_name},

Amit here — Full-Stack + AI developer.

I help clinics build internal tools, booking flows, and AI assistants that remove repetitive work.

Is there any operational or product problem on your side that you'd like someone to take ownership of?

Happy to take a look if you share it.`,
  },
  {
    id: 'instagram-generic-introduction',
    name: 'Generic Introduction',
    platform: 'instagram',
    stage: 'initial_contact',
    prospectTypes: ['*'],
    body: `Hello {greeting_name},

Amit here.

I'm a Full-Stack + AI developer. I build products and internal systems end-to-end.

Is there any technical problem or product idea you wish someone would just take care of?

If yes, send it over — I'll tell you what I'd build.`,
  },
  {
    id: 'instagram-follow-up-1',
    name: 'Instagram Follow-up 1',
    platform: 'instagram',
    stage: 'follow_up_1',
    prospectTypes: ['*'],
    body: `Hi {greeting_name},

Just floating this back up in case it got buried — happy to look at any technical/process problem if useful.`,
  },
  {
    id: 'linkedin-doctor-connection',
    name: 'Doctor Connection Request',
    platform: 'linkedin',
    stage: 'connection_request',
    prospectTypes: ['doctor', 'dermatologist', 'physician'],
    body: `Hi {first_name}, I work with healthcare teams on product and AI systems. Would be glad to connect.`,
  },
  {
    id: 'linkedin-founder-connection',
    name: 'Founder Connection',
    platform: 'linkedin',
    stage: 'connection_request',
    prospectTypes: ['founder', 'owner', 'clinic_owner'],
    body: `Hi {first_name}, I help founders ship full-stack + AI systems end-to-end. Would love to connect.`,
  },
  {
    id: 'linkedin-post-connection',
    name: 'Post Connection Message',
    platform: 'linkedin',
    stage: 'post_connection',
    prospectTypes: ['*'],
    body: `Hi {first_name},

Thanks for connecting. I build full-stack + AI products end-to-end.

Is there any technical problem or product idea at {company} that you wish someone would take care of?`,
  },
  {
    id: 'linkedin-generic-connection',
    name: 'Generic Connection',
    platform: 'linkedin',
    stage: 'connection_request',
    prospectTypes: ['*'],
    body: `Hi {first_name}, would be glad to connect — I build full-stack and AI systems for teams.`,
  },
  {
    id: 'linkedin-follow-up-1',
    name: 'LinkedIn Follow-up 1',
    platform: 'linkedin',
    stage: 'follow_up_1',
    prospectTypes: ['*'],
    body: `Hi {first_name}, just checking in — happy to help if there's a technical/process problem worth solving.`,
  },
];

export class TemplateLibrary {
  private templates: TemplateDefinition[] = [];
  private dir: string;

  constructor(dir = './templates') {
    this.dir = path.resolve(dir);
    this.reload();
  }

  reload(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    this.ensureDefaults();
    this.templates = [];
    this.loadDir(this.dir);
    if (!this.templates.length) {
      this.templates = [...DEFAULT_TEMPLATES];
    }
    logger.info(`Template library loaded: ${this.templates.length} template(s)`);
  }

  private ensureDefaults(): void {
    for (const t of DEFAULT_TEMPLATES) {
      const platformDir = path.join(this.dir, t.platform);
      fs.mkdirSync(platformDir, { recursive: true });
      const file = path.join(platformDir, `${t.id.replace(`${t.platform}-`, '')}.json`);
      if (!fs.existsSync(file)) {
        fs.writeFileSync(file, JSON.stringify(t, null, 2), 'utf8');
      }
    }
  }

  private loadDir(dir: string): void {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        this.loadDir(full);
        continue;
      }
      if (!entry.name.endsWith('.json')) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(full, 'utf8')) as TemplateDefinition;
        if (parsed.id && parsed.body && parsed.platform) {
          this.templates.push(parsed);
        }
      } catch (err) {
        logger.warn(`Skipping bad template ${full}: ${String(err)}`);
      }
    }
  }

  list(platform?: Platform): TemplateDefinition[] {
    if (!platform) return [...this.templates];
    return this.templates.filter((t) => t.platform === platform);
  }

  get(id: string): TemplateDefinition | null {
    return this.templates.find((t) => t.id === id) ?? null;
  }

  select(options: {
    platform: Platform;
    stage: string;
    prospectType?: string;
    preferredId?: string;
  }): TemplateDefinition {
    if (options.preferredId) {
      const preferred = this.get(options.preferredId);
      if (preferred && preferred.platform === options.platform) return preferred;
    }

    const platformTemplates = this.list(options.platform).filter(
      (t) => t.stage === options.stage,
    );
    const type = (options.prospectType || '').toLowerCase();
    const typed = platformTemplates.find((t) =>
      t.prospectTypes.some((p) => p !== '*' && type.includes(p.toLowerCase())),
    );
    if (typed) return typed;

    const generic = platformTemplates.find((t) => t.prospectTypes.includes('*'));
    if (generic) return generic;

    const anyStage = this.list(options.platform)[0];
    if (anyStage) return anyStage;

    return DEFAULT_TEMPLATES.find((t) => t.platform === options.platform)!;
  }

  save(template: TemplateDefinition): void {
    const platformDir = path.join(this.dir, template.platform);
    fs.mkdirSync(platformDir, { recursive: true });
    const file = path.join(platformDir, `${template.id}.json`);
    fs.writeFileSync(file, JSON.stringify(template, null, 2), 'utf8');
    this.reload();
  }
}
