// 依存なしの Node.js サーバー。静的ファイル配信 + ゲーム API + 展示用の管理 API。
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import {
  createGame, startTalk, advance, humanSpeak, humanAsk, humanVote, humanGuess, publicState, wordFor, GameError,
} from './src/game.js';
import { listProviders, complete } from './src/providers.js';
import { loadSettings, getSettings, saveSettings, adminView, SETTINGS_FILE } from './src/settings.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
try {
  process.loadEnvFile?.(join(ROOT, '.env'));
} catch {
  // .env がなくても動く
}
loadSettings();
// Windows の stop.bat がこのウィンドウ名で止める
process.title = 'WordWolf-Server';

const PORT = Number(process.env.PORT) || 3000;
// 起動スクリプトが「このゲームのサーバーか」を確かめるための目印（古い版とポートがぶつかったときの見分け用）
const APP_ID = 'tsukiyo-wordwolf-kiosk';
// 展示用: 既定ではこの PC からしか開けない（ほかの PC から開くなら HOST=0.0.0.0）
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = join(ROOT, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

const games = new Map();
const GAME_TTL_MS = 6 * 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [id, g] of games) {
    if (now - g.createdAt > GAME_TTL_MS) games.delete(id);
  }
}, 10 * 60 * 1000).unref();

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 256 * 1024) throw new GameError('リクエストが大きすぎます', 413);
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new GameError('JSON が不正です');
  }
}

function getGame(id) {
  const g = games.get(id);
  if (!g) throw new GameError('ゲームが見つかりません。タイトルからやり直してください', 404);
  return g;
}

const providerAvailable = (id) => listProviders().find((p) => p.id === id)?.available;

/** お客さん向け画面に出してよい設定だけ。 */
function kioskConfig() {
  const s = getSettings();
  const enabled = s.characters.filter((c) => c.enabled);
  return {
    kiosk: s.kiosk,
    characters: enabled.map((c) => ({ name: c.name, image: c.image, color: c.color, tagline: c.tagline })),
    online: enabled.some((c) => providerAvailable(c.provider)),
  };
}

/** 設定から1ゲーム分の参加者を決める。AI は有効なキャラクターからランダムに選ぶ。 */
function buildGameConfig(humanCount) {
  const s = getSettings();
  const n = humanCount === 2 && s.kiosk.allowTwo ? 2 : 1;
  const pool = s.characters.filter((c) => c.enabled);
  if (pool.length < 2) throw new GameError('遊べるキャラクターが足りません（管理画面で2人以上を有効にしてください）', 503);
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  const picked = shuffled.slice(0, Math.min(s.kiosk.aiCount, pool.length));
  return {
    humans: n === 1 ? [{ name: 'あなた' }] : [{ name: '1P' }, { name: '2P' }],
    ais: picked.map((c) => ({
      name: c.name,
      persona: { personality: c.personality, speech: c.speech },
      image: c.image,
      color: c.color,
      tagline: c.tagline,
      voicePitch: c.voicePitch,
      // キーがない等で使えないときはオフライン AI で代行
      provider: providerAvailable(c.provider) ? c.provider : 'mock',
      model: c.model,
    })),
  };
}

function checkPin(req) {
  const pin = getSettings().adminPin;
  if (!pin) return;
  const given = Buffer.from(String(req.headers['x-admin-pin'] || ''));
  const want = Buffer.from(pin);
  if (given.length !== want.length || !timingSafeEqual(given, want)) throw new GameError('PIN が違います', 401);
}

async function handleAdmin(req, res, parts) {
  checkPin(req);
  const action = parts[2];
  if (req.method === 'GET' && action === 'settings') {
    return send(res, 200, { settings: adminView(), providers: listProviders(), file: SETTINGS_FILE });
  }
  if (req.method !== 'POST') throw new GameError('Not found', 404);
  const body = await readBody(req);
  if (action === 'settings') {
    const s = saveSettings(body);
    if (s.characters.filter((c) => c.enabled).length < 2) {
      return send(res, 200, { settings: adminView(s), providers: listProviders(), warning: '有効なキャラクターが2人未満のため、ゲームを始められません' });
    }
    return send(res, 200, { settings: adminView(s), providers: listProviders() });
  }
  if (action === 'test') {
    // AI との接続テスト（1回だけ呼ぶ）
    const s = getSettings();
    const c = s.characters.find((x) => x.id === body.characterId) || s.characters[0];
    const started = Date.now();
    try {
      const text = await complete(c.provider, {
        model: c.model,
        system: `あなたは「${c.name}」。性格: ${c.personality} 話し方: ${c.speech}`,
        user: '展示に来たお客さんへ、自己紹介をひとことでどうぞ。JSON で {"speech":"..."} の形で答えてください。',
        timeoutMs: 30000,
        maxWaitMs: 5000,
      });
      let speech = text;
      try { speech = JSON.parse(text.replace(/```(?:json)?/g, '')).speech || text; } catch { /* そのまま表示 */ }
      return send(res, 200, { ok: true, ms: Date.now() - started, name: c.name, speech: String(speech).slice(0, 200) });
    } catch (e) {
      return send(res, 200, { ok: false, ms: Date.now() - started, name: c.name, error: e.message.slice(0, 500) });
    }
  }
  if (action === 'shutdown') {
    send(res, 200, { ok: true });
    setTimeout(() => process.exit(0), 300);
    return;
  }
  throw new GameError('Not found', 404);
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const method = req.method;

  if (parts[1] === 'admin') return handleAdmin(req, res, parts);
  if (method === 'GET' && parts[1] === 'kiosk') return send(res, 200, kioskConfig());
  if (method === 'GET' && parts[1] === 'health') return send(res, 200, { ok: true, app: APP_ID });
  if (method === 'POST' && parts[1] === 'games' && parts.length === 2) {
    const body = await readBody(req);
    const game = createGame(buildGameConfig(Number(body.humans) || 1));
    games.set(game.id, game);
    return send(res, 201, publicState(game));
  }
  if (parts[1] !== 'games' || !parts[2]) throw new GameError('Not found', 404);

  const game = getGame(parts[2]);
  const action = parts[3];
  if (method === 'GET' && !action) return send(res, 200, publicState(game));
  if (method !== 'POST') throw new GameError('Not found', 404);

  const body = await readBody(req);
  switch (action) {
    case 'word':
      return send(res, 200, { word: wordFor(game, body.playerId) });
    case 'start':
      startTalk(game);
      break;
    case 'advance':
      await advance(game);
      break;
    case 'speak':
      humanSpeak(game, body.playerId, body.text);
      break;
    case 'ask':
      humanAsk(game, body.playerId, body.targetId, body.text);
      break;
    case 'vote':
      await humanVote(game, body.playerId, body.targetId);
      break;
    case 'guess':
      humanGuess(game, body.playerId, body.guess);
      break;
    default:
      throw new GameError('Not found', 404);
  }
  return send(res, 200, publicState(game));
}

async function serveStatic(res, pathname) {
  let rel;
  try {
    rel = normalize(decodeURIComponent(pathname === '/' ? '/index.html' : pathname)).replace(/^(\.\.[/\\])+/, '');
  } catch {
    return send(res, 400, { error: 'Bad request' });
  }
  const file = join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'Forbidden' });
  try {
    const data = await readFile(file);
    const ext = extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      // 画面の作り（HTML/JS/CSS）は保存させない（古い版が表示され続けないように）
      'Cache-Control': ext === '.webp' || ext === '.png' ? 'max-age=3600' : 'no-store',
    });
    res.end(data);
  } catch {
    send(res, 404, { error: 'Not found' });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else await serveStatic(res, url.pathname);
  } catch (e) {
    const status = e instanceof GameError ? e.status : 500;
    if (status === 500) console.error(e);
    send(res, status, { error: e.message || 'サーバーエラー' });
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log(`ポート ${PORT} はすでに使われています（もう起動しているかもしれません）。`);
    process.exit(0);
  }
  throw e;
});

server.listen(PORT, HOST, () => {
  console.log(`Word Wolf with AIs: http://localhost:${PORT}  (管理画面: http://localhost:${PORT}/admin.html)`);
  const ready = listProviders().filter((p) => p.available && p.id !== 'ollama').map((p) => p.label);
  console.log(`   使えるAI: ${ready.join(' / ')}`);
  console.log(`   設定ファイル: ${SETTINGS_FILE}`);
  console.log('   このウィンドウを閉じるとゲームが止まります。');
});
