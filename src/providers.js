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
      defaultModel: env('GEMINI_MODEL', 'gemini-2.5-flash'),
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
    const err = new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return JSON.parse(text);
}

async function callGemini({ model, system, user, temperature, timeoutMs }) {
  const key = env('GEMINI_API_KEY');
  if (!key) throw new Error('GEMINI_API_KEY が設定されていません');
  const m = model || env('GEMINI_MODEL', 'gemini-2.5-flash');
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

/** LLM を呼んでテキストを返す。 */
export async function complete(provider, opts) {
  const o = { temperature: 0.9, timeoutMs: 45000, ...opts };
  if (provider === 'gemini') return callGemini(o);
  if (OPENAI_COMPATIBLE[provider]) return callOpenAICompatible(provider, o);
  throw new Error(`未対応のプロバイダ: ${provider}`);
}
