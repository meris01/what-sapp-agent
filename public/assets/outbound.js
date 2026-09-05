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
      td.colSpan = 7;
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
      tr.append(phone, msg, st, sched, sent, reply, act);
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
    const cfg = stats.config || {};
    if (document.activeElement && configForm.contains(document.activeElement)) return;
    if (cfg.dailyCap !== undefined) configForm.elements.dailyCap.value = cfg.dailyCap;
    if (cfg.maxPerHour !== undefined) configForm.elements.maxPerHour.value = cfg.maxPerHour;
    if (cfg.startHour !== undefined) configForm.elements.startHour.value = cfg.startHour;
    if (cfg.endHour !== undefined) configForm.elements.endHour.value = cfg.endHour;
    if (cfg.minGapMinutes !== undefined) configForm.elements.minGapMinutes.value = cfg.minGapMinutes;
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

  configForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const btn = configForm.querySelector('button[type="submit"]');
    App.withBusy(btn, async () => {
      const body = {
        dailyCap: Number(configForm.elements.dailyCap.value),
        maxPerHour: Number(configForm.elements.maxPerHour.value),
        startHour: Number(configForm.elements.startHour.value),
        endHour: Number(configForm.elements.endHour.value),
        minGapMinutes: Number(configForm.elements.minGapMinutes.value),
      };
      const data = await App.api('/outbound/config', { method: 'POST', body });
      renderStats({ ...data.config, todaySent: 0, dailyCap: data.config.dailyCap, enabled: data.config.enabled, notContacted: 0, sent: 0, replied: 0, failed: 0, optedOut: 0, config: data.config });
      App.toast('Pacing saved');
      await refresh();
    }).catch((err) => App.toast(err.message, 'error'));
  });

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
