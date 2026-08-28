'use strict';

/* Shared dashboard helpers: API access, toasts, and the persistent shell. */
window.App = (function () {
  const CSRF_COOKIE = 'wa_csrf';

  function readCookie(name) {
    const match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return match ? decodeURIComponent(match[1]) : '';
  }

  async function api(path, options) {
    const opts = options || {};
    const headers = { 'X-CSRF-Token': readCookie(CSRF_COOKIE) };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

    let response;
    try {
      response = await fetch('/api' + path, {
        method: opts.method || 'GET',
        credentials: 'same-origin',
        headers: headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
    } catch (err) {
      throw new Error('Cannot reach the server. Is it still running?');
    }

    let data = null;
    try {
      data = await response.json();
    } catch (err) {
      data = null;
    }

    // Only an absent or expired session bounces to the login page; a wrong
    // password on the login form must surface inline instead.
    if (response.status === 401 && data && data.code === 'unauthenticated') {
      window.location.href = '/login';
      throw new Error('Session expired.');
    }

    if (!response.ok || !data || data.ok === false) {
      throw new Error((data && data.error) || 'Request failed (' + response.status + ').');
    }
    return data;
  }

  /* --------------------------------- toast -------------------------------- */

  let toastTimer = null;

  function toast(message, kind) {
    const el = document.getElementById('toast');
    if (!el) return;
    const text = el.querySelector('[data-bind="toast-text"]');
    const icon = el.querySelector('[data-bind="toast-icon"] use');

    text.textContent = message;
    if (icon) icon.setAttribute('href', kind === 'error' ? '#i-alert' : '#i-check-circle');
    el.classList.toggle('text-error-container', kind === 'error');

    el.hidden = false;
    requestAnimationFrame(function () {
      el.classList.remove('translate-y-8', 'opacity-0');
    });

    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.classList.add('translate-y-8', 'opacity-0');
      setTimeout(function () {
        el.hidden = true;
      }, 300);
    }, kind === 'error' ? 6000 : 3000);
  }

  /* ------------------------------- formatting ------------------------------ */

  const STATE_LABELS = {
    connected: 'Connected',
    connecting: 'Connecting…',
    qr: 'Waiting for scan',
    reconnecting: 'Reconnecting…',
    disconnected: 'Disconnected',
  };

  const STATE_DOTS = {
    connected: 'bg-secondary-fixed-dim',
    connecting: 'bg-primary-fixed-dim',
    qr: 'bg-primary-fixed-dim',
    reconnecting: 'bg-warning',
    disconnected: 'bg-error',
  };

  const DOT_CLASSES = ['bg-secondary-fixed-dim', 'bg-primary-fixed-dim', 'bg-warning', 'bg-error', 'bg-outline-variant'];

  function setDot(el, state) {
    if (!el) return;
    DOT_CLASSES.forEach(function (cls) {
      el.classList.remove(cls);
    });
    el.classList.add(STATE_DOTS[state] || 'bg-outline-variant');
  }

  function formatPhone(number) {
    if (!number) return null;
    return '+' + String(number).replace(/[^0-9]/g, '');
  }

  function timeAgo(timestamp) {
    if (!timestamp) return '';
    const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
    if (seconds < 60) return 'just now';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return minutes + (minutes === 1 ? ' minute ago' : ' minutes ago');
    const hours = Math.round(minutes / 60);
    if (hours < 24) return hours + (hours === 1 ? ' hour ago' : ' hours ago');
    const days = Math.round(hours / 24);
    return days + (days === 1 ? ' day ago' : ' days ago');
  }

  /* --------------------------------- shell -------------------------------- */

  function renderShell(state, user) {
    const wa = state.whatsapp;
    const signedInAs = document.querySelector('[data-bind="signed-in-as"]');
    if (signedInAs && user) signedInAs.textContent = 'signed in as ' + user.username;
    const dot = document.querySelector('[data-bind="header-dot"]');
    const label = document.querySelector('[data-bind="header-state"]');
    const number = document.querySelector('[data-bind="account-number"]');
    const accountState = document.querySelector('[data-bind="account-state"]');

    setDot(dot, wa.state);
    if (label) label.textContent = STATE_LABELS[wa.state] || 'Unknown';

    if (number) number.textContent = formatPhone(wa.phone) || 'Not linked';
    if (accountState) {
      accountState.textContent = state.automation.paused
        ? 'Automation paused'
        : state.automation.configured
        ? 'Assistant ready'
        : 'Setup incomplete';
    }
  }

  /* -------------------------------- polling ------------------------------- */

  function poll(fn, intervalMs) {
    let timer = null;
    let stopped = false;

    async function run() {
      if (stopped) return;
      try {
        await fn();
      } catch (err) {
        /* transient errors are surfaced by the caller when it matters */
      }
      if (!stopped) timer = setTimeout(run, intervalMs);
    }

    run();

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        clearTimeout(timer);
        stopped = true;
      } else if (stopped) {
        stopped = false;
        run();
      }
    });
  }

  /* -------------------------------- buttons ------------------------------- */

  async function withBusy(button, task) {
    if (!button) return task();
    const wasDisabled = button.disabled;
    button.disabled = true;
    try {
      return await task();
    } finally {
      button.disabled = wasDisabled;
    }
  }

  document.addEventListener('click', function (event) {
    if (!event.target.closest('[data-action="logout"]')) return;
    event.preventDefault();
    api('/logout', { method: 'POST' })
      .catch(function () {})
      .finally(function () {
        window.location.href = '/login';
      });
  });

  return {
    api: api,
    toast: toast,
    renderShell: renderShell,
    poll: poll,
    withBusy: withBusy,
    setDot: setDot,
    timeAgo: timeAgo,
    formatPhone: formatPhone,
    STATE_LABELS: STATE_LABELS,
  };
})();
