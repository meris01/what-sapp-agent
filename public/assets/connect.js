'use strict';

/* Connection dashboard: up to 5 linked numbers, each with its own QR card. */
(function () {
  const grid = document.querySelector('[data-bind="accounts-grid"]');
  const summary = document.querySelector('[data-bind="account-summary"]');
  const errorBox = document.querySelector('[data-bind="connection-error"]');
  const addButton = document.querySelector('[data-action="add-account"]');
  const inboundToggle = document.querySelector('[data-action="toggle-inbound"]');
  const pageTitle = document.querySelector('[data-bind="page-title"]');
  const pageSubtitle = document.querySelector('[data-bind="page-subtitle"]');

  const BADGE_TEXT = {
    connected: 'Connected',
    connecting: 'Starting…',
    qr: 'Waiting for scan…',
    reconnecting: 'Reconnecting…',
    disconnected: 'Not connected',
  };

  function setCheck(name, ok, label, element) {
    const icon = document.querySelector('[data-check="' + name + '"] use');
    if (icon) icon.setAttribute('href', ok ? '#i-check-circle' : '#i-alert');
    const iconWrap = document.querySelector('[data-check="' + name + '"]');
    if (iconWrap) {
      iconWrap.classList.toggle('text-secondary', ok);
      iconWrap.classList.toggle('text-warning', !ok);
    }
    if (element) element.textContent = label;
  }

  function dotClass(state) {
    if (state === 'connected') return 'bg-secondary-fixed-dim';
    if (state === 'qr' || state === 'connecting') return 'bg-primary-fixed-dim';
    if (state === 'reconnecting') return 'bg-warning';
    return 'bg-error';
  }

  function card(account) {
    const wrap = document.createElement('div');
    wrap.className = 'relative flex w-full flex-col rounded-[28px] bg-surface-container-lowest/80 p-6 shadow-[0_8px_40px_rgba(0,0,0,0.04),0_0_2px_rgba(0,0,0,0.06)] backdrop-blur-xl';
    wrap.dataset.account = account.id;

    const head = document.createElement('div');
    head.className = 'mb-4 flex items-center justify-between gap-3';
    const title = document.createElement('div');
    title.className = 'flex items-center gap-2.5';
    const dot = document.createElement('span');
    dot.className = 'h-2.5 w-2.5 rounded-full ' + dotClass(account.state);
    const name = document.createElement('span');
    name.className = 'font-title-md text-title-md text-on-surface';
    name.textContent = account.label || account.displayName || ('Number ' + account.slot);
    title.append(dot, name);
    const badge = document.createElement('span');
    badge.className = 'rounded-full bg-surface-container px-3 py-1 font-body-sm text-body-sm text-on-surface-variant';
    badge.textContent = BADGE_TEXT[account.state] || account.state;
    head.append(title, badge);

    const sub = document.createElement('p');
    sub.className = 'mb-4 font-body-sm text-body-sm text-on-surface-variant';
    const phone = account.phone ? '+' + account.phone : null;
    const bits = [];
    if (phone) bits.push(phone);
    if (account.connected && account.lastConnectedAt) bits.push('online ' + App.timeAgo(account.lastConnectedAt));
    if (!account.enabled) bits.push('paused for sending');
    if (account.cooldownUntil && account.cooldownUntil > Date.now()) bits.push('cooling down');
    sub.textContent = bits.join(' · ') || 'Not linked yet';

    const qrBox = document.createElement('div');
    qrBox.className = 'relative mb-4 flex h-56 w-full items-center justify-center overflow-hidden rounded-2xl bg-surface-container-highest p-4 shadow-inner';
    if (account.connected) {
      const ok = document.createElement('div');
      ok.className = 'flex flex-col items-center gap-2 px-6 text-center';
      ok.innerHTML = '<p class="font-title-md text-title-md text-on-surface">✓ Linked</p><p class="font-body-sm text-body-sm text-on-surface-variant">Watching this number for new messages.</p>';
      qrBox.appendChild(ok);
    } else if (account.qr) {
      const img = document.createElement('img');
      img.src = account.qr;
      img.alt = 'WhatsApp linking QR code for ' + (account.label || account.id);
      img.className = 'h-full w-full rounded-lg bg-surface-container-lowest object-contain';
      qrBox.appendChild(img);
    } else {
      const p = document.createElement('p');
      p.className = 'px-6 text-center font-body-sm text-body-sm text-on-surface-variant';
      p.textContent = account.state === 'disconnected' && !account.hasCredentials
        ? 'Press Refresh below to get a QR code.'
        : account.state === 'reconnecting' ? 'Reconnecting…' : 'Preparing a QR code…';
      qrBox.appendChild(p);
    }

    const labelRow = document.createElement('div');
    labelRow.className = 'mb-4 flex items-center gap-2';
    const labelInput = document.createElement('input');
    labelInput.value = account.label || '';
    labelInput.placeholder = 'Name this number (e.g. Sales 1)';
    labelInput.maxLength = 60;
    labelInput.className = 'focusable min-w-0 flex-1 rounded-lg border border-outline-variant/40 bg-surface p-2 font-body-sm text-body-sm text-on-surface';
    const saveLabel = document.createElement('button');
    saveLabel.type = 'button';
    saveLabel.className = 'focusable shrink-0 rounded-lg bg-surface-container px-3 py-2 text-body-sm text-on-surface';
    saveLabel.textContent = 'Save';
    saveLabel.addEventListener('click', function () {
      App.withBusy(saveLabel, async function () {
        await App.api('/whatsapp/accounts/' + encodeURIComponent(account.id), { method: 'PATCH', body: { label: labelInput.value.trim() || null } });
        App.toast('Number renamed.');
        await refresh();
      }).catch(function (err) { App.toast(err.message, 'error'); });
    });
    labelRow.append(labelInput, saveLabel);

    const actions = document.createElement('div');
    actions.className = 'flex flex-wrap items-center gap-2';
    const refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.className = 'focusable rounded-lg bg-surface-container px-4 py-2.5 text-body-sm text-on-surface hover:bg-surface-container-high';
    refreshBtn.textContent = account.connected ? 'Restart' : 'Refresh QR';
    refreshBtn.addEventListener('click', function () {
      App.withBusy(refreshBtn, async function () {
        await App.api('/whatsapp/accounts/' + encodeURIComponent(account.id) + '/connect', { method: 'POST', body: {} });
        App.toast('Contacting WhatsApp…');
        await refresh();
      }).catch(function (err) { App.toast(err.message, 'error'); });
    });
    actions.appendChild(refreshBtn);
    if (account.connected || account.hasCredentials) {
      const unlink = document.createElement('button');
      unlink.type = 'button';
      unlink.className = 'focusable rounded-lg px-4 py-2.5 text-body-sm text-error hover:bg-error-container';
      unlink.textContent = 'Unlink';
      unlink.addEventListener('click', function () {
        if (!window.confirm('Unlink ' + (account.label || account.displayName || account.id) + '? You will need to scan again.')) return;
        App.withBusy(unlink, async function () {
          await App.api('/whatsapp/accounts/' + encodeURIComponent(account.id) + '/logout', { method: 'POST', body: {} });
          App.toast('Number unlinked.');
          await refresh();
        }).catch(function (err) { App.toast(err.message, 'error'); });
      });
      actions.appendChild(unlink);
    }
    const enableWrap = document.createElement('label');
    enableWrap.className = 'ml-auto flex cursor-pointer items-center gap-2 font-body-sm text-body-sm text-on-surface-variant';
    const enableBox = document.createElement('input');
    enableBox.type = 'checkbox';
    enableBox.checked = account.enabled !== false;
    enableBox.className = 'h-4 w-4 accent-secondary';
    enableBox.title = 'Include this number in outbound rotation';
    enableBox.addEventListener('change', async function () {
      try {
        await App.api('/whatsapp/accounts/' + encodeURIComponent(account.id), { method: 'PATCH', body: { enabled: enableBox.checked } });
        App.toast(enableBox.checked ? 'Number back in rotation' : 'Number paused for outbound');
        await refresh();
      } catch (err) {
        enableBox.checked = !enableBox.checked;
        App.toast(err.message, 'error');
      }
    });
    const enableText = document.createElement('span');
    enableText.textContent = 'Outbound';
    enableWrap.append(enableBox, enableText);
    actions.appendChild(enableWrap);

    wrap.append(head, sub, qrBox, labelRow, actions);

    if (account.lastError && !account.connected) {
      const err = document.createElement('p');
      err.className = 'mt-3 rounded-xl bg-error-container px-3 py-2 font-body-sm text-body-sm text-on-error-container';
      err.textContent = account.lastError;
      wrap.appendChild(err);
    }
    return wrap;
  }

  function render(state) {
    App.renderShell(state, state.user);
    const accounts = state.accounts || state.whatsapp.accounts || [];
    const connected = accounts.filter(function (a) { return a.connected; });

    summary.textContent = connected.length + '/' + accounts.length + ' linked' + (accounts.length >= 5 ? ' (max)' : '');
    if (addButton) addButton.disabled = accounts.length >= 5;

    grid.textContent = '';
    if (!accounts.length) {
      const empty = document.createElement('div');
      empty.className = 'rounded-[28px] bg-surface-container-lowest/80 p-8 text-center shadow-sm';
      empty.textContent = 'No numbers yet.';
      grid.appendChild(empty);
    } else {
      accounts.forEach(function (a) { grid.appendChild(card(a)); });
    }

    if (pageTitle) pageTitle.textContent = connected.length ? 'WhatsApp numbers (' + connected.length + ' linked)' : 'WhatsApp numbers';
    if (pageSubtitle) pageSubtitle.textContent = 'Link up to 5 numbers. Inbound replies go out through the number that received them; outbound is split evenly across every connected number.';

    if (errorBox) errorBox.hidden = true;

    const anyConnected = connected.length > 0;
    setCheck('whatsapp', anyConnected, anyConnected ? connected.length + ' linked' : 'Not linked', document.querySelector('[data-bind="check-whatsapp"]'));

    const keyReady = state.openrouter.apiKeySet && Boolean(state.openrouter.model);
    setCheck('key', keyReady, keyReady ? state.openrouter.model : 'Add in Settings', document.querySelector('[data-bind="check-key"]'));

    const instructionsReady = state.instructions.length > 0;
    setCheck('instructions', instructionsReady, instructionsReady ? state.instructions.length + ' characters' : 'Not written yet', document.querySelector('[data-bind="check-instructions"]'));

    const live = anyConnected && state.automation.configured && !state.automation.paused && !state.automation.inboundPaused;
    if (document.activeElement !== inboundToggle) inboundToggle.checked = !state.automation.inboundPaused;
    const inboundLabel = state.automation.inboundPaused ? 'Off' : !state.automation.configured ? 'Waiting for setup' : state.automation.paused ? 'Paused' : 'On';
    setCheck('automation', live, inboundLabel, document.querySelector('[data-bind="check-automation"]'));
  }

  async function refresh() {
    const data = await App.api('/state');
    render(data.state);
  }

  if (addButton) {
    addButton.addEventListener('click', function () {
      const label = window.prompt('Name this number (optional, e.g. Sales 2):', '');
      if (label === null) return;
      App.withBusy(addButton, async function () {
        try {
          await App.api('/whatsapp/accounts', { method: 'POST', body: { label: label.trim() || null } });
          App.toast('Number slot added — scan its QR.');
          await refresh();
        } catch (err) {
          App.toast(err.message, 'error');
        }
      });
    });
  }

  inboundToggle.addEventListener('change', async function () {
    const on = inboundToggle.checked;
    try {
      await App.api('/settings/inbound-paused', { method: 'POST', body: { paused: !on } });
      App.toast(on ? 'Inbound AI replies on' : 'Inbound AI replies off — outbound keeps sending');
      await refresh();
    } catch (err) {
      inboundToggle.checked = !on;
      App.toast(err.message, 'error');
    }
  });

  App.poll(refresh, 3000);
})();
