'use strict';

(function () {
  const apiKeyForm = document.querySelector('[data-form="api-key"]');
  const apiKeyInput = apiKeyForm.querySelector('input[name="apiKey"]');
  const apiKeyText = document.querySelector('[data-bind="api-key-text"]');
  const apiKeyDot = document.querySelector('[data-bind="api-key-dot"]');
  const apiKeyPing = document.querySelector('[data-bind="api-key-ping"]');
  const removeKeyButton = document.querySelector('[data-action="remove-key"]');

  const modelForm = document.querySelector('[data-form="model"]');
  const modelInput = modelForm.querySelector('input[name="model"]');
  const modelText = document.querySelector('[data-bind="model-text"]');
  const modelDot = document.querySelector('[data-bind="model-dot"]');
  const testButton = document.querySelector('[data-action="test-model"]');
  const testIcon = document.querySelector('[data-bind="test-icon"]');

  const followupForm = document.querySelector('[data-form="followups"]');
  const pausedToggle = document.querySelector('[data-action="toggle-paused"]');
  const pausedLabel = document.querySelector('[data-bind="paused-label"]');

  let modelDirty = false;
  let latestState = null;

  modelInput.addEventListener('input', function () {
    modelDirty = true;
  });

  function renderKey(state) {
    const set = state.openrouter.apiKeySet;
    apiKeyText.textContent = set ? 'API key saved (' + state.openrouter.apiKeyHint + ')' : 'No API key saved';
    App.setDot(apiKeyDot, set ? 'connected' : 'disconnected');
    App.setDot(apiKeyPing, set ? 'connected' : 'disconnected');
    apiKeyPing.classList.toggle('animate-ping', set);
    removeKeyButton.hidden = !set;
    apiKeyInput.placeholder = set ? 'Paste a new key to replace it' : 'sk-or-v1-…';
  }

  function renderFollowups(followups) {
    if (document.activeElement && followupForm.contains(document.activeElement)) return;
    followupForm.elements.enabled.checked = followups.enabled;
    followupForm.elements.maxFollowups.value = followups.maxFollowups;
    followupForm.elements.delaysMinutes.value = followups.delaysMinutes.join(', ');
    followupForm.elements.quietEnabled.checked = followups.quietHours.enabled;
    followupForm.elements.quietStart.value = followups.quietHours.start;
    followupForm.elements.quietEnd.value = followups.quietHours.end;
  }

  const EVENT_LABELS = {
    'auth.login': 'Signed in to the dashboard',
    'wa.connected': 'WhatsApp connected',
    'wa.disconnected': 'WhatsApp disconnected',
    'wa.logged_out': 'WhatsApp session ended',
    'wa.logout': 'Device unlinked',
    'agent.replied': 'Replied to a customer',
    'handoff.taken_over': 'You took over a chat',
    'handoff.reply_withheld': 'Held back a reply, you answered first',
    'agent.reply_failed': 'Reply failed',
    'agent.paused': 'Message ignored while paused',
    'agent.not_configured': 'Message ignored, setup incomplete',
    'agent.stale_message': 'Skipped an old message',
    'followup.sent': 'Follow-up sent',
    'followup.skipped': 'Follow-up skipped',
    'followup.failed': 'Follow-up failed',
    'settings.api_key': 'API key updated',
    'settings.model': 'Model updated',
    'settings.instructions': 'Instructions updated',
    'settings.followups': 'Follow-up settings updated',
    'settings.paused': 'Automation switched',
    'settings.inbound_paused': 'Inbound AI switched',
    'settings.disclosure': 'AI disclosure changed',
    'optout.received': 'A customer opted out',
    'settings.test': 'Connection tested',
    'settings.test_failed': 'Connection test failed',
  };

  function eventLabel(event) {
    const base = EVENT_LABELS[event.type] || event.type;
    // Prefer the stored detail when it adds something beyond the generic label.
    if (event.message && event.message !== base) return event.message;
    return base;
  }

  function renderEvents(events) {
    const list = document.querySelector('[data-bind="event-list"]');
    list.textContent = '';
    if (!events.length) {
      const li = document.createElement('li');
      li.className = 'font-body-sm text-body-sm text-on-surface-variant';
      li.textContent = 'Nothing yet.';
      list.appendChild(li);
      return;
    }
    events.slice(0, 5).forEach(function (event) {
      const li = document.createElement('li');
      li.className = 'flex items-start justify-between gap-3 font-body-sm text-body-sm';
      const label = document.createElement('span');
      label.className = event.level === 'error' ? 'text-error' : 'text-on-surface';
      label.textContent = eventLabel(event);
      const time = document.createElement('span');
      time.className = 'shrink-0 text-on-surface-variant/70';
      time.textContent = App.timeAgo(event.created_at);
      li.appendChild(label);
      li.appendChild(time);
      list.appendChild(li);
    });
  }

  function render(state) {
    latestState = state;
    App.renderShell(state, state.user);
    renderKey(state);

    if (!modelDirty && document.activeElement !== modelInput) {
      modelInput.value = state.openrouter.model || '';
    }

    renderFollowups(state.followups);

    if (document.activeElement !== pausedToggle) {
      pausedToggle.checked = state.automation.paused;
    }
    pausedLabel.textContent = state.automation.paused ? 'Automation paused' : 'Automation active';

    document.querySelector('[data-bind="status-whatsapp"]').textContent =
      App.STATE_LABELS[state.whatsapp.state] || 'Unknown';
    document.querySelector('[data-bind="status-automation"]').textContent = state.automation.paused
      ? 'Paused'
      : state.automation.configured
      ? 'Active'
      : 'Setup incomplete';
    document.querySelector('[data-bind="status-retention"]').textContent = state.retentionDays + ' days';

    const handedOver = state.automation.handedOver || 0;
    document.querySelector('[data-bind="status-handoff"]').textContent =
      handedOver === 0 ? 'None yet' : handedOver === 1 ? '1 chat' : handedOver + ' chats';

    const optedOut = state.automation.optedOut || 0;
    document.querySelector('[data-bind="status-optout"]').textContent =
      optedOut === 0 ? 'None' : optedOut === 1 ? '1 customer' : optedOut + ' customers';

    renderEvents(state.events || []);
  }

  async function refresh() {
    const data = await App.api('/state');
    render(data.state);
  }

  /* --------------------------------- forms -------------------------------- */

  apiKeyForm.addEventListener('submit', function (event) {
    event.preventDefault();
    const button = apiKeyForm.querySelector('button[type="submit"]');
    App.withBusy(button, async function () {
      const value = apiKeyInput.value.trim();
      if (!value) {
        App.toast('Paste your OpenRouter API key first.', 'error');
        return;
      }
      try {
        await App.api('/settings/api-key', { method: 'POST', body: { apiKey: value } });
        apiKeyInput.value = '';
        App.toast('API key saved');
        await refresh();
      } catch (err) {
        App.toast(err.message, 'error');
      }
    });
  });

  removeKeyButton.addEventListener('click', function () {
    if (!window.confirm('Remove the stored OpenRouter key? The assistant will stop replying.')) return;
    App.withBusy(removeKeyButton, async function () {
      try {
        await App.api('/settings/api-key', { method: 'DELETE' });
        App.toast('API key removed');
        await refresh();
      } catch (err) {
        App.toast(err.message, 'error');
      }
    });
  });

  modelForm.addEventListener('submit', function (event) {
    event.preventDefault();
    const button = modelForm.querySelector('button[type="submit"]');
    App.withBusy(button, async function () {
      try {
        await App.api('/settings/model', { method: 'POST', body: { model: modelInput.value.trim() } });
        modelDirty = false;
        App.toast('Model saved');
        await refresh();
      } catch (err) {
        App.toast(err.message, 'error');
      }
    });
  });

  testButton.addEventListener('click', function () {
    App.withBusy(testButton, async function () {
      testIcon.classList.add('animate-spin');
      modelText.textContent = 'Testing…';
      App.setDot(modelDot, 'connecting');
      try {
        const data = await App.api('/settings/test', { method: 'POST', body: { model: modelInput.value.trim() } });
        modelText.textContent = 'Connection working (' + data.model + ')';
        App.setDot(modelDot, 'connected');
        App.toast('Model connection working');
      } catch (err) {
        modelText.textContent = err.message;
        App.setDot(modelDot, 'disconnected');
        App.toast(err.message, 'error');
      } finally {
        testIcon.classList.remove('animate-spin');
      }
    });
  });

  followupForm.addEventListener('submit', function (event) {
    event.preventDefault();
    const button = followupForm.querySelector('button[type="submit"]');
    App.withBusy(button, async function () {
      const delays = followupForm.elements.delaysMinutes.value
        .split(/[,\s]+/)
        .map(function (part) {
          return parseInt(part, 10);
        })
        .filter(function (value) {
          return Number.isFinite(value);
        });

      if (followupForm.elements.enabled.checked && !delays.length) {
        App.toast('Enter at least one delay in minutes, for example 180, 1440.', 'error');
        return;
      }

      try {
        const data = await App.api('/settings/followups', {
          method: 'POST',
          body: {
            enabled: followupForm.elements.enabled.checked,
            maxFollowups: Number(followupForm.elements.maxFollowups.value),
            delaysMinutes: delays,
            quietHours: {
              enabled: followupForm.elements.quietEnabled.checked,
              start: followupForm.elements.quietStart.value,
              end: followupForm.elements.quietEnd.value,
            },
          },
        });
        renderFollowups(data.followups);
        App.toast('Follow-up settings saved');
      } catch (err) {
        App.toast(err.message, 'error');
      }
    });
  });

  pausedToggle.addEventListener('change', async function () {
    const paused = pausedToggle.checked;
    try {
      await App.api('/settings/paused', { method: 'POST', body: { paused: paused } });
      App.toast(paused ? 'Automation paused' : 'Automation resumed');
      await refresh();
    } catch (err) {
      pausedToggle.checked = !paused;
      App.toast(err.message, 'error');
    }
  });

  App.poll(refresh, 10000);
})();
