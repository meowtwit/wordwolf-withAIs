// ゲーム進行（お題配布・発言順・ログ・投票集計・勝敗判定）。AI 呼び出しは発言・投票・逆転の時だけ。
import { randomUUID } from 'node:crypto';
import { pickTopic } from './topics.js';
import * as defaultAI from './ai.js';

const MAX_SPEECH = 120;

function shuffle(arr, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export class GameError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/**
 * config = {
 *   humans: [{ name }],                       // 1〜2人
 *   ais: [{ name, personality, provider, model }], // 1〜4人（推奨3人）
 *   rounds: 2 | 3
 * }
 */
export function createGame(config, { rng = Math.random, ai = defaultAI } = {}) {
  const humans = (config.humans || []).filter((h) => h && h.name?.trim());
  const ais = config.ais || [];
  if (humans.length < 1 || humans.length > 2) throw new GameError('人間は1〜2人にしてください');
  if (ais.length < 1 || ais.length > 4) throw new GameError('AIは1〜4人にしてください');
  if (humans.length + ais.length < 3) throw new GameError('合計3人以上必要です');
  const rounds = Math.min(Math.max(Number(config.rounds) || 2, 1), 5);

  const players = [
    ...humans.map((h, i) => ({ id: `h${i + 1}`, name: h.name.trim().slice(0, 12), type: 'human' })),
    ...ais.map((a, i) => ({
      id: `ai${i + 1}`,
      name: (a.name || `AI ${String(i + 1).padStart(2, '0')}`).trim().slice(0, 12),
      type: 'ai',
      personality: a.personality || 'analyst',
      provider: a.provider || 'mock',
      model: a.model || '',
    })),
  ];
  const names = new Set(players.map((p) => p.name));
  if (names.size !== players.length) throw new GameError('プレイヤー名が重複しています');

  const topic = pickTopic(rng);
  const wolfId = players[Math.floor(rng() * players.length)].id;
  for (const p of players) p.word = p.id === wolfId ? topic.minority.word : topic.majority.word;

  return {
    id: randomUUID(),
    createdAt: Date.now(),
    ai,
    rng,
    phase: 'discussion', // discussion → voting → (guess) → finished
    players,
    topic,
    wolfId,
    rounds,
    order: shuffle(players.map((p) => p.id), rng),
    turn: 0,
    log: [],
    memory: {}, // aiId → 直近の推理（その AI 自身にだけ渡す）
    thoughts: Object.fromEntries(players.filter((p) => p.type === 'ai').map((p) => [p.id, []])),
    voteRound: 0,
    candidates: [],
    votes: {},
    voteHistory: [],
    result: null,
    busy: false,
  };
}

const byId = (game, id) => game.players.find((p) => p.id === id);

export function currentSpeaker(game) {
  if (game.phase !== 'discussion') return null;
  return byId(game, game.order[game.turn % game.order.length]);
}

function currentRound(game) {
  return Math.min(Math.floor(game.turn / game.order.length) + 1, game.rounds);
}

/** AI に渡す情報。自分のお題と公開情報だけ。 */
export function aiView(game, player) {
  return {
    self: { id: player.id, name: player.name, personality: player.personality, word: player.word },
    players: game.order.map((id) => ({ id, name: byId(game, id).name })),
    log: game.log.map((l) => ({ ...l })),
    round: currentRound(game),
    rounds: game.rounds,
    memory: game.memory[player.id] || null,
  };
}

function recordThought(game, player, kind, data) {
  const entry = {
    kind,
    turn: game.log.length,
    round: currentRound(game),
    suspicions: data.suspicions,
    strategy: data.strategy || data.reason || '',
    wolfSelf: data.wolfSelf,
    source: data.source,
    error: data.error,
  };
  game.thoughts[player.id].push(entry);
  game.memory[player.id] = { suspicions: data.suspicions, strategy: entry.strategy };
}

function pushSpeech(game, player, text) {
  game.log.push({ playerId: player.id, name: player.name, text, round: currentRound(game) });
  game.turn++;
  if (game.turn >= game.rounds * game.order.length) startVoting(game, game.players.map((p) => p.id));
}

function startVoting(game, candidates) {
  game.phase = 'voting';
  game.voteRound++;
  game.candidates = candidates;
  game.votes = {};
}

async function withLock(game, fn) {
  if (game.busy) throw new GameError('処理中です。少し待ってください', 409);
  game.busy = true;
  try {
    return await fn();
  } finally {
    game.busy = false;
  }
}

/** 現在の手番が AI なら発言させる。 */
export function advance(game) {
  return withLock(game, async () => {
    const speaker = currentSpeaker(game);
    if (!speaker) throw new GameError('今は発言フェーズではありません');
    if (speaker.type !== 'ai') throw new GameError('人間の手番です');
    const out = await game.ai.aiSpeak(speaker, aiView(game, speaker));
    recordThought(game, speaker, 'speech', out);
    pushSpeech(game, speaker, out.speech);
    return out;
  });
}

export function humanSpeak(game, playerId, text) {
  const speaker = currentSpeaker(game);
  if (!speaker || speaker.id !== playerId || speaker.type !== 'human') throw new GameError('あなたの手番ではありません');
  if (game.busy) throw new GameError('処理中です', 409);
  const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_SPEECH);
  if (!t) throw new GameError('発言を入力してください');
  pushSpeech(game, speaker, t);
}

export function humanVote(game, playerId, targetId) {
  return withLock(game, async () => {
    if (game.phase !== 'voting') throw new GameError('今は投票フェーズではありません');
    const voter = byId(game, playerId);
    if (!voter || voter.type !== 'human') throw new GameError('不正な投票者です');
    if (game.votes[playerId]) throw new GameError('すでに投票済みです');
    if (targetId === playerId || !game.candidates.includes(targetId)) throw new GameError('その人には投票できません');
    game.votes[playerId] = { target: targetId, reason: '' };

    const humansLeft = game.players.filter((p) => p.type === 'human' && !game.votes[p.id]);
    if (humansLeft.length > 0) return;

    // 人間が全員投票したら AI が並列で投票（互いの票は見えない）
    const aiPlayers = game.players.filter((p) => p.type === 'ai');
    const results = await Promise.all(aiPlayers.map((p) => game.ai.aiVote(p, aiView(game, p), game.candidates)));
    aiPlayers.forEach((p, i) => {
      game.votes[p.id] = { target: results[i].vote, reason: results[i].reason };
      recordThought(game, p, 'vote', results[i]);
    });
    await tally(game);
  });
}

async function tally(game) {
  const counts = {};
  for (const v of Object.values(game.votes)) counts[v.target] = (counts[v.target] || 0) + 1;
  const max = Math.max(...Object.values(counts));
  const top = Object.keys(counts).filter((id) => counts[id] === max);
  game.voteHistory.push({ round: game.voteRound, votes: { ...game.votes }, counts });

  if (top.length > 1) {
    if (game.voteRound === 1) {
      startVoting(game, top); // 同票なら1回だけ決選投票
      return;
    }
    return finish(game, { expelledId: null, winner: 'wolf', reason: '決選投票でも同票となり、誰も追放されませんでした' });
  }
  const expelledId = top[0];
  if (expelledId !== game.wolfId) {
    return finish(game, { expelledId, winner: 'wolf', reason: '追放されたのは多数派でした' });
  }
  const wolf = byId(game, game.wolfId);
  game.phase = 'guess';
  game.candidates = [];
  if (wolf.type === 'ai') {
    const out = await game.ai.aiGuess(wolf, aiView(game, wolf));
    resolveGuess(game, out.guess, out.reason);
  }
}

export function normalizeWord(w) {
  return String(w || '')
    .normalize('NFKC')
    .replace(/[\s「」『』"'。、.!！?？]/g, '')
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .toLowerCase();
}

function resolveGuess(game, guess, reason = '') {
  const correct = normalizeWord(guess) === normalizeWord(game.topic.majority.word);
  finish(game, {
    expelledId: game.wolfId,
    winner: correct ? 'wolf' : 'citizens',
    reason: correct ? 'ウルフは追放されたが、多数派のお題を当てて逆転勝利！' : 'ウルフを追放し、逆転も阻止しました',
    guess: { text: guess, reason, correct },
  });
}

export function humanGuess(game, playerId, guess) {
  if (game.phase !== 'guess') throw new GameError('今は逆転フェーズではありません');
  if (playerId !== game.wolfId) throw new GameError('ウルフ本人だけが答えられます');
  if (!String(guess || '').trim()) throw new GameError('お題を入力してください');
  resolveGuess(game, String(guess).trim().slice(0, 30));
}

function finish(game, result) {
  game.phase = 'finished';
  game.candidates = [];
  game.result = result;
}

/** 人間（本人確認済み）だけが自分のお題を見られる。 */
export function wordFor(game, playerId) {
  const p = byId(game, playerId);
  if (!p || p.type !== 'human') throw new GameError('お題を確認できるのは人間プレイヤーだけです', 403);
  return p.word;
}

/** ブラウザに送ってよい状態。終了前はお題・ウルフ・AIの内部推理・票の中身を含めない。 */
export function publicState(game) {
  const speaker = currentSpeaker(game);
  const base = {
    id: game.id,
    phase: game.phase,
    rounds: game.rounds,
    round: currentRound(game),
    turn: game.turn,
    totalTurns: game.rounds * game.order.length,
    players: game.order.map((id) => {
      const p = byId(game, id);
      return {
        id: p.id,
        name: p.name,
        type: p.type,
        ...(p.type === 'ai' ? { personality: p.personality, provider: p.provider, model: p.model } : {}),
      };
    }),
    currentSpeakerId: speaker?.id || null,
    log: game.log,
    voteRound: game.voteRound,
    candidates: game.candidates,
    voted: Object.keys(game.votes),
    busy: game.busy,
  };
  if (game.phase === 'guess') base.guesserId = byId(game, game.wolfId).type === 'human' ? game.wolfId : null;
  if (game.phase !== 'finished') return base;
  return {
    ...base,
    result: game.result,
    wolfId: game.wolfId,
    topic: { majority: game.topic.majority.word, minority: game.topic.minority.word },
    words: Object.fromEntries(game.players.map((p) => [p.id, p.word])),
    voteHistory: game.voteHistory,
    thoughts: game.thoughts,
  };
}
