// 依存なしの Node.js サーバー。静的ファイル配信 + ゲーム API。
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createGame, startTalk, advance, humanSpeak, humanAsk, humanVote, humanGuess, publicState, wordFor, GameError,
} from './src/game.js';
import { listProviders } from './src/providers.js';
import { PERSONALITIES } from './src/ai.js';

try {
  process.loadEnvFile?.('.env');
} catch {
  // .env がなくても動く
}

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

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
    if (size > 64 * 1024) throw new GameError('リクエストが大きすぎます', 413);
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
  if (!g) throw new GameError('ゲームが見つかりません', 404);
  return g;
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const method = req.method;

  if (method === 'GET' && parts[1] === 'config') {
    return send(res, 200, {
      providers: listProviders(),
      personalities: Object.entries(PERSONALITIES).map(([id, p]) => ({ id, label: p.label })),
    });
  }
  if (method === 'POST' && parts[1] === 'games' && parts.length === 2) {
    const game = createGame(await readBody(req));
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
  const rel = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '');
  const file = join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'Forbidden' });
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
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

server.listen(PORT, () => {
  console.log(`🐺 Word Wolf with AIs: http://localhost:${PORT}`);
  const ready = listProviders().filter((p) => p.available).map((p) => p.label);
  console.log(`   使えるAI: ${ready.join(' / ')}`);
});
