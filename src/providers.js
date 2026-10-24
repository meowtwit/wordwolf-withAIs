// AI プロバイダ呼び出し。すべて「system + user の1往復」で JSON テキストを返す。
// 依存ライブラリなし（Node 標準 fetch のみ）。

const env = (k, d = '') => process.env[k] || d;

// OpenAI 互換 API を持つプロバイダ
const OPENAI_COMPATIBLE = {
  groq: {
    label: 'GroqCloud',
    baseUrl: () => 'https://api.groq.com/openai/v1',
    key: () => env('GROQ_API_KEY'),
    model: () => env('GROQ_MODEL', 'llama-3.3-70b-versatile'),
    jsonMode: true,
  },
  openrouter: {
    label: 'OpenRouter',
    baseUrl: () => 'https://openrouter.ai/api/v1',
    key: () => env('OPENROUTER_API_KEY'),
    model: () => env('OPENROUTER_MODEL', 'meta-llama/llama-3.3-70b-instruct:free'),
    jsonMode: false,
  },
  huggingface: {
    label: 'Hugging Face',
    baseUrl: () => 'https://router.huggingface.co/v1',
    key: () => env('HF_TOKEN'),
    model: () => env('HF_MODEL', 'meta-llama/Llama-3.1-8B-Instruct'),
    jsonMode: false,
  },
  cerebras: {
    label: 'Cerebras',
    baseUrl: () => 'https://api.cerebras.ai/v1',
    key: () => env('CEREBRAS_API_KEY'),
    model: () => env('CEREBRAS_MODEL', 'llama3.1-8b'),
    jsonMode: true,
  },
  ollama: {
    label: 'ローカル (Ollama等)',
    baseUrl: () => env('OLLAMA_BASE_URL', 'http://localhost:11434/v1'),
    key: () => 'ollama',
    model: () => env('OLLAMA_MODEL', 'qwen2.5:7b'),
    jsonMode: true,
    keyless: true,
  },
};

export function listProviders() {
  const list = [
    { id: 'mock', label: 'オフライン (APIなし)', available: true, defaultModel: 'rule-based' },
    {
      id: 'gemini',
      label: 'Google Gemini',
      available: Boolean(env('GEMINI_API_KEY')),
      defaultModel: env('GEMINI_MODEL', 'gemini-flash-lite-latest'),
    },
    {
      id: 'bedrock',
      label: 'Amazon Bedrock (AWS)',
      available: Boolean(bedrockKey()),
      defaultModel: env('BEDROCK_MODEL', BEDROCK_DEFAULT_MODEL),
    },
  ];
  for (const [id, p] of Object.entries(OPENAI_COMPATIBLE)) {
    list.push({
      id,
      label: p.label,
      // ローカルは起動しているか分からないので常に選択可能にする
      available: p.keyless || Boolean(p.key()),
      defaultModel: p.model(),
    });
  }
  return list;
}

async function postJson(url, headers, body, timeoutMs) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}: ${text.slice(0, 1500)}`);
    err.status = res.status;
    throw err;
  }
  return JSON.parse(text);
}

async function callGemini({ model, system, user, temperature, timeoutMs }) {
  const key = env('GEMINI_API_KEY');
  if (!key) throw new Error('GEMINI_API_KEY が設定されていません');
  const m = model || env('GEMINI_MODEL', 'gemini-flash-lite-latest');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent`;
  const data = await postJson(
    url,
    { 'x-goog-api-key': key },
    {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { temperature, responseMimeType: 'application/json' },
    },
    timeoutMs,
  );
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts.map((p) => p.text || '').join('');
}

async function callOpenAICompatible(providerId, { model, system, user, temperature, timeoutMs }) {
  const p = OPENAI_COMPATIBLE[providerId];
  const key = p.key();
  if (!key) throw new Error(`${p.label} の API キーが設定されていません`);
  const body = {
    model: model || p.model(),
    temperature,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };
  const url = `${p.baseUrl().replace(/\/$/, '')}/chat/completions`;
  const headers = { Authorization: `Bearer ${key}` };
  let data;
  try {
    data = await postJson(url, headers, p.jsonMode ? { ...body, response_format: { type: 'json_object' } } : body, timeoutMs);
  } catch (e) {
    // JSON モード非対応モデルなら素のリクエストで再試行
    if (p.jsonMode && e.status === 400) data = await postJson(url, headers, body, timeoutMs);
    else throw e;
  }
  return data?.choices?.[0]?.message?.content || '';
}

// ---- Amazon Bedrock（AWS）: Bedrock の API キーで Converse API を呼ぶ ----
// 既定は Amazon 自身のモデル Nova 2 Lite（AWS のクレジットで支払える）。
// Claude などのサードパーティモデルは AWS Marketplace 経由の請求になり、クレジットが使えないことがある。
export const BEDROCK_DEFAULT_MODEL = 'global.amazon.nova-2-lite-v1:0';
const bedrockKey = () => env('BEDROCK_API_KEY') || env('AWS_BEARER_TOKEN_BEDROCK');

async function callBedrock({ model, system, user, temperature, timeoutMs }) {
  const key = bedrockKey();
  if (!key) throw new Error('Bedrock の API キーが設定されていません');
  const region = env('BEDROCK_REGION', 'ap-northeast-1');
  const m = model || env('BEDROCK_MODEL', BEDROCK_DEFAULT_MODEL);
  const base = env('BEDROCK_ENDPOINT', `https://bedrock-runtime.${region}.amazonaws.com`);
  const url = `${base.replace(/\/$/, '')}/model/${encodeURIComponent(m)}/converse`;
  const body = {
    system: [{ text: system }],
    messages: [{ role: 'user', content: [{ text: user }] }],
    inferenceConfig: { temperature, maxTokens: 1000 },
  };
  const headers = { Authorization: `Bearer ${key}` };
  let data;
  if (/anthropic\.claude/.test(m)) {
    // Claude は考えてから答える機能を切って速くする（使えないモデルなら外してやり直す）
    try {
      data = await postJson(url, headers, { ...body, additionalModelRequestFields: { thinking: { type: 'disabled' } } }, timeoutMs);
    } catch (e) {
      if (e.status !== 400) throw e;
      data = await postJson(url, headers, body, timeoutMs);
    }
  } else {
    data = await postJson(url, headers, body, timeoutMs);
  }
  const content = data?.output?.message?.content || [];
  return content.map((c) => c.text || '').join('');
}

function callOnce(provider, o) {
  if (provider === 'gemini') return callGemini(o);
  if (provider === 'bedrock') return callBedrock(o);
  if (OPENAI_COMPATIBLE[provider]) return callOpenAICompatible(provider, o);
  throw new Error(`未対応のプロバイダ: ${provider}`);
}

// ---- 1分あたりの呼び出し回数の管理 ----
// 無料枠は「1分あたり◯回」の上限が厳しいので、超えそうなら呼ぶ前に待つ。
// 429 が返ってきたら、Google が示す待ち時間（retryDelay）だけ止める。
const RPM_DEFAULT = { gemini: 12, bedrock: 0, groq: 30, openrouter: 20, huggingface: 30, cerebras: 30, ollama: 0 };
const calls = new Map(); // provider → 直近1分の呼び出し時刻
const blockedUntil = new Map();

function rpmOf(provider) {
  const raw = process.env[`${provider.toUpperCase()}_RPM`];
  const v = raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : (RPM_DEFAULT[provider] ?? 0);
}

/** あと何ミリ秒待てば呼べるか（0 なら今すぐ呼べる）。 */
export function readyIn(provider, now = Date.now()) {
  const block = Math.max(0, (blockedUntil.get(provider) || 0) - now);
  const rpm = rpmOf(provider);
  if (!rpm) return block;
  const list = (calls.get(provider) || []).filter((t) => now - t < 60_000);
  calls.set(provider, list);
  const windowWait = list.length < rpm ? 0 : 60_000 - (now - list[0]) + 50;
  return Math.max(block, windowWait);
}

async function acquire(provider, maxWaitMs) {
  for (;;) {
    const wait = readyIn(provider);
    if (wait === 0) {
      if (rpmOf(provider)) calls.get(provider).push(Date.now());
      return;
    }
    if (wait > maxWaitMs) {
      const e = new Error(`1分あたりの呼び出し上限のため ${Math.ceil(wait / 1000)} 秒待ちが必要`);
      e.status = 429;
      e.local = true;
      throw e;
    }
    await new Promise((r) => setTimeout(r, wait));
  }
}

function noteRateLimit(provider, err) {
  const m = /"retryDelay":\s*"(\d+(?:\.\d+)?)s"/.exec(err.message || '') || /retry in (\d+(?:\.\d+)?)s/i.exec(err.message || '');
  const sec = m ? Number(m[1]) : 10;
  blockedUntil.set(provider, Date.now() + Math.min(sec, 60) * 1000);
}

/**
 * LLM を呼んでテキストを返す。
 * maxWaitMs: 回数上限で待つ最大時間（超えるなら待たずにエラー）。
 * retry429: 429 が返ったとき、待ち時間が maxWaitMs 以内なら1回だけやり直す。
 */
export async function complete(provider, opts) {
  const o = { temperature: 0.9, timeoutMs: 45000, retry429: true, maxWaitMs: 60000, ...opts };
  await acquire(provider, o.maxWaitMs);
  try {
    return await callOnce(provider, o);
  } catch (e) {
    if (e.status !== 429) throw e;
    noteRateLimit(provider, e);
    if (!o.retry429) throw e;
    await acquire(provider, o.maxWaitMs);
    return callOnce(provider, o);
  }
}

/** テスト用 */
export function _resetRateLimits() {
  calls.clear();
  blockedUntil.clear();
}
