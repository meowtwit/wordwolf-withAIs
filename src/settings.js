// 展示用の設定（キャラクター・APIキー・キオスクの動き）。admin.html から変更し、data/settings.json に保存する。
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const DATA_DIR = process.env.WW_DATA_DIR || fileURLToPath(new URL('../data/', import.meta.url));
const FILE = join(DATA_DIR, 'settings.json');

export const DEFAULT_CHARACTERS = [
  {
    id: 'owl',
    name: 'ホロン',
    image: 'img/owl.webp',
    color: '#8fb6ff',
    voicePitch: 0.8,
    tagline: '物知りなフクロウの魔法使い',
    personality: '星の魔法と古い本が大好きな、物知りのフクロウ。慎重で論理的。みんなの発言の小さな矛盾をていねいに拾う。自分からは多くを語らない。',
    speech: 'ていねい語で、落ち着いた話し方。「ふむふむ」「〜ですな」が口ぐせ。',
    enabled: true,
    provider: 'gemini',
    model: '',
  },
  {
    id: 'bunny',
    name: 'ミルフィ',
    image: 'img/bunny.webp',
    color: '#ff9fc6',
    voicePitch: 1.45,
    tagline: '花かざりの、ほんわかウサギ',
    personality: 'お花と森のおさんぽが好きな、素直でやさしいウサギ。ちょっと天然だけど、人の気持ちや話し方の変化にはとても敏感。',
    speech: 'やわらかい話し言葉。「〜だよっ」「えへへ」「わぁ」をよく使う。',
    enabled: true,
    provider: 'gemini',
    model: '',
  },
  {
    id: 'wolf',
    name: 'ルーガ',
    image: 'img/wolf.webp',
    color: '#b9a6e8',
    voicePitch: 0.95,
    tagline: 'マントの、ニヤリ顔オオカミ',
    personality: '見た目のせいで、いつもウルフだと疑われるオオカミ。余裕たっぷりで少し皮肉屋。わざと意味深なことを言って場をかき回すが、推理はするどい。',
    speech: 'クールで少しキザな口調。「ふーん」「さあ、どうかな」「オレ」を使う。',
    enabled: true,
    provider: 'gemini',
    model: '',
  },
  {
    id: 'cat',
    name: 'ミケラ',
    image: 'img/cat.webp',
    color: '#f0b37a',
    voicePitch: 1.2,
    tagline: 'ベレー帽の、好奇心ネコ',
    personality: '絵を描くのが好きな三毛ネコの芸術家。好奇心いっぱいで、気になったことはどんどん質問する。直感で動くタイプで、ひらめきで人を疑うこともある。',
    speech: '元気でテンポのいい話し方。語尾にときどき「〜にゃ」がつく。',
    enabled: true,
    provider: 'gemini',
    model: '',
  },
];

export const DEFAULTS = {
  adminPin: '',
  kiosk: {
    allowTwo: true, // 「ふたりで あそぶ」を出すか
    aiCount: 3, // 1ゲームに出る AI の人数（有効なキャラクターからランダムに選ぶ）
    voice: true, // AI の発言を読み上げる
    mic: true, // マイクボタンを出す
    showMinds: true, // 結果画面で AI の頭の中を見せる
    idleSec: 180, // 操作がないとき「まだ遊んでいますか？」を出すまでの秒数
    resultSec: 120, // 結果画面からタイトルに戻るまでの秒数
  },
  api: {
    geminiKey: '',
    geminiModel: 'gemini-flash-lite-latest',
    geminiRpm: 12,
  },
  characters: DEFAULT_CHARACTERS,
};

const clone = (v) => JSON.parse(JSON.stringify(v));
const clampNum = (v, min, max, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : d;
};
const str = (v, max, d = '') => (typeof v === 'string' ? v.trim().slice(0, max) : d);

/** 受け取った設定を、決まった形と範囲に整える。 */
export function normalize(input, base = DEFAULTS) {
  const s = input && typeof input === 'object' ? input : {};
  const k = s.kiosk || {};
  const a = s.api || {};
  const chars = Array.isArray(s.characters) && s.characters.length ? s.characters : base.characters;
  const out = {
    adminPin: str(s.adminPin, 32, base.adminPin),
    kiosk: {
      allowTwo: typeof k.allowTwo === 'boolean' ? k.allowTwo : base.kiosk.allowTwo,
      aiCount: clampNum(k.aiCount, 2, 4, base.kiosk.aiCount),
      voice: typeof k.voice === 'boolean' ? k.voice : base.kiosk.voice,
      mic: typeof k.mic === 'boolean' ? k.mic : base.kiosk.mic,
      showMinds: typeof k.showMinds === 'boolean' ? k.showMinds : base.kiosk.showMinds,
      idleSec: clampNum(k.idleSec, 30, 3600, base.kiosk.idleSec),
      resultSec: clampNum(k.resultSec, 15, 3600, base.kiosk.resultSec),
    },
    api: {
      geminiKey: str(a.geminiKey, 200, base.api.geminiKey),
      geminiModel: str(a.geminiModel, 100, base.api.geminiModel) || DEFAULTS.api.geminiModel,
      geminiRpm: clampNum(a.geminiRpm, 0, 10000, base.api.geminiRpm),
    },
    characters: chars.slice(0, 8).map((c, i) => {
      const d = DEFAULT_CHARACTERS.find((x) => x.id === c?.id) || DEFAULT_CHARACTERS[i % DEFAULT_CHARACTERS.length];
      return {
        id: str(c?.id, 32, d.id).replace(/[^\w-]/g, '') || `c${i + 1}`,
        name: str(c?.name, 10, d.name).replace(/[\s@＠]/g, '') || d.name,
        image: str(c?.image, 200, d.image),
        color: /^#[0-9a-f]{6}$/i.test(c?.color || '') ? c.color : d.color,
        voicePitch: clampNum(c?.voicePitch, 0.5, 2, d.voicePitch),
        tagline: str(c?.tagline, 40, d.tagline),
        personality: str(c?.personality, 400, d.personality),
        speech: str(c?.speech, 200, d.speech),
        enabled: typeof c?.enabled === 'boolean' ? c.enabled : true,
        provider: str(c?.provider, 20, d.provider) || 'gemini',
        model: str(c?.model, 100, ''),
      };
    }),
  };
  return out;
}

let current = null;
const envKeyAtStart = process.env.GEMINI_API_KEY || '';

/** 設定の API キーなどを環境変数に反映する（providers.js は環境変数を読む）。 */
function applyEnv(s) {
  const key = s.api.geminiKey || envKeyAtStart;
  if (key) process.env.GEMINI_API_KEY = key;
  else delete process.env.GEMINI_API_KEY;
  process.env.GEMINI_MODEL = s.api.geminiModel;
  process.env.GEMINI_RPM = String(s.api.geminiRpm);
}

export function loadSettings() {
  let raw = {};
  if (existsSync(FILE)) {
    try {
      raw = JSON.parse(readFileSync(FILE, 'utf8'));
    } catch (e) {
      console.error(`設定ファイルを読めませんでした（初期設定で起動します）: ${e.message}`);
    }
  }
  current = normalize(raw);
  applyEnv(current);
  return current;
}

export function getSettings() {
  return current || loadSettings();
}

/** 設定を保存する。geminiKey は空なら今のキーを残す（clearKey: true で消す）。 */
export function saveSettings(patch) {
  const prev = getSettings();
  const merged = {
    ...prev,
    ...patch,
    kiosk: { ...prev.kiosk, ...(patch.kiosk || {}) },
    api: { ...prev.api, ...(patch.api || {}) },
  };
  if (!patch.api?.geminiKey) merged.api.geminiKey = prev.api.geminiKey;
  if (patch.adminPin === undefined || patch.adminPin === '****') merged.adminPin = prev.adminPin;
  if (patch.clearKey) merged.api.geminiKey = '';
  delete merged.clearKey;
  const next = normalize(merged, prev);
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  renameSync(tmp, FILE);
  current = next;
  applyEnv(current);
  return current;
}

/** 管理画面に返す形（API キーは末尾4文字だけ見せる）。 */
export function adminView(s = getSettings()) {
  const key = s.api.geminiKey;
  return {
    ...clone(s),
    api: {
      geminiModel: s.api.geminiModel,
      geminiRpm: s.api.geminiRpm,
      hasKey: Boolean(key),
      keyTail: key ? key.slice(-4) : '',
      envKey: !key && Boolean(envKeyAtStart),
    },
    adminPin: s.adminPin ? '****' : '',
    hasPin: Boolean(s.adminPin),
    defaults: DEFAULT_CHARACTERS,
  };
}

export function resetDefaults() {
  return clone(DEFAULTS);
}

export { FILE as SETTINGS_FILE };
