'use strict';

(function () {
  const qrImage = document.querySelector('[data-bind="qr-image"]');
  const placeholder = document.querySelector('[data-bind="qr-placeholder"]');
  const placeholderIcon = document.querySelector('[data-bind="placeholder-icon"] use');
  const placeholderText = document.querySelector('[data-bind="placeholder-text"]');
  const badgeDot = document.querySelector('[data-bind="badge-dot"]');
  const badgeText = document.querySelector('[data-bind="badge-text"]');
  const linkedPanel = document.querySelector('[data-bind="linked-panel"]');
  const linkedNumber = document.querySelector('[data-bind="linked-number"]');
  const linkedSince = document.querySelector('[data-bind="linked-since"]');
  const instructionsCard = document.querySelector('[data-bind="instructions-card"]');
  const errorBox = document.querySelector('[data-bind="connection-error"]');
  const unlinkButton = document.querySelector('[data-action="unlink"]');
  const refreshButton = document.querySelector('[data-action="refresh-qr"]');
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

  function renderHealth(state) {
    const active = state === 'connecting' ? 'qr' : state;
    document.querySelectorAll('[data-health]').forEach(function (node) {
      const isActive = node.getAttribute('data-health') === active;
      node.classList.toggle('opacity-40', !isActive);
      node.classList.toggle('opacity-100', isActive);
      node.classList.toggle('font-medium', isActive);
    });
  }

  function render(state) {
    App.renderShell(state, state.user);

    const wa = state.whatsapp;
    const connected = wa.state === 'connected';

    App.setDot(badgeDot, wa.state);
    badgeText.textContent = BADGE_TEXT[wa.state] || 'Unknown';
    renderHealth(wa.state);

    // QR / connected panels
    if (connected) {
      qrImage.hidden = true;
      qrImage.removeAttribute('src');
      placeholder.hidden = true;
      linkedPanel.hidden = false;
      instructionsCard.hidden = true;
      unlinkButton.hidden = false;
      linkedNumber.textContent = App.formatPhone(wa.phone) || 'Linked';
      linkedSince.textContent = wa.lastConnectedAt ? 'Online since ' + App.timeAgo(wa.lastConnectedAt) : '';
      pageTitle.textContent = 'WhatsApp connected';
      pageSubtitle.textContent = 'Your assistant is watching this account for new customer messages.';
    } else {
      linkedPanel.hidden = true;
      instructionsCard.hidden = false;
      unlinkButton.hidden = !wa.hasCredentials;
      pageTitle.textContent = 'Connect WhatsApp';
      pageSubtitle.textContent = 'Scan the QR code with WhatsApp on your phone to link your account.';

      if (wa.qr) {
        qrImage.src = wa.qr;
        qrImage.hidden = false;
        placeholder.hidden = true;
      } else {
        qrImage.hidden = true;
        qrImage.removeAttribute('src');
        placeholder.hidden = false;
        if (wa.state === 'reconnecting') {
          placeholderIcon.setAttribute('href', '#i-sync');
          placeholderText.textContent = 'Reconnecting to WhatsApp…';
        } else if (wa.state === 'disconnected') {
          placeholderIcon.setAttribute('href', '#i-alert');
          placeholderText.textContent = 'Not connected. Use refresh to request a new QR code.';
        } else {
          placeholderIcon.setAttribute('href', '#i-sync');
          placeholderText.textContent = 'Preparing a QR code…';
        }
      }
    }

    placeholder.querySelector('svg').classList.toggle('animate-spin', wa.state !== 'disconnected');

    if (wa.lastError && !connected) {
      errorBox.hidden = false;
      errorBox.textContent = wa.lastError;
    } else {
      errorBox.hidden = true;
    }

    // Readiness checklist
    setCheck('whatsapp', connected, connected ? 'Linked' : 'Not linked', document.querySelector('[data-bind="check-whatsapp"]'));

    const keyReady = state.openrouter.apiKeySet && Boolean(state.openrouter.model);
    setCheck(
      'key',
      keyReady,
      keyReady ? state.openrouter.model : 'Add in Settings',
      document.querySelector('[data-bind="check-key"]')
    );

    const instructionsReady = state.instructions.length > 0;
    setCheck(
      'instructions',
      instructionsReady,
      instructionsReady ? state.instructions.length + ' characters' : 'Not written yet',
      document.querySelector('[data-bind="check-instructions"]')
    );

    const live = connected && state.automation.configured && !state.automation.paused && !state.automation.inboundPaused;
    if (document.activeElement !== inboundToggle) {
      inboundToggle.checked = !state.automation.inboundPaused;
    }
    const inboundLabel = state.automation.inboundPaused
      ? 'Off'
      : !state.automation.configured
        ? 'Waiting for setup'
        : state.automation.paused
          ? 'Paused'
          : 'On';
    setCheck(
      'automation',
      live,
      inboundLabel,
      document.querySelector('[data-bind="check-automation"]')
    );
  }

  async function refresh() {
    const data = await App.api('/state');
    render(data.state);
  }

  refreshButton.addEventListener('click', function () {
    App.withBusy(refreshButton, async function () {
      try {
        const data = await App.api('/whatsapp/connect', { method: 'POST' });
        render(data.state);
        App.toast('Reconnecting to WhatsApp…');
      } catch (err) {
        App.toast(err.message, 'error');
      }
    });
  });

  unlinkButton.addEventListener('click', function () {
    if (!window.confirm('Unlink this WhatsApp account? You will need to scan a new QR code.')) return;
    App.withBusy(unlinkButton, async function () {
      try {
        const data = await App.api('/whatsapp/logout', { method: 'POST' });
        render(data.state);
        App.toast('Device unlinked.');
      } catch (err) {
        App.toast(err.message, 'error');
      }
    });
  });

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

  App.poll(refresh, 2500);
})();
