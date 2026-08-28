'use strict';

const config = require('./config');
const logger = require('./logger');

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

class LlmError extends Error {
  constructor(message, { status = null, retryable = false } = {}) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
    this.retryable = retryable;
  }
}

function describeStatus(status, body) {
  const detail =
    (body && body.error && (body.error.message || body.error.code)) ||
    (typeof body === 'string' ? body.slice(0, 200) : null);

  switch (status) {
    case 401:
      return 'OpenRouter rejected the API key (401). Check the key and save it again.';
    case 402:
      return 'OpenRouter reports insufficient credit (402). Top up your account.';
    case 403:
      return detail || 'OpenRouter denied the request (403). The key may lack access to this model.';
    case 404:
      return 'Model not found on OpenRouter (404). Check the model identifier.';
    case 429:
      return 'Rate limited by OpenRouter (429).';
    default:
      return detail ? `OpenRouter error ${status}: ${detail}` : `OpenRouter error ${status}.`;
  }
}

async function requestOnce({ apiKey, model, messages, maxTokens, temperature, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens,
        temperature,
        stream: false,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new LlmError(`The model did not respond within ${Math.round(timeoutMs / 1000)}s.`, {
        retryable: true,
      });
    }
    throw new LlmError(`Could not reach OpenRouter: ${err.message}`, { retryable: true });
  } finally {
    clearTimeout(timer);
  }

  const raw = await response.text();
  let body = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = raw;
  }

  if (!response.ok) {
    throw new LlmError(describeStatus(response.status, body), {
      status: response.status,
      retryable: RETRYABLE_STATUS.has(response.status),
    });
  }

  // OpenRouter surfaces upstream provider failures inside a 200 response.
  if (body && body.error) {
    throw new LlmError(body.error.message || 'The model provider returned an error.', {
      retryable: false,
    });
  }

  const choice = body && Array.isArray(body.choices) ? body.choices[0] : null;
  const content = choice && choice.message ? choice.message.content : null;
  const text = Array.isArray(content)
    ? content.map((part) => (part && typeof part.text === 'string' ? part.text : '')).join('')
    : content;

  if (typeof text !== 'string' || !text.trim()) {
    throw new LlmError('The model returned an empty response.', { retryable: true });
  }

  return { text: text.trim(), model: body.model || model, usage: body.usage || null };
}

/** One chat completion, with a single retry on transient failures. */
async function chat({ apiKey, model, messages, maxTokens = 500, temperature = 0.7, timeoutMs }) {
  if (!apiKey) throw new LlmError('No OpenRouter API key is configured.');
  if (!model) throw new LlmError('No model is configured.');

  const options = {
    apiKey,
    model,
    messages,
    maxTokens,
    temperature,
    timeoutMs: timeoutMs || config.llmTimeoutMs,
  };

  try {
    return await requestOnce(options);
  } catch (err) {
    if (!(err instanceof LlmError) || !err.retryable) throw err;
    logger.warn({ err: err.message }, 'openrouter request failed, retrying once');
    await new Promise((resolve) => setTimeout(resolve, 2500));
    return requestOnce(options);
  }
}

/** Cheap round-trip used by the "Test connection" button. */
async function testConnection({ apiKey, model }) {
  const result = await chat({
    apiKey,
    model,
    messages: [
      { role: 'system', content: 'Reply with the single word: ok' },
      { role: 'user', content: 'ping' },
    ],
    maxTokens: 16,
    temperature: 0,
    timeoutMs: Math.min(config.llmTimeoutMs, 30000),
  });
  return { model: result.model };
}

module.exports = { chat, testConnection, LlmError };
