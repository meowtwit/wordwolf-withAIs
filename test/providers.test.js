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
