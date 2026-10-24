import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readyIn, _resetRateLimits } from '../src/providers.js';
import { complete } from '../src/providers.js';

test('1分あたりの上限に達したら、待ち時間を返し、待てない呼び出しは送らずにエラー', async () => {
  _resetRateLimits();
  process.env.OLLAMA_RPM = '2';
  process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:9/v1'; // つながらない先（送られたら接続エラーになる）
  assert.equal(readyIn('ollama'), 0);
  for (let i = 0; i < 2; i++) await assert.rejects(complete('ollama', { system: 's', user: 'u', timeoutMs: 500 }), (e) => !e.local);
  assert.ok(readyIn('ollama') > 50_000);
  await assert.rejects(complete('ollama', { system: 's', user: 'u', maxWaitMs: 1000 }), (e) => e.local && e.status === 429);
  delete process.env.OLLAMA_RPM;
  _resetRateLimits();
});

test('Bedrock: Converse API に API キーで送り、答えの文字を取り出す', async () => {
  const { createServer } = await import('node:http');
  const seen = [];
  const server = createServer(async (req, res) => {
    let b = '';
    for await (const c of req) b += c;
    const body = JSON.parse(b);
    seen.push({ url: req.url, auth: req.headers.authorization, body });
    // Claude で thinking を付けたら 400（非対応モデルのふり）→ 外してやり直すか確かめる
    if (body.additionalModelRequestFields) { res.writeHead(400); res.end('{"message":"thinking not supported"}'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ output: { message: { role: 'assistant', content: [{ text: '{"speech":"' }, { text: 'やあ"}' }] } } }));
  });
  await new Promise((r) => server.listen(0, r));
  process.env.BEDROCK_ENDPOINT = `http://127.0.0.1:${server.address().port}`;
  process.env.BEDROCK_API_KEY = 'test-bedrock-key';
  try {
    const out = await complete('bedrock', { system: 'sys', user: 'hello', model: 'global.amazon.nova-2-lite-v1:0' });
    assert.equal(out, '{"speech":"やあ"}');
    assert.equal(seen[0].url, '/model/global.amazon.nova-2-lite-v1%3A0/converse');
    assert.equal(seen[0].auth, 'Bearer test-bedrock-key');
    assert.deepEqual(seen[0].body.system, [{ text: 'sys' }]);
    assert.deepEqual(seen[0].body.messages, [{ role: 'user', content: [{ text: 'hello' }] }]);
    assert.equal(seen[0].body.additionalModelRequestFields, undefined);

    await complete('bedrock', { system: 's', user: 'u', model: 'jp.anthropic.claude-haiku-5-5' });
    assert.deepEqual(seen[1].body.additionalModelRequestFields, { thinking: { type: 'disabled' } });
    assert.equal(seen[2].body.additionalModelRequestFields, undefined, '400 のあと thinking なしでやり直す');
  } finally {
    server.close();
    delete process.env.BEDROCK_ENDPOINT;
    delete process.env.BEDROCK_API_KEY;
  }
});
