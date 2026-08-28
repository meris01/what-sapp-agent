'use strict';

(function () {
  const memberList = document.querySelector('[data-bind="member-list"]');
  const inviteList = document.querySelector('[data-bind="invite-list"]');
  const inviteResult = document.querySelector('[data-bind="invite-result"]');
  const inviteLink = document.querySelector('[data-bind="invite-link"]');
  const inviteCard = document.querySelector('[data-bind="invite-card"]');
  const passwordForm = document.querySelector('[data-form="password"]');

  let you = null;

  function memberRow(member) {
    const li = document.createElement('li');
    li.className = 'flex items-center justify-between gap-4 py-3';

    const left = document.createElement('div');
    left.className = 'flex min-w-0 flex-col';

    const name = document.createElement('span');
    name.className = 'truncate text-body-sm font-medium text-on-surface';
    name.textContent = member.username + (you && member.username === you.username ? ' (you)' : '');

    const meta = document.createElement('span');
    meta.className = 'text-[12px] text-on-surface-variant';
    meta.textContent =
      (member.role === 'owner' ? 'Owner' : 'Member') +
      ' · ' +
      (member.lastLoginAt ? 'last signed in ' + App.timeAgo(member.lastLoginAt) : 'never signed in');

    left.appendChild(name);
    left.appendChild(meta);
    li.appendChild(left);

    if (you && you.role === 'owner' && member.username !== you.username) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className =
        'focusable shrink-0 rounded-lg px-3 py-1.5 text-body-sm text-error transition-colors hover:bg-error-container';
      remove.textContent = 'Remove';
      remove.addEventListener('click', function () {
        if (!window.confirm('Remove ' + member.username + '? They will be signed out everywhere.')) return;
        App.withBusy(remove, async function () {
          try {
            await App.api('/team/' + member.id, { method: 'DELETE' });
            App.toast(member.username + ' removed');
            await refresh();
          } catch (err) {
            App.toast(err.message, 'error');
          }
        });
      });
      li.appendChild(remove);
    }

    return li;
  }

  function renderInvites(invites) {
    inviteList.textContent = '';
    if (!invites.length) {
      const li = document.createElement('li');
      li.className = 'font-body-sm text-body-sm text-on-surface-variant';
      li.textContent = 'None outstanding.';
      inviteList.appendChild(li);
      return;
    }
    invites.forEach(function (invite) {
      const li = document.createElement('li');
      li.className = 'flex items-center justify-between gap-3 font-body-sm text-body-sm';

      const label = document.createElement('span');
      label.className = 'text-on-surface';
      label.textContent = invite.role === 'owner' ? 'Owner invite' : 'Member invite';

      const when = document.createElement('span');
      when.className = 'shrink-0 text-on-surface-variant/70';
      when.textContent = 'created ' + App.timeAgo(invite.createdAt);

      li.appendChild(label);
      li.appendChild(when);
      inviteList.appendChild(li);
    });
  }

  async function refresh() {
    const data = await App.api('/team');
    you = data.you;

    memberList.textContent = '';
    data.members.forEach(function (member) {
      memberList.appendChild(memberRow(member));
    });

    renderInvites(data.invites);
    // Only owners manage access.
    inviteCard.hidden = you.role !== 'owner';

    const state = await App.api('/state');
    App.renderShell(state.state, state.user);
  }

  document.querySelectorAll('[data-action="invite"]').forEach(function (button) {
    button.addEventListener('click', function () {
      App.withBusy(button, async function () {
        try {
          const data = await App.api('/team/invite', {
            method: 'POST',
            body: { role: button.getAttribute('data-role') },
          });
          inviteLink.value = window.location.origin + '/signup?code=' + encodeURIComponent(data.code);
          inviteResult.hidden = false;
          inviteLink.focus();
          inviteLink.select();
          await refresh();
        } catch (err) {
          App.toast(err.message, 'error');
        }
      });
    });
  });

  document.querySelector('[data-action="copy-invite"]').addEventListener('click', function () {
    inviteLink.select();
    navigator.clipboard.writeText(inviteLink.value).then(
      function () {
        App.toast('Invite link copied');
      },
      function () {
        App.toast('Select the link and copy it manually.', 'error');
      }
    );
  });

  document.querySelector('[data-action="revoke-invites"]').addEventListener('click', function () {
    if (!window.confirm('Revoke every unused invite? Links already sent will stop working.')) return;
    App.api('/team/invites/revoke', { method: 'POST' })
      .then(function (data) {
        App.toast(data.revoked + ' invite(s) revoked');
        inviteResult.hidden = true;
        return refresh();
      })
      .catch(function (err) {
        App.toast(err.message, 'error');
      });
  });

  passwordForm.addEventListener('submit', function (event) {
    event.preventDefault();
    const button = passwordForm.querySelector('button[type="submit"]');
    App.withBusy(button, async function () {
      try {
        await App.api('/account/password', {
          method: 'POST',
          body: {
            currentPassword: passwordForm.elements.currentPassword.value,
            newPassword: passwordForm.elements.newPassword.value,
          },
        });
        passwordForm.reset();
        App.toast('Password changed');
      } catch (err) {
        App.toast(err.message, 'error');
      }
    });
  });

  App.poll(refresh, 30000);
})();
