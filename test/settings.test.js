import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.WW_DATA_DIR = mkdtempSync(join(tmpdir(), 'ww-settings-'));
const { loadSettings, saveSettings, adminView, normalize, DEFAULT_CHARACTERS } = await import('../src/settings.js');

test('設定: 初期値はキャラクター4人・AI 3人', () => {
  const s = loadSettings();
  assert.deepEqual(s.characters.map((c) => c.name), ['ホロン', 'ミルフィ', 'ルーガ', 'ミケラ']);
  assert.equal(s.kiosk.aiCount, 3);
  assert.equal(DEFAULT_CHARACTERS.length, 4);
});

test('設定: 保存すると反映され、キーは管理画面に末尾4文字しか出ない', () => {
  saveSettings({ api: { geminiKey: 'AQ.secret-key-1234' }, kiosk: { aiCount: 9 } });
  const raw = JSON.parse(readFileSync(join(process.env.WW_DATA_DIR, 'settings.json'), 'utf8'));
  assert.equal(raw.api.geminiKey, 'AQ.secret-key-1234');
  assert.equal(raw.kiosk.aiCount, 4, '範囲外は丸める');
  assert.equal(process.env.GEMINI_API_KEY, 'AQ.secret-key-1234');
  const v = adminView();
  assert.ok(!JSON.stringify(v).includes('secret-key'));
  assert.equal(v.api.keyTail, '1234');
  // キー欄が空なら今のキーを残す
  saveSettings({ api: { geminiKey: '' }, kiosk: { voice: false } });
  assert.equal(loadSettings().api.geminiKey, 'AQ.secret-key-1234');
  assert.equal(loadSettings().kiosk.voice, false);
  saveSettings({ clearKey: true });
  assert.equal(loadSettings().api.geminiKey, '');
});

test('設定: PIN は「****」のまま保存しても変わらない', () => {
  saveSettings({ adminPin: '2468' });
  assert.equal(adminView().adminPin, '****');
  saveSettings({ adminPin: '****', kiosk: { aiCount: 2 } });
  assert.equal(loadSettings().adminPin, '2468');
  saveSettings({ adminPin: '' });
  assert.equal(loadSettings().adminPin, '');
});

test('設定: 名前から空白と @ を取り除き、おかしな値は初期値にする', () => {
  const s = normalize({ characters: [{ id: 'owl', name: ' ホ ロ@ン ', color: 'red', voicePitch: 99 }] });
  assert.equal(s.characters[0].name, 'ホロン');
  assert.equal(s.characters[0].color, DEFAULT_CHARACTERS[0].color);
  assert.equal(s.characters[0].voicePitch, 2);
});
