'use strict';

(function () {
  const textarea = document.getElementById('ai-instructions');
  const charCount = document.querySelector('[data-bind="char-count"]');
  const charLimit = document.querySelector('[data-bind="char-limit"]');
  const saveButton = document.querySelector('[data-action="save-instructions"]');
  const saveIcon = document.querySelector('[data-bind="save-icon"] use');
  const testButton = document.querySelector('[data-action="test-instructions"]');
  const testIcon = document.querySelector('[data-bind="test-icon"]');
  const testPanel = document.querySelector('[data-bind="test-panel"]');
  const testInput = document.querySelector('[data-bind="test-input"]');
  const testReply = document.querySelector('[data-bind="test-reply"]');
  const exampleButton = document.querySelector('[data-action="load-example"]');

  const TEMPLATE = [
    'You are the WhatsApp assistant for <business name>, a <what the business does> in <city>.',
    '',
    'What we offer',
    '- <service or product 1> - <price or "ask for a quote">',
    '- <service or product 2>',
    '',
    'Practical details',
    '- Opening hours: <hours>',
    '- Location: <address>',
    '- Delivery / booking: <how it works>',
    '',
    'How to handle customers',
    '- Answer questions about the list above. Anything else, say you will check with the team.',
    '- Never promise a discount, refund, or a delivery date that is not written here.',
    '- To book or order, collect <name, date, quantity> and say a colleague will confirm shortly.',
    '- If someone is unhappy or asks for a human, apologise briefly and say a colleague will reply here soon.',
    '',
    'Tone',
    '- Friendly and brief. Anything else specific to how you talk to customers.',
    '- (Lowercase, short texting style and the reply timing are already handled.)',
  ].join('\n');

  let savedValue = '';
  let limit = 20000;

  function updateCount() {
    charCount.textContent = textarea.value.length;
    charCount.classList.toggle('text-error', textarea.value.length > limit);
  }

  function markDirty() {
    const dirty = textarea.value !== savedValue;
    saveIcon.setAttribute('href', dirty ? '#i-save' : '#i-check');
    saveButton.classList.toggle('opacity-60', !dirty);
  }

  textarea.addEventListener('input', function () {
    updateCount();
    markDirty();
  });

  async function load() {
    const data = await App.api('/state');
    App.renderShell(data.state, data.user);
    limit = data.state.instructions.limit;
    charLimit.textContent = limit;

    // Never clobber unsaved edits while the operator is typing.
    if (document.activeElement !== textarea && textarea.value === savedValue) {
      textarea.value = data.state.instructions.text;
      savedValue = textarea.value;
    }
    updateCount();
    markDirty();
  }

  saveButton.addEventListener('click', function () {
    App.withBusy(saveButton, async function () {
      if (textarea.value.length > limit) {
        App.toast('Instructions are too long. Trim them to ' + limit + ' characters.', 'error');
        return;
      }
      saveIcon.setAttribute('href', '#i-sync');
      try {
        await App.api('/instructions', { method: 'POST', body: { instructions: textarea.value } });
        savedValue = textarea.value;
        App.toast('Instructions saved');
      } catch (err) {
        App.toast(err.message, 'error');
      } finally {
        markDirty();
      }
    });
  });

  testButton.addEventListener('click', function () {
    App.withBusy(testButton, async function () {
      testPanel.hidden = false;
      testIcon.classList.add('animate-spin');
      testReply.textContent = 'Thinking…';
      try {
        const body = {};
        const message = testInput.value.trim();
        if (message) body.message = message;
        const data = await App.api('/instructions/test', { method: 'POST', body: body });
        testReply.textContent = data.reply;
        if (!testInput.value.trim()) testInput.value = data.message;
      } catch (err) {
        testReply.textContent = err.message;
        App.toast(err.message, 'error');
      } finally {
        testIcon.classList.remove('animate-spin');
      }
    });
  });

  exampleButton.addEventListener('click', function () {
    if (textarea.value.trim() && !window.confirm('Replace the current instructions with the template?')) return;
    textarea.value = TEMPLATE;
    textarea.focus();
    updateCount();
    markDirty();
  });

  // poll() runs immediately, so this covers the initial load too.
  App.poll(load, 15000);
})();
