(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);

  let state = null;
  let pendingId   = null;   // Instagram confirm
  let liPendingId = null;   // LinkedIn confirm
  let selectedLeadId   = null;
  let liSelectedLeadId = null;

  // ── View titles ───────────────────────────────────────────────────────────────
  const TITLES = {
    'overview':          'Overview',
    'ig-dashboard':      'Instagram · Dashboard',
    'ig-leads':          'Instagram · Lead Intelligence',
    'ig-templates':      'Instagram · Templates',
    'ig-analytics':      'Instagram · Analytics',
    'ig-conversations':  'Instagram · Conversations',
    'li-dashboard':      'LinkedIn · Dashboard',
    'li-campaign':       'LinkedIn · Campaign',
    'li-leads':          'LinkedIn · Lead Intelligence',
    'li-templates':      'LinkedIn · Templates',
    'li-analytics':      'LinkedIn · Analytics',
    'li-conversations':  'LinkedIn · Conversations',
  };

  // ── HTTP helpers ──────────────────────────────────────────────────────────────
  function post(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }).then((r) => r.json().catch(() => ({})));
  }

  function fmt(n) { return n == null ? '—' : String(n); }

  // ── KPI cards ─────────────────────────────────────────────────────────────────
  function renderKpi(el, items) {
    el.innerHTML = items.map(([label, value, colorClass = '']) =>
      `<div class="kpi-card">
        <p class="kpi-label">${label}</p>
        <p class="kpi-value ${colorClass}">${value}</p>
      </div>`
    ).join('');
  }

  // ── Snap list ─────────────────────────────────────────────────────────────────
  function snapList(el, rows) {
    el.innerHTML = rows.map(([k, v]) =>
      `<div class="snap-row"><span class="snap-key">${k}</span><span class="snap-val">${v}</span></div>`
    ).join('');
  }

  // ── Log ───────────────────────────────────────────────────────────────────────
  function appendLog(level, message, timestamp) {
    const t = new Date(timestamp).toLocaleTimeString();
    const row = document.createElement('div');
    row.className = `log-row ${level}`;
    row.textContent = `${t}  ${message}`;
    const log = $('log');
    if (!log) return;
    log.prepend(row);
    while (log.childElementCount > 250) log.removeChild(log.lastChild);
  }

  function appendLiLog(entries) {
    const el = $('liActivityLog');
    if (!el) return;
    el.innerHTML = entries.slice(0, 120).map((e) => {
      const t = new Date(e.timestamp).toLocaleTimeString();
      return `<div class="log-row ${e.level}">${t}  ${e.message}</div>`;
    }).join('');
  }

  // ── Status chip helper ────────────────────────────────────────────────────────
  function statusChipClass(status) {
    if (!status) return '';
    const s = status.toLowerCase();
    if (s === 'running' || s === 'searching' || s === 'inspecting_profile' || s === 'qualifying' || s === 'messaging') return 'running';
    if (s === 'error' || s === 'security_stop') return 'error';
    if (s === 'stopped' || s === 'idle' || s === 'completed') return 'stopped';
    return '';
  }

  // ── OVERVIEW ──────────────────────────────────────────────────────────────────
  function renderOverview(s) {
    const li2 = s.leadIntelligence || {};
    renderKpi($('leadSummaryCards'), [
      ['Total Prospects', fmt(li2.total), ''],
      ['Priority A',      fmt(li2.A),     'accent'],
      ['Priority B',      fmt(li2.B),     'li'],
      ['Interested',      fmt(li2.interested), 'accent'],
    ]);

    const ig = s.instagram?.stats || {};
    const ln = s.linkedin?.stats  || {};

    const igChip = $('igStatusChip');
    if (igChip) { igChip.textContent = ig.status || '—'; igChip.className = `status-chip ${statusChipClass(ig.status)}`; }
    const liChip = $('liStatusChip');
    if (liChip) { liChip.textContent = ln.status || '—'; liChip.className = `status-chip ${statusChipClass(ln.status)}`; }

    snapList($('igSnap'), [
      ['Status',    ig.status    || '—'],
      ['Inspected', fmt(ig.profilesInspected)],
      ['Qualified', fmt(ig.profilesQualified)],
      ['Sent',      fmt(ig.messagesSent)],
    ]);
    snapList($('liSnap'), [
      ['Status',      ln.status || '—'],
      ['Inspected',   fmt(ln.profilesInspected)],
      ['Qualified',   fmt(ln.profilesQualified)],
      ['Connections', fmt(ln.connectionsUsed)],
      ['Msg sent',    fmt(ln.messageSent)],
    ]);
  }

  // ── INSTAGRAM ─────────────────────────────────────────────────────────────────
  function renderInstagram(s) {
    const ig   = s.instagram || {};
    const sess = ig.session  || {};
    const st   = ig.stats    || {};

    const saved = sess.saved;
    if ($('sessionStatus')) {
      $('sessionStatus').textContent  = saved ? '● Saved' : '○ Not saved';
      $('sessionStatus').style.color  = saved ? 'var(--accent)' : 'var(--ink-3)';
    }
    if ($('sessionNote'))    $('sessionNote').textContent    = sess.note    || '—';
    if ($('sessionUser'))    $('sessionUser').textContent    = sess.username ? `@${sess.username}` : '—';
    if ($('sessionSavedAt')) $('sessionSavedAt').textContent = sess.savedAt  ? new Date(sess.savedAt).toLocaleString() : '—';

    renderKpi($('igStats'), [
      ['Status',        `${st.status || '—'}${st.dryRun ? ' · dry-run' : ''}`, statusChipClass(st.status) === 'running' ? 'accent' : ''],
      ['Inspected',     fmt(st.profilesInspected)],
      ['Qualified',     fmt(st.profilesQualified),  'accent'],
      ['Messages Sent', fmt(st.messagesSent),        'accent'],
    ]);

    const ai = ig.currentAi;
    const insightEl = $('igInsight');
    const msgEl     = $('aiMessage');
    if (insightEl) {
      if (!ai) {
        insightEl.innerHTML = '<div class="insight-chip"><p class="ic-label">Lead</p><p class="ic-val">—</p></div>';
        if (msgEl) msgEl.textContent = '—';
      } else if (ai.error) {
        insightEl.innerHTML = `<div class="insight-chip"><p class="ic-label">AI Error</p><p class="ic-val" style="color:var(--danger)">Error</p></div>`;
        if (msgEl) msgEl.textContent = ai.error;
      } else {
        insightEl.innerHTML = [
          ['Profile',    `@${ai.username}`],
          ['Lead Score', `${ai.leadScore ?? '—'}/100`],
          ['Priority',   `<span class="badge-${(ai.priority||'d').toLowerCase()}">${ai.priorityLabel || ai.priority || '—'}</span>`],
          ['Confidence', ai.confidence != null ? `${Math.round(ai.confidence * 100)}%` : '—'],
          ['Status',     ai.qualified ? '✓ Qualified' : '✗ Not qualified'],
          ['Type',       ai.prospectType || '—'],
          ['Template',   ai.templateName || '—'],
          ['Reason',     (ai.reason || '—').slice(0, 70)],
        ].map(([l, v]) => `<div class="insight-chip"><p class="ic-label">${l}</p><p class="ic-val">${v}</p></div>`).join('');
        if (msgEl) msgEl.textContent = ai.generatedMessage || '—';
      }
    }

    const cp = ig.pendingConfirmation;
    const confirmPanel = $('confirmPanel');
    if (confirmPanel) {
      if (cp) {
        const isNew = pendingId !== cp.id;   // only restart countdown for a new confirmation
        pendingId = cp.id;
        confirmPanel.classList.remove('hidden');
        if ($('confirmMeta'))    $('confirmMeta').textContent    = `@${cp.username}  ·  ${cp.profileUrl}`;
        if ($('confirmMessage')) $('confirmMessage').textContent = cp.draftedMessage;
        if (isNew) startConfirmCountdown();  // restart 10s timer
      } else {
        pendingId = null;
        confirmPanel.classList.add('hidden');
        stopConfirmCountdown();
      }
    }

    const igRecords = $('igRecords');
    if (igRecords) {
      igRecords.innerHTML = (ig.recentRecords || []).map((r) => {
        const score = r.leadScore != null ? ` · score=${r.leadScore}` : '';
        const pri   = r.priority ? ` · ${r.priority}` : '';
        const t     = new Date(r.timestamp).toLocaleTimeString();
        return `<div class="record-row">${t}  @${r.username}  ·  ${r.messageStatus}${score}${pri}</div>`;
      }).join('');
    }

    // Security
    const banner = $('securityBanner');
    if (banner) {
      if (st.status === 'security_stop' && st.lastError) {
        banner.classList.remove('hidden');
        const txt = $('securityBannerText');
        if (txt) txt.textContent = `SECURITY STOP (Instagram): ${st.lastError}`;
      }
    }
  }

  // ── LINKEDIN ──────────────────────────────────────────────────────────────────
  function renderLinkedIn(s) {
    const li   = s.linkedin || {};
    const sess = li.session || {};
    const st   = li.stats   || {};

    const saved = sess.saved;
    if ($('liSessionStatus')) {
      $('liSessionStatus').textContent = saved ? '● Saved' : '○ Not saved';
      $('liSessionStatus').style.color = saved ? 'var(--accent)' : 'var(--ink-3)';
    }
    if ($('liSessionNote')) $('liSessionNote').textContent = sess.note || '—';

    renderKpi($('liStats'), [
      ['Status',      `${st.status || '—'}${st.dryRun ? ' · dry-run' : ''}`, statusChipClass(st.status) === 'running' ? 'li' : ''],
      ['Inspected',   fmt(st.profilesInspected)],
      ['Qualified',   fmt(st.profilesQualified),   'accent'],
      ['Pending',     fmt(st.pendingConnections),   'warn'],
      ['Accepted',    fmt(st.accepted),             'accent'],
      ['Msg Pending', fmt(st.messagePending),       'warn'],
      ['Msg Sent',    fmt(st.messageSent),          'li'],
      ['Skipped',     fmt(st.profilesSkipped)],
    ]);

    // Limits
    const connUsed = st.connectionsUsed   ?? 0;
    const connRem  = st.connectionsRemaining ?? 0;
    const connMax  = connUsed + connRem;
    const connPct  = connMax > 0 ? Math.round((connUsed / connMax) * 100) : 0;
    if ($('liConnUsed'))  $('liConnUsed').textContent  = connUsed;
    if ($('liConnMax'))   $('liConnMax').textContent   = connMax || '—';
    if ($('liConnBar'))   $('liConnBar').style.width   = `${connPct}%`;
    if ($('liConnBar'))   $('liConnBar').className     = `limit-fill${connRem === 0 ? ' danger' : ''}`;
    if ($('liConnNote')) {
      if (connRem === 0) { $('liConnNote').textContent = 'Connection limit reached'; $('liConnNote').className = 'limit-note reached'; }
      else               { $('liConnNote').textContent = `${connRem} remaining`;    $('liConnNote').className = 'limit-note'; }
    }

    const msgUsed = st.messagesUsed    ?? 0;
    const msgRem  = st.messagesRemaining ?? 0;
    const msgMax  = msgUsed + msgRem;
    const msgPct  = msgMax > 0 ? Math.round((msgUsed / msgMax) * 100) : 0;
    if ($('liMsgUsed'))  $('liMsgUsed').textContent  = msgUsed;
    if ($('liMsgMax'))   $('liMsgMax').textContent   = msgMax || '—';
    if ($('liMsgBar'))   $('liMsgBar').style.width   = `${msgPct}%`;
    if ($('liMsgBar'))   $('liMsgBar').className     = `limit-fill${msgRem === 0 ? ' danger' : ''}`;
    if ($('liMsgNote')) {
      if (msgRem === 0) { $('liMsgNote').textContent = 'Message limit reached'; $('liMsgNote').className = 'limit-note reached'; }
      else              { $('liMsgNote').textContent = `${msgRem} remaining`;   $('liMsgNote').className = 'limit-note'; }
    }

    // Confirmation
    const cp = li.pendingConfirmation;
    const liCp = $('liConfirmPanel');
    if (liCp) {
      if (cp) {
        liPendingId = cp.id;
        liCp.classList.remove('hidden');
        if ($('liConfirmMeta'))    $('liConfirmMeta').textContent    = `${cp.name}  ·  ${cp.profileUrl}`;
        if ($('liConfirmMessage')) $('liConfirmMessage').textContent = cp.draftedMessage;
      } else {
        liPendingId = null;
        liCp.classList.add('hidden');
      }
    }

    // Security banner
    const liSec = $('liSecurityBanner');
    if (liSec) {
      if (st.status === 'security_stop' && st.lastError) {
        liSec.classList.remove('hidden');
        const t = $('liSecurityBannerText');
        if (t) t.textContent = `LinkedIn security check detected — ${st.lastError}`;
      } else {
        liSec.classList.add('hidden');
      }
    }

    // Pending table
    renderPendingTable(li.pendingConnections || []);

    // Activity log
    appendLiLog(li.activityLog || []);

    // Campaign tab
    const liCampaignCards = $('liCampaignCards');
    if (liCampaignCards) {
      renderKpi(liCampaignCards, [
        ['Connections Used', fmt(connUsed), ''],
        ['Remaining',        fmt(connRem),  connRem === 0 ? 'warn' : 'accent'],
        ['Messages Sent',    fmt(msgUsed),  'li'],
        ['Msg Remaining',    fmt(msgRem),   msgRem === 0 ? 'warn' : 'accent'],
      ]);
    }
    if ($('liCampaignSnap')) {
      snapList($('liCampaignSnap'), [
        ['Status',    st.status || '—'],
        ['Inspected', fmt(st.profilesInspected)],
        ['Qualified', fmt(st.profilesQualified)],
        ['Pending',   fmt(st.pendingConnections)],
        ['Accepted',  fmt(st.accepted)],
      ]);
    }
    const lls = s.leadIntelligence || {};
    if ($('liCampaignLeadSummary')) {
      snapList($('liCampaignLeadSummary'), [
        ['Total',      fmt(lls.total)],
        ['Priority A', fmt(lls.A)],
        ['Priority B', fmt(lls.B)],
        ['Qualified',  fmt(lls.qualified)],
        ['Interested', fmt(lls.interested)],
      ]);
    }
  }

  // ── PENDING TABLE ─────────────────────────────────────────────────────────────
  function renderPendingTable(rows) {
    const el = $('liPendingTable');
    if (!el) return;

    const header = `<div class="pending-table-header">
      <span>Name</span><span>Company</span><span>Role</span>
      <span>Sent</span><span>Status</span><span>Action</span>
    </div>`;

    if (!rows.length) {
      el.innerHTML = header + `<p class="empty-state">No pending connections yet.</p>`;
      return;
    }

    const statusBadge = (status) => {
      const map = {
        'CONNECTION_SENT': ['badge-pending',  'Sent'],
        'PENDING':         ['badge-pending',  'Pending'],
        'ACCEPTED':        ['badge-accepted', 'Accepted'],
        'MESSAGE_READY':   ['badge-accepted', 'Ready'],
        'MESSAGE_SENT':    ['badge-sent',     'Messaged'],
        'FAILED':          ['badge-failed',   'Failed'],
        'SKIPPED':         ['badge-skipped',  'Skipped'],
      };
      const [cls, label] = map[status] || ['badge-skipped', status];
      return `<span class="badge ${cls}">${label}</span>`;
    };

    el.innerHTML = header + rows.map((r) => {
      const sent = r.connectionSentAt ? new Date(r.connectionSentAt).toLocaleDateString() : '—';
      const canAct = ['ACCEPTED','MESSAGE_READY'].includes(r.connectionStatus);
      const isDone = r.connectionStatus === 'MESSAGE_SENT';
      const actionLabel = canAct ? 'Message' : isDone ? '✓ Done' : 'Check';
      const actionClass = canAct ? 'btn btn-primary btn-sm' : 'btn btn-ghost btn-sm';
      return `<div class="pending-table-row">
        <span class="name-cell">${r.name || '—'}</span>
        <span class="sub-cell">${r.company || '—'}</span>
        <span class="sub-cell">${r.role || r.headline || '—'}</span>
        <span class="sub-cell">${sent}</span>
        <span>${statusBadge(r.connectionStatus)}</span>
        <span><button class="${actionClass}" onclick="processOne('${r.id}')">${actionLabel}</button></span>
      </div>`;
    }).join('');
  }

  window.processOne = function(id) {
    post(`/api/linkedin/pending/${id}/process`).then(() => loadLinkedInPending());
  };

  async function loadLinkedInPending() {
    const rows = await fetch('/api/linkedin/pending').then((r) => r.json()).catch(() => []);
    renderPendingTable(rows);
  }

  // ── CONFIRM PANEL — 10-second countdown + auto-approve display ───────────────
  let _countdownTimer = null;
  let _countdownSecs  = 10;

  function startConfirmCountdown() {
    stopConfirmCountdown();
    _countdownSecs = 10;
    const el = $('igAutoCountdown');
    if (!el) return;

    function tick() {
      if (!el) return;
      el.textContent = `Auto in ${_countdownSecs}s`;
      el.className   = `auto-approve-countdown${_countdownSecs <= 3 ? ' urgent' : ''}`;
      if (_countdownSecs <= 0) { el.textContent = 'Sending…'; stopConfirmCountdown(); return; }
      _countdownSecs--;
      _countdownTimer = setTimeout(tick, 1000);
    }
    tick();
  }

  function stopConfirmCountdown() {
    if (_countdownTimer) { clearTimeout(_countdownTimer); _countdownTimer = null; }
    const el = $('igAutoCountdown');
    if (el) { el.textContent = ''; el.className = 'auto-approve-countdown'; }
  }

  // ── QUERY MANAGER ─────────────────────────────────────────────────────────────
  async function loadIgQueries() {
    const data = await fetch('/api/instagram/queries').then((r) => r.json()).catch(() => null);
    if (!data) return;

    const seeds    = data.seeds    || [];
    const preview  = data.preview  || {};
    const round    = preview.round || 'seed';
    const queries  = preview.queries || [];

    // Update round badge
    const badge = $('igQueryRoundBadge');
    if (badge) {
      badge.textContent = round === 'seed' ? 'Next: Seeds' : 'Next: Long-tail';
      badge.className   = `query-round-badge ${round}`;
    }

    // Populate input with current seeds if empty
    const input = $('igQueryInput');
    if (input && !input.value && seeds.length) {
      input.value = seeds.join(', ');
    }

    // Render preview chips
    renderQueryPreview(seeds, queries, round);
  }

  function renderQueryPreview(seeds, nextQueries, round) {
    const el = $('igQueryPreview');
    if (!el) return;

    if (!seeds.length) {
      el.innerHTML = '<p style="color:var(--ink-3);font-size:0.82rem;grid-column:1/-1">No queries set yet. Enter keywords above and click Save Queries.</p>';
      return;
    }

    const isSeedRound = round === 'seed';

    // Section: seeds
    let html = `<div style="grid-column:1/-1" class="query-next-label">Seeds (${seeds.length})</div>`;
    seeds.forEach((q, i) => {
      html += `<div class="query-chip seed-chip">
        <span class="query-chip-num">${i + 1}</span>
        <span class="query-chip-text">${q}</span>
        ${isSeedRound ? '<span class="query-chip-type">▶ next</span>' : ''}
      </div>`;
    });

    // Section: next run queries
    if (nextQueries.length) {
      html += `<div style="grid-column:1/-1" class="query-next-label">${isSeedRound ? 'This run' : 'Next run — Long-tail variants'}</div>`;
      nextQueries.forEach((q, i) => {
        html += `<div class="query-chip expanded-chip">
          <span class="query-chip-num">${i + 1}</span>
          <span class="query-chip-text">${q}</span>
          ${!isSeedRound ? '<span class="query-chip-type">▶ next</span>' : ''}
        </div>`;
      });
    }

    el.innerHTML = html;
  }

  async function saveIgQueries() {
    const input = $('igQueryInput');
    if (!input) return;
    const csv = input.value.trim();
    if (!csv) { alert('Enter at least one keyword.'); return; }

    const keywords = csv.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);

    const res = await post('/api/instagram/queries', { csv });
    if (res.seeds) {
      // Update input to show cleaned/trimmed seeds
      input.value = res.seeds.join('\n');
    }
    await loadIgQueries();
  }
  function analyticsBlock(title, a, accentColor) {
    if (!a) return '';
    const rate = (n) => Math.min(100, Math.round(n || 0));
    const stat = (label, val) =>
      `<div class="analytics-stat"><span class="analytics-key">${label}</span><span class="analytics-val">${val}</span></div>`;
    const rateRow = (label, pct) =>
      `<div class="analytics-rate">
        <span class="analytics-rate-label">${label}</span>
        <div class="rate-bar"><div class="rate-fill" style="width:${rate(pct)}%;background:var(--${accentColor})"></div></div>
        <span class="rate-val">${(pct||0).toFixed(1)}%</span>
      </div>`;
    return `<div class="panel">
      <div class="panel-header"><span class="panel-title" style="color:var(--${accentColor})">${title}</span></div>
      ${stat('Discovered',  a.profilesDiscovered)}
      ${stat('Inspected',   a.profilesInspected)}
      ${stat('Qualified',   a.profilesQualified)}
      ${stat('Messages Sent', a.messagesSent)}
      ${stat('Replies',     a.repliesReceived)}
      ${stat('Interested',  a.interested)}
      ${stat('Connections', `${a.connectionsSent} sent · ${a.connectionsAccepted} accepted`)}
      <div class="analytics-section-divider"></div>
      ${rateRow('Qualification rate', a.qualificationRate)}
      ${rateRow('Connection acceptance', a.connectionAcceptanceRate)}
      ${rateRow('Reply rate', a.messageReplyRate)}
      ${rateRow('Interest rate', a.interestRate)}
      <div class="analytics-section-divider"></div>
      ${stat('Priority A/B/C/D', `${a.priorityCounts.A} / ${a.priorityCounts.B} / ${a.priorityCounts.C} / ${a.priorityCounts.D}`)}
    </div>`;
  }

  async function loadAnalytics(panelId, platformSelectId) {
    const platform = $(platformSelectId)?.value || 'all';
    const data = await fetch(`/api/analytics?platform=${platform}`).then((r) => r.json());
    const el = $(panelId);
    if (!el) return;
    if (platform === 'all') {
      el.innerHTML = analyticsBlock('Instagram', data.instagram, 'ig') + analyticsBlock('LinkedIn', data.linkedin, 'li');
    } else if (platform === 'instagram') {
      el.innerHTML = analyticsBlock('Instagram', data.instagram, 'ig');
    } else {
      el.innerHTML = analyticsBlock('LinkedIn', data.linkedin, 'li');
    }
  }

  // ── LEADS ─────────────────────────────────────────────────────────────────────
  async function loadLeads(tableId, detailId, platformVal, priorityId, scoreId, typeId, statusId, selectedIdRef) {
    const qs = new URLSearchParams({ platform: platformVal || 'all' });
    const pri = $(priorityId)?.value; if (pri) qs.set('priority', pri);
    const sc  = $(scoreId)?.value;    if (sc)  qs.set('minScore', sc);
    const ty  = $(typeId)?.value?.trim(); if (ty) qs.set('prospectType', ty);
    const st  = $(statusId)?.value;   if (st)  qs.set('conversationStatus', st);

    const rows = await fetch(`/api/leads?${qs}`).then((r) => r.json()).catch(() => []);
    const el = $(tableId);
    if (!el) return;

    if (!rows.length) { el.innerHTML = '<p class="empty-state">No prospects found.</p>'; return; }

    el.innerHTML = rows.map((r) => {
      const labels = { A: 'High', B: 'Good', C: 'Low', D: 'Skip' };
      return `<div class="lead-row" data-id="${r.id}">
        <div class="lead-row-top">
          <span class="lead-name">${r.name || '—'}</span>
          <span class="badge-${r.priority.toLowerCase()}">${r.priority} · ${labels[r.priority] || ''}</span>
        </div>
        <div class="lead-meta">${r.leadScore}/100 · ${r.platform} · ${r.prospectType} · ${r.conversationStatus}</div>
      </div>`;
    }).join('');

    el.querySelectorAll('.lead-row').forEach((row) => {
      row.addEventListener('click', () => showLead(row.dataset.id, detailId));
    });
  }

  async function showLead(id, detailId) {
    if (detailId === 'leadDetail') selectedLeadId = id;
    else liSelectedLeadId = id;

    const r = await fetch(`/api/leads/${id}`).then((res) => res.json());
    if ($('convProspectId')   && detailId === 'leadDetail')   $('convProspectId').value   = id;
    if ($('liConvProspectId') && detailId === 'liLeadDetail') $('liConvProspectId').value = id;

    const priLabel = { A: 'High Priority', B: 'Good', C: 'Low Priority', D: 'Skip' }[r.priority] || r.priority;
    const el = $(detailId);
    if (!el) return;
    el.innerHTML = `
      <div class="panel-header"><span class="panel-title">Prospect Detail</span></div>
      <h3>Profile</h3>
      <p><strong>${r.name}</strong> &middot; ${r.platform}</p>
      <p style="color:var(--ink-3);font-size:0.83rem">@${r.username}</p>
      <p style="font-size:0.83rem;margin-top:4px"><a href="${r.profileUrl}" target="_blank" rel="noreferrer">${r.profileUrl}</a></p>
      <p style="font-size:0.83rem;color:var(--ink-2);margin-top:6px">${r.role || '—'} &middot; ${r.company || '—'} &middot; ${r.location || '—'}</p>
      <h3>AI Analysis</h3>
      <p>Score: <strong>${r.leadScore}/100</strong> &nbsp; Confidence: <strong>${Math.round((r.leadConfidence||0)*100)}%</strong></p>
      <p>Status: <strong>${r.qualified ? '✓ Qualified' : '✗ Not qualified'}</strong> &nbsp; Priority: <strong class="badge-${r.priority.toLowerCase()}">${r.priority} — ${priLabel}</strong></p>
      <p style="font-size:0.83rem;color:var(--ink-3);margin-top:4px">${r.qualificationReason || '—'}</p>
      <p style="font-size:0.83rem;margin-top:4px">Type: <strong>${r.prospectType}</strong></p>
      <h3>Message</h3>
      <p style="font-size:0.8rem;color:var(--ink-3)">Template: ${r.templateId || '—'}</p>
      <pre class="message-pre" style="margin-top:6px">${r.personalizedMessage || r.originalMessage || '—'}</pre>
      <h3>Conversation</h3>
      <p>Status: <strong>${r.conversationStatus}</strong> &nbsp; Reply: <strong>${r.suggestedReplyStatus || '—'}</strong></p>
      <p style="font-size:0.83rem;color:var(--ink-3);margin-top:4px">${r.lastReplyText || 'No reply yet'}</p>
      <pre class="message-pre" style="margin-top:6px">${r.approvedReplyText || r.lastSuggestedReply || '—'}</pre>`;
  }

  // ── TEMPLATES ─────────────────────────────────────────────────────────────────
  async function loadTemplates(listId, previewId, platformSelectId) {
    const platform = $(platformSelectId)?.value || '';
    const qs = platform ? `?platform=${platform}` : '';
    const rows = await fetch(`/api/templates${qs}`).then((r) => r.json()).catch(() => []);
    const selected = state?.selectedTemplateId || '';
    const el = $(listId);
    if (!el) return;
    if (!rows.length) { el.innerHTML = '<p class="empty-state">No templates found.</p>'; return; }

    el.innerHTML = rows.map((t) =>
      `<div class="template-row${selected === t.id ? ' selected' : ''}" data-id="${t.id}">
        <p class="template-row-name">${t.name} ${selected === t.id ? '<span style="color:var(--accent)">✓</span>' : ''}</p>
        <p class="template-row-meta">${t.platform} · ${t.stage}</p>
      </div>`
    ).join('');

    el.querySelectorAll('.template-row').forEach((row) => {
      row.addEventListener('click', async () => {
        const id  = row.dataset.id;
        await post('/api/templates/select', { id });
        const t = rows.find((x) => x.id === id);
        const pv = $(previewId);
        if (pv) pv.textContent = t ? `${t.name}\n\n${t.body}` : '—';
        await loadTemplates(listId, previewId, platformSelectId);
      });
    });
  }

  // ── MASTER STATE ──────────────────────────────────────────────────────────────
  function renderState(s) {
    state = s;

    const camp = s.campaign || {};
    const camplabel = $('campaignLabel');
    if (camplabel) camplabel.textContent = camp.name ? `${camp.name}  ·  ${camp.id}` : '—';

    const g = s.groq || s.instagram?.groq || {};
    const groqLabel = $('groqLabel');
    const groqDot   = $('groqDot');
    if (groqLabel) groqLabel.textContent = `Groq · ${g.status || '—'}`;
    if (groqDot) {
      groqDot.className = `groq-dot${g.status === 'connected' ? ' ok' : g.status === 'error' ? ' err' : ''}`;
    }

    renderOverview(s);
    renderInstagram(s);
    renderLinkedIn(s);
  }

  // ── NAVIGATION ────────────────────────────────────────────────────────────────
  let currentView = 'overview';

  function activateView(view) {
    currentView = view;
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    const vEl = $(`view-${view}`);
    if (vEl) vEl.classList.add('active');

    const titleEl = $('viewTitle');
    if (titleEl) titleEl.textContent = TITLES[view] || view;

    // Lazy-load data for each view
    if (view === 'ig-dashboard')     loadIgQueries();
    if (view === 'ig-leads')         loadLeads('leadsTable', 'leadDetail', 'instagram', 'filterPriority', 'filterMinScore', 'filterProspectType', 'filterStatus', 'selectedLeadId');
    if (view === 'ig-analytics')     loadAnalytics('analyticsPanels', 'analyticsPlatform');
    if (view === 'ig-templates')     loadTemplates('templatesList', 'templatePreview', 'templatePlatform');
    if (view === 'li-dashboard')     loadLinkedInPending();
    if (view === 'li-leads')         loadLeads('liLeadsTable', 'liLeadDetail', 'linkedin', 'liFilterPriority', 'liFilterMinScore', null, null, 'liSelectedLeadId');
    if (view === 'li-analytics')     loadAnalytics('liAnalyticsPanels', 'liAnalyticsPlatform');
    if (view === 'li-templates')     loadTemplates('liTemplatesList', 'liTemplatePreview', 'liTemplatePlatform');
    if (view === 'li-campaign' && state) renderLinkedIn(state);
  }

  // Top-level nav items
  document.querySelectorAll('.nav-item[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.nav-child').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      activateView(btn.dataset.view);
    });
  });

  // Group triggers (dropdowns)
  // Map data-group value → the actual element id used in the HTML
  const GROUP_ID_MAP = { instagram: 'ig-children', linkedin: 'li-children' };

  document.querySelectorAll('.nav-group-trigger').forEach((trigger) => {
    trigger.addEventListener('click', () => {
      const group     = trigger.dataset.group;
      const childrenId = GROUP_ID_MAP[group] || `${group}-children`;
      const children  = $(childrenId);
      const isOpen    = trigger.classList.contains('open');

      // Close all groups first
      document.querySelectorAll('.nav-group-trigger').forEach((t) => {
        t.classList.remove('open');
        const gId = GROUP_ID_MAP[t.dataset.group] || `${t.dataset.group}-children`;
        $(gId)?.classList.remove('open');
      });

      // Toggle clicked group open
      if (!isOpen) {
        trigger.classList.add('open');
        children?.classList.add('open');
      }
    });
  });

  // Child nav items
  document.querySelectorAll('.nav-child[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.nav-child').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');

      // Keep the parent group open and highlight its trigger
      const parentChildren = btn.closest('.nav-group-children');
      const parentTrigger  = parentChildren?.previousElementSibling;
      if (parentTrigger) parentTrigger.classList.add('open');
      parentChildren?.classList.add('open');

      activateView(btn.dataset.view);
    });
  });

  // ── INSTAGRAM BUTTONS ────────────────────────────────────────────────────────
  const ig = {
    btnIgStart:   () => post('/api/instagram/start'),
    btnIgStop:    () => { stopConfirmCountdown(); return post('/api/instagram/stop'); },
    btnIgLogin:   () => post('/api/instagram/login'),
    btnIgClose:   () => post('/api/instagram/browser/close'),
    btnIgClear:   () => confirm('Clear Instagram login?') && post('/api/instagram/session/clear'),
    btnIgReplace: () => confirm('Replace Instagram login?') && post('/api/instagram/session/replace'),
    btnApprove:   () => { stopConfirmCountdown(); return pendingId && post('/api/instagram/confirm', { id: pendingId, decision: 'approve' }); },
    btnReject:    () => { stopConfirmCountdown(); return pendingId && post('/api/instagram/confirm', { id: pendingId, decision: 'reject' }); },
  };
  Object.entries(ig).forEach(([id, fn]) => { const el = $(id); if (el) el.onclick = fn; });

  // Query manager buttons
  const btnIgSaveQueries = $('btnIgSaveQueries');
  if (btnIgSaveQueries) btnIgSaveQueries.onclick = saveIgQueries;
  const btnIgLoadQueries = $('btnIgLoadQueries');
  if (btnIgLoadQueries) btnIgLoadQueries.onclick = loadIgQueries;

  // ── LINKEDIN BUTTONS ─────────────────────────────────────────────────────────
  const li = {
    btnLiStart:          () => post('/api/linkedin/start'),
    btnLiStartNew:       () => post('/api/linkedin/start-new'),
    btnLiStartPending:   () => post('/api/linkedin/start-pending'),
    btnLiStop:           () => post('/api/linkedin/stop'),
    btnLiLogin:          () => post('/api/linkedin/login'),
    btnLiClose:          () => post('/api/linkedin/browser/close'),
    btnLiClear:          () => confirm('Clear LinkedIn login?') && post('/api/linkedin/session/clear'),
    btnLiApprove:        () => liPendingId && post('/api/linkedin/confirm', { id: liPendingId, decision: 'approve' }),
    btnLiReject:         () => liPendingId && post('/api/linkedin/confirm', { id: liPendingId, decision: 'reject' }),
    btnLiReloadPending:  () => loadLinkedInPending(),
  };
  Object.entries(li).forEach(([id, fn]) => { const el = $(id); if (el) el.onclick = fn; });

  // ── FILTER BUTTONS ───────────────────────────────────────────────────────────
  const reloadIgLeads = () => loadLeads('leadsTable','leadDetail','instagram','filterPriority','filterMinScore','filterProspectType','filterStatus','selectedLeadId');
  const reloadLiLeads = () => loadLeads('liLeadsTable','liLeadDetail','linkedin','liFilterPriority','liFilterMinScore',null,null,'liSelectedLeadId');

  const filterBtn = $(    'btnReloadLeads');   if (filterBtn) filterBtn.onclick = reloadIgLeads;
  const liFilterBtn = $('btnLiReloadLeads'); if (liFilterBtn) liFilterBtn.onclick = reloadLiLeads;
  const igAnalBtn = $('btnReloadAnalytics'); if (igAnalBtn) igAnalBtn.onclick = () => loadAnalytics('analyticsPanels','analyticsPlatform');
  const liAnalBtn = $('btnLiReloadAnalytics'); if (liAnalBtn) liAnalBtn.onclick = () => loadAnalytics('liAnalyticsPanels','liAnalyticsPlatform');
  const igTplBtn = $('btnReloadTemplates'); if (igTplBtn) igTplBtn.onclick = () => loadTemplates('templatesList','templatePreview','templatePlatform');
  const liTplBtn = $('btnLiReloadTemplates'); if (liTplBtn) liTplBtn.onclick = () => loadTemplates('liTemplatesList','liTemplatePreview','liTemplatePlatform');

  // ── INSTAGRAM CONVERSATION ────────────────────────────────────────────────────
  const btnAnalyzeConv = $('btnAnalyzeConv');
  if (btnAnalyzeConv) {
    btnAnalyzeConv.onclick = async () => {
      const res = await post('/api/conversation/analyze', {
        prospectId: $('convProspectId')?.value.trim(),
        conversationText: $('convText')?.value.trim(),
      });
      const convResult = $('convResult');
      const convMeta   = $('convMeta');
      if (!res.ok) {
        if (convResult) convResult.textContent = res.error || 'Analysis failed';
        if (convMeta)   convMeta.innerHTML = '';
        return;
      }
      const a = res.analysis || {};
      if (convMeta) convMeta.innerHTML = [
        ['Category', a.category||'—'], ['Confidence', a.confidence!=null?`${Math.round(a.confidence*100)}%`:'—'], ['Sentiment', a.sentiment||'—'],
      ].map(([l,v]) => `<div class="insight-chip"><p class="ic-label">${l}</p><p class="ic-val">${v}</p></div>`).join('');
      if (convResult) convResult.textContent = a.summary || JSON.stringify(a, null, 2);
      const convSuggested = $('convSuggested');
      if (convSuggested) convSuggested.value = a.suggestedReply || '';
      const note = $('convDecisionNote');
      if (note) note.textContent = 'Suggested reply ready — Approve, Edit & Save, or Skip.';
      if (selectedLeadId) showLead(selectedLeadId, 'leadDetail');
    };
  }

  async function replyDecision(decision, prospectIdEl, suggestedEl, noteEl, detailId, selectedIdFn) {
    const prospectId = $(prospectIdEl)?.value.trim();
    const editedReply = $(suggestedEl)?.value;
    const res = await post('/api/conversation/reply-decision', { prospectId, decision, editedReply });
    const n = $(noteEl);
    if (n) n.textContent = res.note || res.error || JSON.stringify(res);
    if (prospectId) showLead(prospectId, detailId);
  }

  const btnAr = $('btnApproveReply'); if (btnAr) btnAr.onclick = () => replyDecision('approve','convProspectId','convSuggested','convDecisionNote','leadDetail',()=>selectedLeadId);
  const btnEr = $('btnEditReply');    if (btnEr) btnEr.onclick = () => replyDecision('edit',   'convProspectId','convSuggested','convDecisionNote','leadDetail',()=>selectedLeadId);
  const btnSr = $('btnSkipReply');    if (btnSr) btnSr.onclick = () => replyDecision('skip',   'convProspectId','convSuggested','convDecisionNote','leadDetail',()=>selectedLeadId);

  // ── LINKEDIN CONVERSATION ─────────────────────────────────────────────────────
  const btnLiAnalyzeConv = $('btnLiAnalyzeConv');
  if (btnLiAnalyzeConv) {
    btnLiAnalyzeConv.onclick = async () => {
      const res = await post('/api/conversation/analyze', {
        prospectId: $('liConvProspectId')?.value.trim(),
        conversationText: $('liConvText')?.value.trim(),
      });
      const liConvResult = $('liConvResult');
      const liConvMeta   = $('liConvMeta');
      if (!res.ok) {
        if (liConvResult) liConvResult.textContent = res.error || 'Analysis failed';
        if (liConvMeta)   liConvMeta.innerHTML = '';
        return;
      }
      const a = res.analysis || {};
      if (liConvMeta) liConvMeta.innerHTML = [
        ['Category', a.category||'—'], ['Confidence', a.confidence!=null?`${Math.round(a.confidence*100)}%`:'—'], ['Sentiment', a.sentiment||'—'],
      ].map(([l,v]) => `<div class="insight-chip"><p class="ic-label">${l}</p><p class="ic-val">${v}</p></div>`).join('');
      if (liConvResult) liConvResult.textContent = a.summary || JSON.stringify(a, null, 2);
      const liConvSuggested = $('liConvSuggested');
      if (liConvSuggested) liConvSuggested.value = a.suggestedReply || '';
      const note = $('liConvDecisionNote');
      if (note) note.textContent = 'Suggested reply ready.';
      if (liSelectedLeadId) showLead(liSelectedLeadId, 'liLeadDetail');
    };
  }

  const btnLiAr = $('btnLiApproveReply'); if (btnLiAr) btnLiAr.onclick = () => replyDecision('approve','liConvProspectId','liConvSuggested','liConvDecisionNote','liLeadDetail',()=>liSelectedLeadId);
  const btnLiEr = $('btnLiEditReply');    if (btnLiEr) btnLiEr.onclick = () => replyDecision('edit',   'liConvProspectId','liConvSuggested','liConvDecisionNote','liLeadDetail',()=>liSelectedLeadId);
  const btnLiSr = $('btnLiSkipReply');    if (btnLiSr) btnLiSr.onclick = () => replyDecision('skip',   'liConvProspectId','liConvSuggested','liConvDecisionNote','liLeadDetail',()=>liSelectedLeadId);

  // ── WEBSOCKET ─────────────────────────────────────────────────────────────────
  const wsIndicator = $('wsIndicator');
  function setWsStatus(connected) {
    if (!wsIndicator) return;
    const dot   = wsIndicator.querySelector('.ws-dot');
    const label = wsIndicator.querySelector('.ws-label');
    if (connected) {
      wsIndicator.style.borderColor = 'rgba(52,216,126,0.3)';
      if (dot)   { dot.style.background = 'var(--accent)'; dot.style.boxShadow = '0 0 5px var(--accent)'; }
      if (label) label.textContent = 'Live';
    } else {
      wsIndicator.style.borderColor = 'rgba(240,96,90,0.3)';
      if (dot)   { dot.style.background = 'var(--danger)'; dot.style.boxShadow = 'none'; }
      if (label) label.textContent = 'Offline';
    }
  }

  function connectWs() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);

    ws.addEventListener('open',    () => setWsStatus(true));
    ws.addEventListener('close',   () => { setWsStatus(false); setTimeout(connectWs, 1500); });
    ws.addEventListener('error',   () => setWsStatus(false));
    ws.addEventListener('message', (ev) => {
      let data;
      try { data = JSON.parse(ev.data); } catch { return; }
      if (data.type === 'state') renderState(data.payload);
      if (data.type === 'log')   appendLog(data.payload.level, data.payload.message, data.payload.timestamp);
      if (data.type === 'security_stop') {
        const platform = data.payload.platform || 'unknown';
        if (platform === 'linkedin') {
          const sec = $('liSecurityBanner');
          const txt = $('liSecurityBannerText');
          if (sec) sec.classList.remove('hidden');
          if (txt) txt.textContent = `LinkedIn security check: ${data.payload.reason}`;
        } else {
          const sec = $('securityBanner');
          const txt = $('securityBannerText');
          if (sec) sec.classList.remove('hidden');
          if (txt) txt.textContent = `SECURITY STOP (Instagram): ${data.payload.reason}`;
        }
      }
    });
  }

  // ── BOOT ─────────────────────────────────────────────────────────────────────
  fetch('/api/state').then((r) => r.json()).then(renderState).catch(() => undefined);
  loadIgQueries();
  connectWs();
  setWsStatus(false);
})();
