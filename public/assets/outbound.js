'use strict';

/* Outbound dashboard: import wa.me links, track statuses, start/pause pacing. */
(function () {
  const importForm = document.querySelector('[data-form="import"]');
  const configForm = document.querySelector('[data-form="config"]');
  const filter = document.querySelector('[data-bind="status-filter"]');
  const search = document.querySelector('[data-bind="search"]');
  const rows = document.querySelector('[data-bind="lead-rows"]');
  const count = document.querySelector('[data-bind="lead-count"]');
  const runState = document.querySelector('[data-bind="run-state"]');
  const toggle = document.querySelector('[data-action="start-pause"]');

  let enabled = false;
  let cachedLeads = [];

  function fmt(ts) {
    if (!ts) return '—';
    try {
      return new Date(ts).toLocaleString();
    } catch {
      return '—';
    }
  }

  const PILL_STYLES = {
    pending: 'bg-amber-100 text-amber-900',
    queued: 'bg-amber-100 text-amber-900',
    scheduled: 'bg-sky-100 text-sky-900',
    sent: 'bg-sky-100 text-sky-900',
    replied: 'bg-emerald-600 text-white',
    failed: 'bg-red-100 text-red-900',
    opted_out: 'bg-zinc-200 text-zinc-600',
    not_contacted: 'bg-zinc-200 text-zinc-600',
  };
  const PILL_LABELS = {
    pending: 'waiting',
    queued: 'waiting',
    scheduled: 'scheduled',
    sent: 'sent',
    replied: 'replied',
    failed: 'failed',
    opted_out: 'opted out',
    not_contacted: 'not contacted',
  };

  function pill(status) {
    const el = document.createElement('span');
    el.className = 'rounded-full px-3 py-1 text-[12px] font-medium whitespace-nowrap ' + (PILL_STYLES[status] || 'bg-surface-container text-on-surface-variant');
    el.textContent = PILL_LABELS[status] || status;
    return el;
  }

  function renderLeads(leads) {
    cachedLeads = leads;
    const q = (search.value || '').trim().toLowerCase();
    const visible = q
      ? leads.filter((l) => ('+' + l.phone).includes(q) || (l.name || '').toLowerCase().includes(q) || (l.message || '').toLowerCase().includes(q))
      : leads;
    count.textContent = visible.length + (visible.length === 1 ? ' lead' : ' leads');
    rows.textContent = '';
    if (!visible.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 8;
      td.className = 'py-6 text-center text-on-surface-variant';
      td.textContent = q ? 'No leads match that search.' : 'No leads yet. Paste wa.me links above.';
      tr.appendChild(td);
      rows.appendChild(tr);
      return;
    }
    for (const lead of visible) {
      const tr = document.createElement('tr');
      tr.className = 'border-t border-outline-variant/20 align-top';
      const phone = document.createElement('td');
      phone.className = 'py-2 pr-3 whitespace-nowrap';
      phone.textContent = '+' + lead.phone + (lead.name ? ' (' + lead.name + ')' : '');
      const msg = document.createElement('td');
      msg.className = 'py-2 pr-3 max-w-[280px] cursor-pointer text-on-surface-variant';
      const full = lead.message || '—';
      const short = full.length > 70 ? full.slice(0, 70) + '…' : full;
      let expanded = false;
      msg.textContent = short;
      msg.title = full;
      msg.addEventListener('click', () => {
        expanded = !expanded;
        msg.textContent = expanded ? full : short;
      });
      const st = document.createElement('td');
      st.className = 'py-2 pr-3';
      st.appendChild(pill(lead.status));
      const via = document.createElement('td');
      via.className = 'py-2 pr-3 whitespace-nowrap text-on-surface-variant';
      via.textContent = lead.sent_via || lead.account_id || '—';
      const sched = document.createElement('td');
      sched.className = 'py-2 pr-3 whitespace-nowrap';
      sched.textContent = lead.status === 'scheduled' ? fmt(lead.scheduled_at) : '—';
      const sent = document.createElement('td');
      sent.className = 'py-2 pr-3 whitespace-nowrap';
      sent.textContent = fmt(lead.sent_at);
      const reply = document.createElement('td');
      reply.className = 'py-2 pr-3 whitespace-nowrap';
      reply.textContent = fmt(lead.replied_at);
      const act = document.createElement('td');
      act.className = 'py-2 text-right';
      if (['pending', 'queued', 'failed', 'scheduled'].includes(lead.status)) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'rounded-full px-3 py-1 text-[12px] bg-surface-container';
        btn.textContent = 'Remove';
        btn.addEventListener('click', async () => {
          await App.withBusy(btn, async () => {
            await App.api('/outbound/' + lead.id, { method: 'DELETE' });
            await refresh();
          }).catch((err) => App.toast(err.message, 'error'));
        });
        act.appendChild(btn);
      }
      tr.append(phone, msg, st, via, sched, sent, reply, act);
      rows.appendChild(tr);
    }
  }

  function renderStats(stats) {
    enabled = Boolean(stats.enabled);
    document.querySelector('[data-bind="daily-text"]').textContent =
      stats.todaySent + '/' + stats.dailyCap + ' sent';
    document.querySelector('[data-bind="daily-bar"]').style.width =
      stats.dailyCap > 0 ? Math.min(100, Math.round((stats.todaySent / stats.dailyCap) * 100)) + '%' : '0%';
    document.querySelector('[data-bind="stat-pending"]').textContent = stats.notContacted;
    document.querySelector('[data-bind="stat-sent"]').textContent = stats.sent;
    document.querySelector('[data-bind="stat-replied"]').textContent = stats.replied;
    document.querySelector('[data-bind="stat-failed"]').textContent = stats.failed;
    document.querySelector('[data-bind="stat-optedout"]').textContent = stats.optedOut;
    runState.textContent = enabled ? 'Sending' : 'Paused';
    toggle.textContent = enabled ? 'Pause' : stats.todaySent > 0 ? 'Resume sending' : 'Start sending';
    // Per-number split: 70 over 2 numbers shows ~35 each.
    const perBox = document.querySelector('[data-bind="per-account"]');
    if (perBox) {
      perBox.textContent = '';
      const list = stats.perAccount || [];
      if (list.length > 1) {
        for (const a of list) {
          const row = document.createElement('div');
          row.className = 'flex items-center justify-between gap-3 rounded-lg bg-surface-container px-3.5 py-2.5';
          const left = document.createElement('span');
          left.className = 'font-body-sm text-body-sm text-on-surface-variant';
          left.textContent = (a.connected ? '● ' : '○ ') + (a.displayName || a.id);
          const right = document.createElement('span');
          right.className = 'font-body-sm text-body-sm font-medium text-on-surface';
          right.textContent = a.sentToday + '/' + a.share;
          row.append(left, right);
          perBox.appendChild(row);
        }
      } else if (list.length === 1) {
        const hint = document.createElement('p');
        hint.className = 'font-body-sm text-body-sm text-on-surface-variant';
        hint.textContent = 'Add a second number on the Connection page to split the load (e.g. 70/day → 35 + 35).';
        perBox.appendChild(hint);
      }
    }
    const cfg = stats.config || {};
    if (document.activeElement && configForm.contains(document.activeElement)) return;
    if (cfg.dailyCap !== undefined) configForm.elements.dailyCap.value = cfg.dailyCap;
    if (cfg.maxPerHour !== undefined) configForm.elements.maxPerHour.value = cfg.maxPerHour;
    if (cfg.startHour !== undefined) configForm.elements.startHour.value = cfg.startHour;
    if (cfg.endHour !== undefined) configForm.elements.endHour.value = cfg.endHour;
    if (cfg.minGapMinutes !== undefined) configForm.elements.minGapMinutes.value = cfg.minGapMinutes;
    renderTemplates(cfg);
  }

  const templateForm = document.querySelector('[data-form="templates"]');
  const templateList = document.querySelector('[data-bind="template-list"]');

  function renderTemplates(cfg) {
    if (!templateList || !templateForm) return;
    if (templateList.dataset.filled === '1' && document.activeElement && templateForm.contains(document.activeElement)) return;
    templateList.dataset.filled = '1';
    templateList.textContent = '';
    const templates = (cfg && Array.isArray(cfg.templates) ? cfg.templates : []).slice(0, 20);
    const rows = templates.length ? templates : [''];
    rows.forEach(function (t, i) {
      const row = document.createElement('div');
      row.className = 'flex items-start gap-2';
      const area = document.createElement('textarea');
      area.rows = 2;
      area.maxLength = 2000;
      area.value = t;
      area.placeholder = 'Variant ' + (i + 1) + ' — e.g. {hi|hello} {{name}}, quick question…';
      area.className = 'focusable min-w-0 flex-1 rounded-lg border border-outline-variant/40 bg-surface p-2.5 font-body-sm text-body-sm text-on-surface';
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'focusable shrink-0 rounded-lg bg-surface-container px-3 py-2 text-body-sm';
      del.textContent = '✕';
      del.title = 'Remove variant';
      del.addEventListener('click', function () { row.remove(); });
      row.append(area, del);
      templateList.appendChild(row);
    });
  }

  async function refresh() {
    try {
      const stats = await App.api('/outbound/stats');
      renderStats(stats.stats);
      const status = filter.value || 'all';
      const data = await App.api('/outbound/leads?status=' + encodeURIComponent(status) + '&limit=50');
      renderLeads(data.leads);
      try {
        const followups = await App.api('/outbound/leads?status=needsFollowup&limit=200');
        document.querySelector('[data-bind="stat-followup"]').textContent = followups.leads.length;
      } catch {
        // ignore
      }
    } catch (err) {
      App.toast(err.message, 'error');
    }
  }

  importForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const btn = importForm.querySelector('button[type="submit"]');
    App.withBusy(btn, async () => {
      const rawText = importForm.elements.rawText.value;
      const defaultMessage = importForm.elements.defaultMessage.value;
      const data = await App.api('/outbound/import', { method: 'POST', body: { rawText, defaultMessage } });
      App.toast('Imported ' + data.imported + ', skipped ' + data.skipped + ', ' + data.duplicates + ' duplicates');
      importForm.elements.rawText.value = '';
      await refresh();
    }).catch((err) => App.toast(err.message, 'error'));
  });

  function numOrUndefined(value) {
    if (value === '' || value === null || value === undefined) return undefined;
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n) : undefined;
  }

  configForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const btn = configForm.querySelector('button[type="submit"]');
    App.withBusy(btn, async () => {
      const body = {};
      const dc = numOrUndefined(configForm.elements.dailyCap.value);
      const mh = numOrUndefined(configForm.elements.maxPerHour.value);
      const sh = numOrUndefined(configForm.elements.startHour.value);
      const eh = numOrUndefined(configForm.elements.endHour.value);
      const mg = numOrUndefined(configForm.elements.minGapMinutes.value);
      if (dc !== undefined) body.dailyCap = dc;
      if (mh !== undefined) body.maxPerHour = mh;
      if (sh !== undefined) body.startHour = sh;
      if (eh !== undefined) body.endHour = eh;
      if (mg !== undefined) body.minGapMinutes = mg;
      await App.api('/outbound/config', { method: 'POST', body });
      App.toast('Pacing saved');
      await refresh();
    }).catch((err) => App.toast(err.message, 'error'));
  });

  if (templateForm) {
    const addBtn = templateForm.querySelector('[data-action="add-template"]');
    if (addBtn) {
      addBtn.addEventListener('click', function () {
        if (templateList.children.length >= 20) {
          App.toast('Up to 20 variants.', 'error');
          return;
        }
        const row = document.createElement('div');
        row.className = 'flex items-start gap-2';
        const area = document.createElement('textarea');
        area.rows = 2;
        area.maxLength = 2000;
        area.placeholder = 'Variant ' + (templateList.children.length + 1) + ' — e.g. {hi|hello} {{name}}, quick question…';
        area.className = 'focusable min-w-0 flex-1 rounded-lg border border-outline-variant/40 bg-surface p-2.5 font-body-sm text-body-sm text-on-surface';
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'focusable shrink-0 rounded-lg bg-surface-container px-3 py-2 text-body-sm';
        del.textContent = '✕';
        del.addEventListener('click', function () { row.remove(); });
        row.append(area, del);
        templateList.appendChild(row);
        area.focus();
      });
    }
    templateForm.addEventListener('submit', function (e) {
      e.preventDefault();
      const btn = templateForm.querySelector('button[type="submit"]');
      App.withBusy(btn, async function () {
        const templates = Array.from(templateList.querySelectorAll('textarea')).map(function (t) { return t.value.trim(); }).filter(Boolean);
        await App.api('/outbound/config', { method: 'POST', body: { templates } });
        App.toast(templates.length ? templates.length + ' variant(s) saved' : 'Variants cleared');
        await refresh();
      }).catch(function (err) { App.toast(err.message, 'error'); });
    });
  }

  toggle.addEventListener('click', () => {
    App.withBusy(toggle, async () => {
      await App.api(enabled ? '/outbound/pause' : '/outbound/start', { method: 'POST', body: {} });
      await refresh();
    }).catch((err) => App.toast(err.message, 'error'));
  });

  filter.addEventListener('change', refresh);
  search.addEventListener('input', () => renderLeads(cachedLeads));

  refresh();
  App.poll(refresh, 10000);
})();
