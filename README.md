# Outreach Agent (Instagram + LinkedIn)

Local browser agent for Instagram and LinkedIn outreach via **visible website UI** (Playwright), with **Groq** for lead scoring, qualification, personalization, and conversation intelligence. Platforms stay **separate execution flows** sharing Groq, storage, analytics, and the dashboard.

## Safety rules

- Playwright uses visible UI only — no hidden APIs, CAPTCHA solving, proxies, fingerprint spoofing, or rate-limit bypass.
- Security challenges → **pause/stop** that platform’s workflow; browser stays usable.
- Groq only sees fields already extracted from the page. Unknown stays unknown.

## Setup

```bash
cd "browser agent"
npm install
npx playwright install chromium
cp .env.example .env
# set GROQ_API_KEY=
```

## Run

```bash
npm start
```

Open **http://localhost:3847**. Sidebar: Campaign · Instagram · LinkedIn · Lead Intelligence · Analytics · Templates · Conversations.

```bash
npm run dry-run
npm test
npm run typecheck
```

Flags: `--dry-run`, `--auto-send`, `--ai-personalize`, `--port=4000`, `--start`

Use separate **Start Instagram** / **Start LinkedIn** controls — they do not share a browser profile.

---

## Lead scoring

Configured per platform in `config.ts` → `platformQualification.instagram|linkedin`:

- `minimumScore` (e.g. 70)
- `scoring` weights (roleMatch, industryMatch, …)
- `targetProspectTypes` + `campaignGoal`

Pipeline: local filters → Groq score (0–100) → cache → persist on the prospect. Dashboard shows **Lead Score / Confidence / Qualified**.

Re-analysis: clear the profile entry in `data/ai-cache.json` (or delete cache) if you need a fresh score.

## Priority tiers

```ts
priority: { A: { minimumScore: 80 }, B: { 65 }, C: { 50 }, D: { label: 'Skip' } }
processPriority: ['A', 'B', 'C']  // D skipped; order = processing preference
```

Labels in UI: **A — High Priority**, **B — Good**, **C — Low Priority**, **D — Skip**.

## Templates

Files live under `templates/instagram/` and `templates/linkedin/` (auto-seeded on first run). Variables: `{first_name}`, `{greeting_name}`, `{company}`, `{role}`, `{location}`.

Dashboard → **Templates**: click a template to select it for the campaign (`selectedTemplateId`). Empty selection = auto-pick by prospect type + stage.

Stages: Instagram `initial_contact` / `follow_up_*`; LinkedIn `connection_request` / `post_connection` / `follow_up_*`.

## Personalization

`personalization.enabled` + `allowedProfileFields` + `maximumLength`. Groq lightly adapts the chosen template using **only** visible profile facts — CTA/purpose preserved. Stored: original template, personalized message, reason.

## Conversation intelligence

**Conversations** sidebar: paste prospect ID + visible reply text → Analyze. Categories include INTERESTED, QUESTION, PRICING, etc. Then **Approve Reply** / **Edit & Save** / **Skip**. Auto-send only if `autoSendConversationReplies: true` (default **false**).

## Analytics & Lead Intelligence

- **Analytics**: Instagram and LinkedIn funnels + rates (qualification, acceptance, reply, interest). Use **ALL PLATFORMS** only when you want both panels.
- **Lead Intelligence**: filter by platform, priority, score, status, prospect type; open a prospect for profile + AI analysis + message + conversation.

Persistent store: `data/prospects.json` (prospects + analytics events). AI cache: `data/ai-cache.json`.

## Architecture

```text
                 OUTREACH APP
                      │
             ┌────────┴────────┐
        INSTAGRAM           LINKEDIN
          AGENT               AGENT
             └────────┬────────┘
                 SHARED CORE
           GROQ · STORAGE · ANALYTICS
                 LEAD INTELLIGENCE
```

## Project layout

```text
config.ts
templates/{instagram,linkedin}/*.json
src/
  core/lead-types.ts, prospect-store.ts, template-library.ts
  services/groq.ts
  agent/outreach-agent.ts   # Instagram
  agent/linkedin-agent.ts   # LinkedIn
  dashboard/
tests/groq.test.ts, lead-intelligence.test.ts
```
