'use strict';

(function () {
  const form = document.querySelector('[data-form="login"]');
  const error = document.querySelector('[data-bind="login-error"]');
  const button = form.querySelector('button[type="submit"]');
  const username = form.elements.username;
  const password = form.elements.password;

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    error.hidden = true;

    App.withBusy(button, async function () {
      try {
        await App.api('/login', {
          method: 'POST',
          body: { username: username.value.trim(), password: password.value },
        });
        window.location.href = '/';
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
        password.value = '';
        password.focus();
      }
    });
  });
})();
