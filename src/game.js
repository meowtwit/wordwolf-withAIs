// ゲーム進行。AI 呼び出しは発言・質問・回答・自由会話・投票・逆転のときだけ。
//
// 流れ:
//   roulette  発言順をルーレットで決める（順番はゲーム作成時にサーバーが決定）
//   intro     1ターン目: 順番に一言ずつ
//   qa        2ターン目: 順番に、誰か1人へ質問 → 相手が答える
//   free      3ターン目: 1分間の自由会話（@名前 / @all で呼びかけ）
//   voting    4ターン目: 全員一斉投票（同票なら1回だけ決選投票）
//   guess     ウルフが追放されたら、多数派のお題を当てれば逆転勝利
//   finished
import { randomUUID } from 'node:crypto';
import { pickTopic } from './topics.js';
import * as defaultAI from './ai.js';

const MAX_SPEECH = 120;
const envMs = (k, d) => Number(process.env[k]) || d;

// 自由会話が混雑しないための設定
export const FREE_TALK = {
  durationMs: envMs('FREE_TALK_MS', 60_000),
  minGapMs: envMs('AI_MIN_INTERVAL_MS', 4_000), // AI の呼び出し同士の最小間隔（無料枠の分あたり上限対策）
  aiCooldownMs: 7_000, // 同じ AI が続けて話すまでの間隔（人間に呼ばれたときは無視）
  idleMs: 5_000, // 誰も話さない時間がこれを超えたら AI が話題を振る
  maxPerAi: 5, // 1人の AI が自由会話で話せる回数
  maxQueue: 4, // 返事待ちの列の長さ
  maxDepth: 2, // AI が AI を呼ぶ連鎖の深さ
  graceMs: 1_500, // 終了直前に考え始めた発言を受け付ける猶予
  humanMinGapMs: 1_000,
  aiTimeoutMs: 12_000,
};

export const PHASE_TURN = { roulette: 0, intro: 1, qa: 2, free: 3, voting: 4, guess: 4, finished: 4 };

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
export function createGame(config, { rng = Math.random, ai = defaultAI, now = Date.now, autoTick = true, freeTalk = {} } = {}) {
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
  if (names.some((n) => /[@＠\s]/.test(n) || ['all', '全員', 'みんな'].includes(n.toLowerCase()))) {
    throw new GameError('名前に @ や空白、all・全員・みんな は使えません');
  }

  const topic = pickTopic(rng);
  const wolfId = players[Math.floor(rng() * players.length)].id;
  for (const p of players) p.word = p.id === wolfId ? topic.minority.word : topic.majority.word;

  return {
    id: randomUUID(),
    createdAt: now(),
    ai,
    rng,
    now,
    autoTick,
    cfg: { ...FREE_TALK, ...freeTalk },
    phase: 'roulette',
    players,
    topic,
    wolfId,
    order: shuffle(players.map((p) => p.id), rng),
    cursor: 0,
    qa: null, // { step: 'ask'|'answer', from, to, question }
    free: null,
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

/** 「@ハル」「@all」などの呼びかけを取り出す。音声入力向けに、@なしで名前を呼んだ場合も数える。 */
export function parseMentions(text, players, selfId) {
  const t = String(text || '').normalize('NFKC');
  const all = /@(all|全員|みんな)/i.test(t) || /^(みんな|全員)[、,!！?？\s]/.test(t);
  const ids = new Set();
  // 長い名前から順に探す（「ハル」と「ハルカ」が両方いても誤認しない）
  const sorted = [...players].sort((a, b) => b.name.length - a.name.length);
  let rest = t;
  for (const p of sorted) {
    if (p.id === selfId) continue;
    const name = p.name.normalize('NFKC');
    if (rest.includes(`@${name}`) || rest.includes(name)) {
      ids.add(p.id);
      rest = rest.split(name).join(' ');
    }
  }
  return { all, ids: [...ids] };
}

/** AI に渡す情報。自分のお題と公開情報だけ。 */
export function aiView(game, player) {
  return {
    self: { id: player.id, name: player.name, personality: player.personality, word: player.word },
    players: game.order.map((id) => ({ id, name: nameOf(game, id), human: byId(game, id).type === 'human' })),
    log: game.log.map((l) => ({ ...l })),
    turn: PHASE_TURN[game.phase],
    memory: game.memory[player.id] || null,
  };
}

function recordThought(game, player, kind, data) {
  const entry = {
    kind,
    turn: PHASE_TURN[game.phase],
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
  const entry = { i: game.log.length, playerId, name: nameOf(game, playerId), text, turn: PHASE_TURN[game.phase], kind, to };
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
    game.phase = 'qa';
    game.cursor = 0;
    game.qa = { step: 'ask', from: game.order[0], to: null, question: '' };
  }
}

function nextAfterAnswer(game) {
  game.cursor++;
  if (game.cursor >= game.order.length) startFree(game);
  else game.qa = { step: 'ask', from: game.order[game.cursor], to: null, question: '' };
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
      const out = await game.ai.aiTurn(actor, view, { kind: 'ask' });
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

// ---------- 3ターン目: 自由会話 ----------
// 混雑しないための決まり:
//  - AI は1人ずつしか考えない（同時に話さない）。呼び出しの間隔も minGapMs 空ける
//  - 人間に呼ばれた AI が最優先。@all なら AI 全員が1人ずつ順に答える
//  - AI が AI を呼ぶ連鎖は maxDepth まで。返事待ちの列は maxQueue まで（同じ AI は重複させない）
//  - 同じ AI は aiCooldownMs 空ける。自由会話で話せるのは1人 maxPerAi 回まで
//  - 誰も話さない時間が idleMs を超えたら、話していない AI が誰かを @ で呼んで話題を振る
function startFree(game) {
  game.phase = 'free';
  game.qa = null;
  const now = game.now();
  game.free = {
    startedAt: now,
    endsAt: now + game.cfg.durationMs,
    queue: [],
    thinking: null,
    inflight: null,
    lastAiCallAt: 0,
    lastMsgAt: now,
    count: {},
    lastSpokeAt: {},
    humanLastAt: {},
  };
  if (game.autoTick) {
    game.free.timer = setInterval(() => tickFree(game).catch(() => {}), 300);
    game.free.timer.unref?.();
  }
}

function enqueue(game, aiId, item) {
  const f = game.free;
  if (byId(game, aiId)?.type !== 'ai') return;
  if (f.thinking === aiId && item.depth > 0) return;
  if (f.queue.some((q) => q.aiId === aiId)) return;
  if ((f.count[aiId] || 0) >= game.cfg.maxPerAi && !['mention', 'all'].includes(item.reason)) return;
  const entry = { aiId, ...item };
  if (item.depth === 0) {
    // 人間から呼ばれたものは、AI 同士の呼びかけより前に入れる
    const idx = f.queue.findIndex((q) => q.depth > 0);
    if (idx < 0) f.queue.push(entry);
    else f.queue.splice(idx, 0, entry);
  } else {
    f.queue.push(entry);
  }
  if (f.queue.length > game.cfg.maxQueue) f.queue.length = game.cfg.maxQueue;
}

function routeMentions(game, entry, depth) {
  const speaker = byId(game, entry.playerId);
  const m = parseMentions(entry.text, game.players, entry.playerId);
  const targets = m.all ? shuffle(game.players.filter((p) => p.id !== entry.playerId).map((p) => p.id), game.rng) : m.ids;
  entry.to = m.all ? ['all'] : m.ids;
  for (const id of targets) {
    if (depth > game.cfg.maxDepth) break;
    enqueue(game, id, { reason: m.all ? 'all' : 'mention', fromId: speaker.id, msgIndex: entry.i, depth });
  }
  return targets.length;
}

/** 自由会話の発言（人間）。 */
export function humanSay(game, playerId, text) {
  if (game.phase !== 'free') throw new GameError('今は自由会話の時間ではありません');
  const p = byId(game, playerId);
  if (!p || p.type !== 'human') throw new GameError('不正なプレイヤーです');
  const f = game.free;
  const now = game.now();
  if (now >= f.endsAt) throw new GameError('時間切れです');
  if (now - (f.humanLastAt[playerId] || 0) < game.cfg.humanMinGapMs) throw new GameError('少し間をあけて話してください', 429);
  const t = cleanText(text);
  if (!t) throw new GameError('発言を入力してください');
  f.humanLastAt[playerId] = now;
  f.lastMsgAt = now;
  const entry = pushLog(game, playerId, t, 'free');
  const routed = routeMentions(game, entry, 0);
  if (!routed && f.queue.length === 0) {
    // 誰も呼ばれていなければ、話していない AI が1人だけ反応する
    const pick = pickIdleAI(game, now, true);
    if (pick) enqueue(game, pick.id, { reason: 'reply', fromId: playerId, msgIndex: entry.i, depth: 1 });
  }
}

function pickIdleAI(game, now, ignoreCooldown = false) {
  const f = game.free;
  const last = game.log[game.log.length - 1]?.playerId;
  const pool = game.players.filter((p) => p.type === 'ai'
    && p.id !== last
    && apiReady(game, p)
    && (f.count[p.id] || 0) < game.cfg.maxPerAi
    && (ignoreCooldown || now - (f.lastSpokeAt[p.id] || 0) >= game.cfg.aiCooldownMs));
  if (!pool.length) return null;
  const min = Math.min(...pool.map((p) => f.count[p.id] || 0));
  const fewest = pool.filter((p) => (f.count[p.id] || 0) === min);
  return fewest[Math.floor(game.rng() * fewest.length)];
}

const apiReady = (game, p) => (game.ai.readyIn ? game.ai.readyIn(p) : 0) === 0;

/** 自由会話の終わりまでに AI を呼べる残り回数（投票と逆予測の分を引く）。制限なしなら Infinity。 */
function budgetLeft(game) {
  if (!game.ai.capacity) return Infinity;
  const ais = game.players.filter((p) => p.type === 'ai');
  const reserve = ais.length + 1;
  return Math.min(...ais.map((p) => game.ai.capacity(p, game.free.endsAt))) - reserve;
}

function nextQueued(game, now, humanOnly = false) {
  const f = game.free;
  for (let k = 0; k < f.queue.length; k++) {
    const q = f.queue[k];
    const coolingDown = now - (f.lastSpokeAt[q.aiId] || 0) < game.cfg.aiCooldownMs;
    const fromHuman = byId(game, q.fromId)?.type === 'human';
    if (coolingDown && !fromHuman) continue;
    if (humanOnly && !fromHuman) continue; // 枠が足りないときは、人間に呼ばれた分だけ答える
    if (!apiReady(game, byId(game, q.aiId))) continue; // 回数上限で呼べない AI は列に残して後回し
    f.queue.splice(k, 1);
    return q;
  }
  return null;
}

/** 自由会話を1歩進める。AI に話させたらその Promise を返す（テスト用）。 */
export function tickFree(game) {
  const f = game.free;
  if (game.phase !== 'free' || !f) return Promise.resolve(null);
  const now = game.now();
  if (f.inflight) return Promise.resolve(null);
  if (now >= f.endsAt) {
    endFree(game);
    return Promise.resolve(null);
  }
  // 回数上限のある API なら、残りの枠を自由会話の残り時間に均等に配る（投票の分は取っておく）
  const left = budgetLeft(game);
  const gap = Number.isFinite(left) ? Math.max(game.cfg.minGapMs, (f.endsAt - now) / Math.max(left, 1)) : game.cfg.minGapMs;
  if (now - f.lastAiCallAt < gap) return Promise.resolve(null);
  let item = nextQueued(game, now, left <= 0);
  if (!item && left > 0 && now - f.lastMsgAt >= game.cfg.idleMs) {
    const p = pickIdleAI(game, now);
    if (p) item = { aiId: p.id, reason: 'idle', fromId: null, msgIndex: null, depth: 1 };
  }
  if (!item) return Promise.resolve(null);
  const player = byId(game, item.aiId);
  const trigger = item.msgIndex == null ? null : game.log[item.msgIndex];
  f.thinking = player.id;
  f.lastAiCallAt = now;
  const task = {
    kind: 'free',
    reason: item.reason,
    fromName: trigger ? trigger.name : null,
    triggerText: trigger ? trigger.text : null,
    remainingSec: Math.max(0, Math.round((f.endsAt - now) / 1000)),
    timeoutMs: game.cfg.aiTimeoutMs,
  };
  f.inflight = game.ai.aiTurn(player, aiView(game, player), task)
    .then((out) => {
      const t = game.now();
      if (game.phase !== 'free' || t > f.endsAt + game.cfg.graceMs || !out || out.skip) {
        if (out && game.phase === 'free') recordThought(game, player, 'free', { ...out, strategy: `(発言できず) ${out.strategy || out.error || ''}` });
        return null;
      }
      recordThought(game, player, 'free', out);
      const entry = pushLog(game, player.id, out.speech, 'free');
      f.count[player.id] = (f.count[player.id] || 0) + 1;
      f.lastSpokeAt[player.id] = t;
      f.lastMsgAt = t;
      routeMentions(game, entry, item.depth + 1);
      return entry;
    })
    .finally(() => {
      f.thinking = null;
      f.inflight = null;
    });
  return f.inflight;
}

function endFree(game) {
  const f = game.free;
  if (f?.timer) clearInterval(f.timer);
  if (f) {
    f.queue = [];
    f.timer = null;
  }
  startVoting(game, game.players.map((p) => p.id));
}

/** テストや片付け用: 自由会話のタイマーを止める。 */
export function stopTimers(game) {
  if (game.free?.timer) clearInterval(game.free.timer);
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
  stopTimers(game);
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
  const now = game.now();
  const base = {
    id: game.id,
    phase: game.phase,
    turn: PHASE_TURN[game.phase],
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
    free: game.phase === 'free' && game.free ? {
      remainingMs: Math.max(0, game.free.endsAt - now),
      durationMs: game.cfg.durationMs,
      thinkingId: game.free.thinking,
      queue: game.free.queue.map((q) => ({ id: q.aiId, fromId: q.fromId, reason: q.reason })),
    } : null,
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
