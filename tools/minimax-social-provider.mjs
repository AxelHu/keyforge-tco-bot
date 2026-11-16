/** Text-only MiniMax chat transport. Fixed configured subscription endpoint; no retries or tools. */
import { createHash } from 'node:crypto';
import { buildSocialPrompt, normalizeSocialText } from './keyteki-social-session.mjs';

export const MINIMAX_SOCIAL_ENDPOINT = 'https://api.minimaxi.com/anthropic/v1/messages';
export const MINIMAX_SOCIAL_MODEL = 'MiniMax-M3.1-Flash';
export const MINIMAX_SOCIAL_MODELS = Object.freeze([MINIMAX_SOCIAL_MODEL, 'MiniMax-M3.1-Flash-Preview']);
const hash = (x) => createHash('sha256').update(x).digest('hex');
const object = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const nonnegative = (x) => Number.isSafeInteger(x) && x >= 0;
const error = (code) => Object.assign(Error(code), { socialCode: code });
const MAX_REQUEST_BYTES = 32768;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REJECTIONS = new Set([
  'response-size',
  'empty-response',
  'cancelled',
  'timeout',
  'invalid-json',
  'unsafe-echo',
  'invalid-envelope',
  'model-mismatch',
  'invalid-response-id',
  'missing-usage',
  'invalid-content',
  'unexpected-tool-or-block',
  'finish-length',
  'unexpected-stop',
  'invalid-chat-text',
]);

export function buildMinimaxSocialBody(context, options = {}) {
  const model = options.model ?? MINIMAX_SOCIAL_MODEL;
  if (!MINIMAX_SOCIAL_MODELS.includes(model)) throw Error('Unsupported MiniMax social model');
  const max_tokens = options.maxOutputTokens ?? 8192;
  if (!Number.isSafeInteger(max_tokens) || max_tokens < 1024 || max_tokens > 32768)
    throw Error('Invalid MiniMax social output budget');
  return {
    model,
    max_tokens,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'max' },
    stream: false,
    ...buildSocialPrompt(context),
    // No tools, tool_choice, service_tier, tool results, image input, or network/file capabilities.
  };
}

export function minimaxSocialUsage(value) {
  if (!object(value) || !nonnegative(value.input_tokens) || !nonnegative(value.output_tokens)) return null;
  const defaults = [];
  const optional = (key) => {
    if (value[key] === undefined) {
      defaults.push(key);
      return 0;
    }
    return nonnegative(value[key]) ? value[key] : null;
  };
  const read = optional('cache_read_input_tokens'),
    write = optional('cache_creation_input_tokens');
  if (read === null || write === null) return null;
  const reasoning = value.output_tokens_details?.reasoning_tokens ?? value.reasoning_tokens;
  const input = value.input_tokens + read + write;
  const total = input + value.output_tokens;
  if (!Number.isSafeInteger(input) || !Number.isSafeInteger(total)) return null;
  return {
    freshInputTokens: value.input_tokens,
    cacheReadInputTokens: read,
    cacheWriteInputTokens: write,
    inputTokens: input,
    outputTokens: value.output_tokens,
    totalTokens: total,
    reasoningTokens: nonnegative(reasoning) ? reasoning : null,
    defaultedUsageFields: defaults,
  };
}

function containsSecret(value, key, depth = 0) {
  if (depth > 12) return false;
  if (typeof value === 'string') {
    if (value.includes(key)) return true;
    const decoded = value.replace(/\\u([\da-f]{4})/gi, (_, x) => String.fromCharCode(parseInt(x, 16)));
    if (decoded.includes(key)) return true;
    if (decoded !== value && containsSecret(decoded, key, depth + 1)) return true;
    try {
      const parsed = JSON.parse(value);
      return parsed !== value && containsSecret(parsed, key, depth + 1);
    } catch {
      return false;
    }
  }
  if (Array.isArray(value)) return value.some((v) => containsSecret(v, key, depth + 1));
  if (object(value))
    return Object.entries(value).some(
      ([k, v]) => containsSecret(k, key, depth + 1) || containsSecret(v, key, depth + 1),
    );
  return false;
}

async function readResponse(response, signal) {
  if (Number(response.headers.get('content-length') ?? 0) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw error('response-size');
  }
  const reader = response.body?.getReader();
  if (!reader) throw error('empty-response');
  let bytes = 0;
  const chunks = [];
  try {
    for (;;) {
      if (signal.aborted) throw error('cancelled');
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw error('response-size');
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** apiKey stays in this closure/header, never in context, return values, diagnostics, or errors. */
export function createMinimaxSocialProvider(options) {
  if (typeof options?.apiKey !== 'string' || !/^sk-cp[^\s]{8,}$/.test(options.apiKey))
    throw Error('Configured MiniMax subscription key required');
  const apiKey = options.apiKey;
  const model = options.model ?? MINIMAX_SOCIAL_MODEL;
  if (!MINIMAX_SOCIAL_MODELS.includes(model)) throw Error('Unsupported MiniMax social model');
  const timeoutMs = options.timeoutMs ?? 60000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
    throw Error('Invalid MiniMax social deadline');
  const fetcher = options.fetcher ?? fetch;

  async function generate(context, { signal } = {}) {
    const started = Date.now();
    const receipt = {
      schema: 1,
      provider: 'minimax',
      component: 'game-social',
      model,
      effort: 'max',
      thinking: 'adaptive',
      tools: false,
      paidAttempt: false,
      accepted: false,
    };
    const finish = (reason, text) => {
      receipt.elapsedMs = Date.now() - started;
      receipt.accepted = reason === null;
      if (reason !== null) receipt.reason = reason;
      try {
        options.onReceipt?.(structuredClone(receipt));
      } catch {
        receipt.receiptSinkFailed = true;
      }
      return { ok: receipt.accepted, ...(receipt.accepted ? { text } : {}), receipt };
    };
    if (signal?.aborted) return finish('cancelled');
    let body;
    try {
      body = JSON.stringify(
        buildMinimaxSocialBody(context, { model, maxOutputTokens: options.maxOutputTokens }),
      );
    } catch {
      return finish('invalid-context');
    }
    receipt.requestBytes = Buffer.byteLength(body);
    receipt.requestSha256 = hash(body);
    if (receipt.requestBytes > MAX_REQUEST_BYTES) return finish('request-size');
    const outputLimit = JSON.parse(body).max_tokens;
    // A conservative admission bound, not an invoice or an estimate of actual reasoning usage.
    try {
      if (
        options.reserve &&
        !(await options.reserve({
          model,
          effort: 'max',
          requestSha256: receipt.requestSha256,
          maxOutputTokens: outputLimit,
          inputBytes: receipt.requestBytes,
        }))
      )
        return finish('budget');
    } catch {
      return finish('budget');
    }
    if (signal?.aborted) return finish('cancelled');
    const controller = new AbortController();
    let timedOut = false;
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    let abortListener;
    const aborted = new Promise((_, reject) => {
      abortListener = () => reject(error(timedOut ? 'timeout' : 'cancelled'));
      controller.signal.addEventListener('abort', abortListener, { once: true });
    });
    try {
      receipt.paidAttempt = true;
      const work = (async () => {
        const response = await fetcher(MINIMAX_SOCIAL_ENDPOINT, {
          method: 'POST',
          redirect: 'error',
          signal: controller.signal,
          headers: {
            Authorization: 'Bearer ' + apiKey,
            'Content-Type': 'application/json',
            'anthropic-version': '2023-06-01',
          },
          body,
        });
        if (controller.signal.aborted) throw error('cancelled');
        if (!response.ok) {
          await response.body?.cancel();
          throw error('http-' + response.status);
        }
        const raw = await readResponse(response, controller.signal);
        if (controller.signal.aborted) throw error('cancelled');
        receipt.responseBytes = Buffer.byteLength(raw);
        receipt.responseSha256 = hash(raw);
        let data;
        try {
          data = JSON.parse(raw);
        } catch {
          throw error('invalid-json');
        }
        if (containsSecret(data, apiKey)) throw error('unsafe-echo');
        if (
          !object(data) ||
          data.type !== 'message' ||
          data.role !== 'assistant' ||
          !Array.isArray(data.content)
        )
          throw error('invalid-envelope');
        // Safe diagnostics must survive a rejected alias/model echo. This never accepts a
        // different model and never records arbitrary provider content or raw reasoning.
        if (typeof data.model === 'string' && /^[A-Za-z0-9_.:/-]{1,160}$/.test(data.model))
          receipt.responseModel = data.model;
        receipt.stopReason = ['end_turn', 'max_tokens', 'tool_use', 'pause_turn'].includes(data.stop_reason)
          ? data.stop_reason
          : null;
        receipt.usage = minimaxSocialUsage(data.usage);
        if (
          typeof data.id !== 'string' ||
          !data.id ||
          data.id.length > 160 ||
          /[\u0000-\u001f\u007f]/.test(data.id)
        )
          throw error('invalid-response-id');
        receipt.responseId = data.id;
        if (data.model !== model) throw error('model-mismatch');
        if (!receipt.usage) throw error('missing-usage');
        const textBlocks = [],
          thinking = [];
        for (const block of data.content) {
          if (!object(block)) throw error('invalid-content');
          if (block.type === 'thinking' && typeof block.thinking === 'string')
            thinking.push({ bytes: Buffer.byteLength(block.thinking), sha256: hash(block.thinking) });
          else if (block.type === 'text' && typeof block.text === 'string') textBlocks.push(block.text);
          else throw error('unexpected-tool-or-block');
        }
        receipt.thinkingBlocks = thinking;
        if (data.stop_reason !== 'end_turn')
          throw error(data.stop_reason === 'max_tokens' ? 'finish-length' : 'unexpected-stop');
        const final = normalizeSocialText(textBlocks.join(''), 240);
        if (final === null) throw error('invalid-chat-text');
        receipt.finalBytes = Buffer.byteLength(final);
        return final;
      })();
      const text = await Promise.race([work, aborted]);
      return finish(null, text);
    } catch (e) {
      return finish(
        timedOut
          ? 'timeout'
          : controller.signal.aborted
            ? 'cancelled'
            : REJECTIONS.has(e?.socialCode) || /^http-\d{3}$/.test(e?.socialCode ?? '')
              ? e.socialCode
              : 'transport',
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      controller.signal.removeEventListener('abort', abortListener);
    }
  }

  return Object.freeze({ model, effort: 'max', endpoint: MINIMAX_SOCIAL_ENDPOINT, generate });
}
