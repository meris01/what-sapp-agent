'use strict';

(function () {
  const form = document.querySelector('[data-form="signup"]');
  const intro = document.querySelector('[data-bind="intro"]');
  const error = document.querySelector('[data-bind="signup-error"]');

  const code = new URLSearchParams(window.location.search).get('code') || '';

  function fail(message) {
    intro.textContent = 'This invite cannot be used.';
    error.textContent = message;
    error.hidden = false;
    form.hidden = true;
  }

  async function checkInvite() {
    if (!code) {
      fail('No invite code in the link. Ask an owner to send you a fresh one.');
      return;
    }
    try {
      const data = await App.api('/invite/' + encodeURIComponent(code));
      intro.textContent =
        data.role === 'owner'
          ? 'You have been invited as an owner. Pick a username and password.'
          : 'You have been invited to the team. Pick a username and password.';
      form.hidden = false;
    } catch (err) {
      fail(err.message);
    }
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    error.hidden = true;

    const button = form.querySelector('button[type="submit"]');
    App.withBusy(button, async function () {
      try {
        await App.api('/signup', {
          method: 'POST',
          body: {
            code: code,
            username: form.elements.username.value.trim(),
            password: form.elements.password.value,
          },
        });
        window.location.href = '/';
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
      }
    });
  });

  // Someone already signed in has no invite to redeem.
  App.api('/state')
    .then(function () {
      window.location.href = '/';
    })
    .catch(function () {
      checkInvite();
    });
})();
