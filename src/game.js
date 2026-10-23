// ゲーム進行。AI 呼び出しは発言・質問・回答・投票・逆転のときだけ。
//
// 流れ:
//   roulette  発言順をルーレットで決める（順番はゲーム作成時にサーバーが決定）
//   intro     1ターン目: 順番に一言ずつ
//   qa        2・3ターン目: 順番に、誰か1人へ質問 → 相手が答える（これを2周）
//   voting    4ターン目: 全員一斉投票（同票なら1回だけ決選投票）
//   guess     ウルフが追放されたら、多数派のお題を当てれば逆転勝利
//   finished
import { randomUUID } from 'node:crypto';
import { pickTopic } from './topics.js';
import * as defaultAI from './ai.js';

const MAX_SPEECH = 120;
/** 質問ターンの回数（2ターン目と3ターン目）。 */
export const QA_ROUNDS = 2;

const PHASE_TURN = { roulette: 0, intro: 1, voting: 4, guess: 4, finished: 4 };

/** いまが何ターン目か（質問は1周目が2ターン目、2周目が3ターン目）。 */
export function turnOf(game) {
  return game.phase === 'qa' ? 1 + game.qaRound : PHASE_TURN[game.phase];
}

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
 *   humans: [{ name }],                              // 1〜2人
 *   ais: [{ name, personality, provider, model }],   // 2〜4人
 * }
 */
export function createGame(config, { rng = Math.random, ai = defaultAI, now = Date.now } = {}) {
  const humans = (config.humans || []).filter((h) => h && h.name?.trim());
  const ais = config.ais || [];
  if (humans.length < 1 || humans.length > 2) throw new GameError('人間は1〜2人にしてください');
  if (ais.length < 2 || ais.length > 4) throw new GameError('AIは2〜4人にしてください');

  const players = [
    ...humans.map((h, i) => ({ id: `h${i + 1}`, name: h.name.trim().slice(0, 10), type: 'human' })),
    ...ais.map((a, i) => ({
      id: `ai${i + 1}`,
      name: (a.name || `AI${i + 1}`).trim().slice(0, 10),
      type: 'ai',
      personality: a.personality || 'analyst',
      provider: a.provider || 'mock',
      model: a.model || '',
    })),
  ];
  const names = players.map((p) => p.name);
  if (new Set(names).size !== names.length) throw new GameError('プレイヤー名が重複しています');

  const topic = pickTopic(rng);
  const wolfId = players[Math.floor(rng() * players.length)].id;
  for (const p of players) p.word = p.id === wolfId ? topic.minority.word : topic.majority.word;

  return {
    id: randomUUID(),
    createdAt: now(),
    ai,
    rng,
    now,
    phase: 'roulette',
    players,
    topic,
    wolfId,
    order: shuffle(players.map((p) => p.id), rng),
    cursor: 0,
    qaRound: 0,
    qa: null, // { step: 'ask'|'answer', from, to, question }
    log: [],
    memory: {},
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
const nameOf = (game, id) => byId(game, id)?.name;

/** いま行動すべきプレイヤー（intro / qa のみ）。 */
export function currentActor(game) {
  if (game.phase === 'intro') return byId(game, game.order[game.cursor]);
  if (game.phase === 'qa') return byId(game, game.qa.step === 'ask' ? game.qa.from : game.qa.to);
  return null;
}

/** AI に渡す情報。自分のお題と公開情報だけ。 */
export function aiView(game, player) {
  return {
    self: { id: player.id, name: player.name, personality: player.personality, word: player.word },
    players: game.order.map((id) => ({ id, name: nameOf(game, id), human: byId(game, id).type === 'human' })),
    log: game.log.map((l) => ({ ...l })),
    turn: turnOf(game),
    memory: game.memory[player.id] || null,
  };
}

function recordThought(game, player, kind, data) {
  const entry = {
    kind,
    turn: turnOf(game),
    at: game.log.length,
    suspicions: data.suspicions,
    strategy: data.strategy || data.reason || '',
    wolfSelf: data.wolfSelf,
    source: data.source,
    error: data.error,
  };
  game.thoughts[player.id].push(entry);
  game.memory[player.id] = { suspicions: data.suspicions, strategy: entry.strategy };
}

function pushLog(game, playerId, text, kind, to = []) {
  const entry = { i: game.log.length, playerId, name: nameOf(game, playerId), text, turn: turnOf(game), kind, to };
  game.log.push(entry);
  return entry;
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

const cleanText = (text) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_SPEECH);

// ---------- ルーレット → 1ターン目 ----------
export function startTalk(game) {
  if (game.phase !== 'roulette') throw new GameError('すでに始まっています');
  game.phase = 'intro';
  game.cursor = 0;
}

function nextAfterIntro(game) {
  game.cursor++;
  if (game.cursor >= game.order.length) {
    startQaRound(game, 1);
  }
}

function startQaRound(game, round) {
  game.phase = 'qa';
  game.qaRound = round;
  game.cursor = 0;
  game.qa = { step: 'ask', from: game.order[0], to: null, question: '' };
}

function nextAfterAnswer(game) {
  game.cursor++;
  if (game.cursor < game.order.length) {
    game.qa = { step: 'ask', from: game.order[game.cursor], to: null, question: '' };
  } else if (game.qaRound < QA_ROUNDS) {
    startQaRound(game, game.qaRound + 1);
  } else {
    game.qa = null;
    startVoting(game, game.players.map((p) => p.id));
  }
}

/** intro / qa で、手番の AI に行動させる。 */
export function advance(game) {
  return withLock(game, async () => {
    const actor = currentActor(game);
    if (!actor) throw new GameError('今は AI の手番ではありません');
    if (actor.type !== 'ai') throw new GameError('人間の手番です');
    const view = aiView(game, actor);

    if (game.phase === 'intro') {
      const out = await game.ai.aiTurn(actor, view, { kind: 'intro' });
      recordThought(game, actor, 'intro', out);
      pushLog(game, actor.id, out.speech, 'say');
      nextAfterIntro(game);
      return;
    }
    if (game.qa.step === 'ask') {
      const out = await game.ai.aiTurn(actor, view, { kind: 'ask', round: game.qaRound });
      recordThought(game, actor, 'ask', out);
      game.qa = { step: 'answer', from: actor.id, to: out.to, question: out.speech };
      pushLog(game, actor.id, out.speech, 'question', [out.to]);
      return;
    }
    const out = await game.ai.aiTurn(actor, view, {
      kind: 'answer', fromId: game.qa.from, fromName: nameOf(game, game.qa.from), question: game.qa.question,
    });
    recordThought(game, actor, 'answer', out);
    pushLog(game, actor.id, out.speech, 'answer', [game.qa.from]);
    nextAfterAnswer(game);
  });
}

/** intro の一言、または qa の回答（人間）。 */
export function humanSpeak(game, playerId, text) {
  const actor = currentActor(game);
  if (!actor || actor.id !== playerId || actor.type !== 'human') throw new GameError('あなたの手番ではありません');
  if (game.phase === 'qa' && game.qa.step !== 'answer') throw new GameError('今は質問する番です');
  if (game.busy) throw new GameError('処理中です', 409);
  const t = cleanText(text);
  if (!t) throw new GameError('発言を入力してください');
  if (game.phase === 'intro') {
    pushLog(game, playerId, t, 'say');
    nextAfterIntro(game);
  } else {
    pushLog(game, playerId, t, 'answer', [game.qa.from]);
    nextAfterAnswer(game);
  }
}

/** qa の質問（人間）。 */
export function humanAsk(game, playerId, targetId, text) {
  const actor = currentActor(game);
  if (game.phase !== 'qa' || game.qa.step !== 'ask' || actor?.id !== playerId || actor.type !== 'human') {
    throw new GameError('あなたが質問する番ではありません');
  }
  if (game.busy) throw new GameError('処理中です', 409);
  if (targetId === playerId || !byId(game, targetId)) throw new GameError('質問する相手を選んでください');
  const t = cleanText(text);
  if (!t) throw new GameError('質問を入力してください');
  game.qa = { step: 'answer', from: playerId, to: targetId, question: t };
  pushLog(game, playerId, t, 'question', [targetId]);
}

// ---------- 4ターン目: 一斉投票 ----------
function startVoting(game, candidates) {
  game.phase = 'voting';
  game.voteRound++;
  game.candidates = candidates;
  game.votes = {};
}

export function humanVote(game, playerId, targetId) {
  return withLock(game, async () => {
    if (game.phase !== 'voting') throw new GameError('今は投票の時間ではありません');
    const voter = byId(game, playerId);
    if (!voter || voter.type !== 'human') throw new GameError('不正な投票者です');
    if (game.votes[playerId]) throw new GameError('すでに投票済みです');
    if (targetId === playerId || !game.candidates.includes(targetId)) throw new GameError('その人には投票できません');
    game.votes[playerId] = { target: targetId, reason: '' };
    if (game.players.some((p) => p.type === 'human' && !game.votes[p.id])) return;

    // 人間が全員投票したら、AI がそれぞれ独立に投票（互いの票は見えない）
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
    if (game.voteRound === 1) return startVoting(game, top);
    return finish(game, { expelledId: null, winner: 'wolf', reason: '決選投票でも同票。誰も追放されず、ウルフが逃げ切りました' });
  }
  const expelledId = top[0];
  if (expelledId !== game.wolfId) {
    return finish(game, { expelledId, winner: 'wolf', reason: `${nameOf(game, expelledId)}さんは多数派でした` });
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
    reason: correct ? 'ウルフは見破られたが、多数派のお題を当てて逆転勝利！' : 'ウルフを見破り、逆転も防ぎました',
    guess: { text: guess, reason, correct },
  });
}

export function humanGuess(game, playerId, guess) {
  if (game.phase !== 'guess') throw new GameError('今は逆転のチャンスではありません');
  if (playerId !== game.wolfId) throw new GameError('ウルフ本人だけが答えられます');
  if (!String(guess || '').trim()) throw new GameError('お題を入力してください');
  resolveGuess(game, String(guess).trim().slice(0, 30));
}

function finish(game, result) {
  game.phase = 'finished';
  game.candidates = [];
  game.result = result;
}

/** 人間だけが自分のお題を見られる。 */
export function wordFor(game, playerId) {
  const p = byId(game, playerId);
  if (!p || p.type !== 'human') throw new GameError('お題を確認できるのは人間プレイヤーだけです', 403);
  return p.word;
}

/** ブラウザに送ってよい状態。終了前はお題・ウルフ・AIの推理・票の中身を含めない。 */
export function publicState(game) {
  const actor = currentActor(game);
  const base = {
    id: game.id,
    phase: game.phase,
    turn: turnOf(game),
    order: game.order,
    players: game.order.map((id) => {
      const p = byId(game, id);
      return {
        id: p.id, name: p.name, type: p.type,
        ...(p.type === 'ai' ? { personality: p.personality, provider: p.provider, model: p.model } : {}),
      };
    }),
    cursor: game.cursor,
    actorId: actor?.id || null,
    qa: game.qa ? { step: game.qa.step, from: game.qa.from, to: game.qa.to } : null,
    qaRound: game.qaRound,
    log: game.log,
    voteRound: game.voteRound,
    candidates: game.candidates,
    voted: Object.keys(game.votes).filter((id) => byId(game, id).type === 'human'),
    busy: game.busy,
  };
  if (game.phase === 'guess') {
    base.guesserId = byId(game, game.wolfId).type === 'human' ? game.wolfId : null;
    base.voteHistory = game.voteHistory; // 投票は一斉公開
  }
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
