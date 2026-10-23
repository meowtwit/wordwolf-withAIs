import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame, startTalk, advance, humanSpeak, humanAsk, humanSay, humanVote, humanGuess, tickFree,
  publicState, aiView, currentActor, wordFor, normalizeWord, parseMentions, FREE_TALK,
} from '../src/game.js';
import { parseJsonLoose, sanitizeSuspicions } from '../src/ai.js';

// 決定的な乱数
function seeded(seed = 1) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
}

const CONFIG = {
  humans: [{ name: 'あなた' }],
  ais: [
    { name: 'ハル', personality: 'analyst', provider: 'mock' },
    { name: 'ミオ', personality: 'questioner', provider: 'mock' },
    { name: 'ソラ', personality: 'trickster', provider: 'mock' },
  ],
};

function clock(start = 1_000_000) {
  const c = { t: start, now: () => c.t, add(ms) { c.t += ms; } };
  return c;
}

/** 呼ばれ方を記録する偽 AI。 */
function fakeAI({ voteFor = (p, c) => c.find((id) => id !== p.id), guess = 'はずれ', freeSpeech } = {}) {
  const calls = [];
  return {
    calls,
    async aiTurn(p, view, task) {
      calls.push({ id: p.id, view, task });
      const others = view.players.filter((x) => x.id !== p.id).map((x) => x.id);
      const speech = task.kind === 'free' && freeSpeech ? freeSpeech(p, task) : `${p.name}の${task.kind}`;
      return { speech, to: task.kind === 'ask' ? others[0] : undefined, suspicions: {}, strategy: 's', wolfSelf: 0.2, source: 'llm' };
    },
    async aiVote(p, view, candidates) {
      calls.push({ id: p.id, view, task: { kind: 'vote' } });
      return { vote: voteFor(p, candidates), reason: 'r', suspicions: {}, source: 'llm' };
    },
    async aiGuess(p, view) {
      calls.push({ id: p.id, view, task: { kind: 'guess' } });
      return { guess: typeof guess === 'function' ? guess() : guess, reason: 'g', source: 'llm' };
    },
  };
}

function newGame(opts = {}) {
  const c = clock();
  const g = createGame(opts.config || CONFIG, { rng: seeded(opts.seed || 3), ai: opts.ai || fakeAI(), now: c.now, autoTick: false, freeTalk: opts.freeTalk });
  return { g, c };
}

/** 1・2ターン目を最後まで進める。 */
async function playTurns12(g) {
  startTalk(g);
  while (g.phase === 'intro' || g.phase === 'qa') {
    const a = currentActor(g);
    if (a.type === 'ai') await advance(g);
    else if (g.phase === 'qa' && g.qa.step === 'ask') humanAsk(g, a.id, g.order.find((id) => id !== a.id), 'それっていつ使う？');
    else humanSpeak(g, a.id, '夏っぽいよね');
  }
}

/** 自由会話を時計を進めながら最後まで回す。 */
async function runFree(g, c, { stepMs = 500, onStep } = {}) {
  while (g.phase === 'free') {
    await tickFree(g);
    onStep?.();
    c.add(stepMs);
  }
}

test('お題: ウルフ1人だけが少数派のお題を持つ', () => {
  for (let seed = 1; seed < 30; seed++) {
    const { g } = newGame({ seed });
    const wolves = g.players.filter((p) => p.word === g.topic.minority.word);
    assert.equal(wolves.length, 1);
    assert.equal(wolves[0].id, g.wolfId);
  }
});

test('ルーレット: 全員がちょうど1回ずつ並び、その順で1ターン目が進む', async () => {
  const { g } = newGame();
  assert.equal(g.phase, 'roulette');
  assert.deepEqual([...g.order].sort(), g.players.map((p) => p.id).sort());
  startTalk(g);
  const spoken = [];
  while (g.phase === 'intro') {
    const a = currentActor(g);
    spoken.push(a.id);
    if (a.type === 'ai') await advance(g);
    else humanSpeak(g, a.id, 'こんにちは');
  }
  assert.deepEqual(spoken, g.order);
  assert.equal(g.phase, 'qa');
  assert.ok(g.log.every((l) => l.turn === 1 && l.kind === 'say'));
});

test('2ターン目: 順番に1人へ質問し、聞かれた人が答える', async () => {
  const { g } = newGame();
  await playTurns12(g);
  const qa = g.log.filter((l) => l.turn === 2);
  assert.equal(qa.length, g.order.length * 2);
  for (let i = 0; i < g.order.length; i++) {
    const q = qa[i * 2];
    const a = qa[i * 2 + 1];
    assert.equal(q.kind, 'question');
    assert.equal(q.playerId, g.order[i]);
    assert.equal(a.kind, 'answer');
    assert.equal(a.playerId, q.to[0]);
    assert.notEqual(q.to[0], q.playerId);
  }
  assert.equal(g.phase, 'free');
});

test('2ターン目: 人間は自分に質問できず、質問の番に回答はできない', async () => {
  let found = false;
  for (let seed = 1; seed < 40 && !found; seed++) {
    const { g } = newGame({ seed });
    startTalk(g);
    while (g.phase === 'intro') {
      const a = currentActor(g);
      if (a.type === 'ai') await advance(g); else humanSpeak(g, a.id, 'x');
    }
    while (g.phase === 'qa') {
      const a = currentActor(g);
      if (a.id === 'h1' && g.qa.step === 'ask') {
        found = true;
        assert.throws(() => humanAsk(g, 'h1', 'h1', '質問'));
        assert.throws(() => humanSpeak(g, 'h1', '答え'));
        humanAsk(g, 'h1', 'ai2', 'ミオはいつそれを使う？');
        assert.equal(currentActor(g).id, 'ai2');
        break;
      }
      if (a.type === 'ai') await advance(g); else humanSpeak(g, a.id, '答え');
    }
  }
  assert.ok(found);
});

test('呼びかけの解析: @名前・複数・@all・音声向けの名前呼び', () => {
  const players = [{ id: 'h1', name: 'あなた' }, { id: 'ai1', name: 'ハル' }, { id: 'ai2', name: 'ミオ' }, { id: 'ai3', name: 'ハルカ' }];
  assert.deepEqual(parseMentions('@ハル どう思う？', players, 'h1'), { all: false, ids: ['ai1'] });
  assert.deepEqual(parseMentions('@ハルカ と @ミオ に聞きたい', players, 'h1').ids.sort(), ['ai2', 'ai3']);
  assert.equal(parseMentions('@all みんなは？', players, 'h1').all, true);
  assert.equal(parseMentions('＠全員 聞いて', players, 'h1').all, true);
  assert.equal(parseMentions('みんな、どう思う？', players, 'h1').all, true);
  assert.equal(parseMentions('みんなが好きなもの', players, 'h1').all, false);
  assert.deepEqual(parseMentions('ミオはどう？', players, 'h1').ids, ['ai2']);
  assert.deepEqual(parseMentions('@ハル', players, 'ai1').ids, []);
});

test('3ターン目: 人間に呼ばれた AI が最優先で、1人ずつ答える', async () => {
  const ai = fakeAI({ freeSpeech: (p) => `${p.name}です` });
  const { g, c } = newGame({ ai });
  await playTurns12(g);
  c.add(FREE_TALK.minGapMs);
  humanSay(g, 'h1', '@ミオ @ソラ どう思う？');
  assert.deepEqual(g.free.queue.map((q) => q.aiId), ['ai2', 'ai3']);
  const first = await tickFree(g);
  assert.equal(first.playerId, 'ai2');
  assert.equal(await tickFree(g), null, '間隔を空けずに次の AI は話さない');
  c.add(FREE_TALK.minGapMs);
  const second = await tickFree(g);
  assert.equal(second.playerId, 'ai3');
});

test('3ターン目: @all で AI 全員が順に答え、同時には考えない', async () => {
  const ai = fakeAI({ freeSpeech: (p) => `${p.name}の意見` });
  const { g, c } = newGame({ ai });
  await playTurns12(g);
  c.add(FREE_TALK.minGapMs);
  humanSay(g, 'h1', '@all これ冬にも使う？');
  const responders = [];
  for (let i = 0; i < 10 && responders.length < 3; i++) {
    const p = tickFree(g);
    assert.equal(await tickFree(g), null, '考え中は次を始めない');
    const e = await p;
    if (e) responders.push(e.playerId);
    c.add(FREE_TALK.minGapMs);
  }
  assert.deepEqual([...responders].sort(), ['ai1', 'ai2', 'ai3']);
});

test('3ターン目: 混雑対策（AI 同士の連鎖の深さ・1人あたりの回数・列の長さ）', async () => {
  // どの AI も毎回ほかの AI を呼ぶ「おしゃべり」設定でも、際限なく続かない
  const ai = fakeAI({ freeSpeech: (p) => (p.id === 'ai1' ? '@ミオ どう？' : p.id === 'ai2' ? '@ソラ は？' : '@ハル ね？') });
  const { g, c } = newGame({ ai });
  await playTurns12(g);
  const start = g.log.length;
  let maxQueue = 0;
  await runFree(g, c, { stepMs: 500, onStep: () => { maxQueue = Math.max(maxQueue, g.free?.queue.length || 0); } });
  const free = g.log.slice(start);
  const per = {};
  for (const l of free) per[l.playerId] = (per[l.playerId] || 0) + 1;
  for (const n of Object.values(per)) assert.ok(n <= FREE_TALK.maxPerAi, `1人 ${n} 回`);
  assert.ok(maxQueue <= FREE_TALK.maxQueue);
  // 連続する AI 発言の間隔は minGapMs 以上
  const times = ai.calls.filter((x) => x.task.kind === 'free').length;
  assert.ok(times <= Math.ceil(FREE_TALK.durationMs / FREE_TALK.minGapMs) + 1, `呼び出し ${times} 回`);
  assert.equal(g.phase, 'voting');
});

test('3ターン目: 誰も話さないと AI が話題を振る / 1分で投票へ', async () => {
  const { g, c } = newGame();
  await playTurns12(g);
  const start = g.log.length;
  c.add(FREE_TALK.idleMs - 1);
  await tickFree(g);
  assert.equal(g.log.length, start, 'まだ静か');
  c.add(2);
  const e = await tickFree(g);
  assert.ok(e && e.kind === 'free');
  c.add(FREE_TALK.durationMs);
  await tickFree(g);
  assert.equal(g.phase, 'voting');
  assert.throws(() => humanSay(g, 'h1', 'まだ話したい'));
});

test('3ターン目: 終了間際に考え始めた発言は猶予を過ぎたら捨てる', async () => {
  const c = clock();
  let release;
  const ai = {
    ...fakeAI(),
    aiTurn: (p, view, task) => (task.kind === 'free' ? new Promise((r) => { release = () => r({ speech: '遅れた発言', suspicions: {}, strategy: '', source: 'llm' }); }) : fakeAI().aiTurn(p, view, task)),
  };
  const g = createGame(CONFIG, { rng: seeded(3), ai, now: c.now, autoTick: false });
  await playTurns12(g);
  c.add(FREE_TALK.durationMs - 100);
  humanSay(g, 'h1', '@ハル 最後にひとこと');
  g.free.lastAiCallAt = 0;
  const p = tickFree(g);
  c.add(100 + FREE_TALK.graceMs + 1);
  release();
  assert.equal(await p, null);
  assert.ok(!g.log.some((l) => l.text === '遅れた発言'));
});

test('情報漏洩: 終了前の公開状態にお題・ウルフ・AIの推理が含まれない', async () => {
  const { g, c } = newGame();
  await playTurns12(g);
  for (const st of [publicState(g)]) {
    const json = JSON.stringify(st);
    assert.ok(!json.includes(g.topic.majority.word));
    assert.ok(!json.includes(g.topic.minority.word));
    for (const k of ['wolfId', 'thoughts', 'words', 'topic', 'memory']) assert.ok(!(k in st), k);
  }
  await runFree(g, c);
  assert.ok(!JSON.stringify(publicState(g)).includes(g.topic.minority.word));
});

test('情報漏洩: AI に渡す view には自分のお題しか入らない', async () => {
  const ai = fakeAI();
  const { g, c } = newGame({ ai, seed: 5 });
  await playTurns12(g);
  humanSay(g, 'h1', '@all どう？');
  await runFree(g, c);
  await humanVote(g, 'h1', g.candidates.find((id) => id !== 'h1'));
  assert.ok(ai.calls.length > 10);
  for (const { id, view } of ai.calls) {
    const self = g.players.find((p) => p.id === id);
    assert.equal(view.self.word, self.word);
    const other = self.word === g.topic.majority.word ? g.topic.minority.word : g.topic.majority.word;
    assert.ok(!JSON.stringify(view).includes(other), '他人のお題が view に含まれている');
    assert.ok(!('wolfId' in view));
  }
  assert.deepEqual(aiView(g, g.players.find((p) => p.id === 'ai2')).memory, g.memory.ai2);
});

test('お題確認は人間だけ', () => {
  const { g } = newGame();
  assert.equal(wordFor(g, 'h1'), g.players[0].word);
  assert.throws(() => wordFor(g, 'ai1'));
});

async function toVoting(opts) {
  const { g, c } = newGame(opts);
  await playTurns12(g);
  await runFree(g, c, { stepMs: 2000 });
  assert.equal(g.phase, 'voting');
  return g;
}

test('4ターン目: ウルフ以外を追放するとウルフの勝ち', async () => {
  let innocent;
  const ai = fakeAI({ voteFor: (p, c) => (p.id === innocent ? c.find((id) => id !== p.id) : innocent) });
  const { g: probe } = newGame({ ai });
  innocent = probe.players.find((p) => p.id !== probe.wolfId && p.id !== 'h1').id;
  const g = await toVoting({ ai });
  await humanVote(g, 'h1', innocent);
  assert.equal(g.phase, 'finished');
  assert.equal(g.result.expelledId, innocent);
  assert.equal(g.result.winner, 'wolf');
  assert.ok(publicState(g).thoughts.ai1.some((t) => t.kind === 'vote'));
});

test('ウルフ(AI)が見破られ、逆予測に失敗すれば多数派の勝ち / 成功すれば逆転勝利', async () => {
  for (const guessRight of [false, true]) {
    let g;
    const ai = fakeAI({
      voteFor: (p, c) => (p.id === g.wolfId ? c.find((id) => id !== p.id) : g.wolfId),
      guess: () => (guessRight ? g.topic.majority.word : 'ちがう'),
    });
    let seed = 1;
    for (; ; seed++) {
      const { g: probe } = newGame({ seed });
      if (probe.wolfId !== 'h1') break;
    }
    g = await toVoting({ ai, seed });
    await humanVote(g, 'h1', g.wolfId);
    assert.equal(g.phase, 'finished');
    assert.equal(g.result.expelledId, g.wolfId);
    assert.equal(g.result.winner, guessRight ? 'wolf' : 'citizens');
  }
});

test('人間ウルフが見破られたら、投票結果が公開され逆予測できる', async () => {
  let seed = 1;
  for (; ; seed++) if (newGame({ seed }).g.wolfId === 'h1') break;
  const ai = fakeAI({ voteFor: () => 'h1' });
  const g = await toVoting({ ai, seed });
  await humanVote(g, 'h1', 'ai1');
  assert.equal(g.phase, 'guess');
  const st = publicState(g);
  assert.equal(st.guesserId, 'h1');
  assert.ok(st.voteHistory.length === 1);
  assert.throws(() => humanGuess(g, 'ai1', 'x'));
  humanGuess(g, 'h1', ` ${g.topic.majority.word} `);
  assert.equal(g.result.winner, 'wolf');
});

test('同票なら決選投票、それでも同票なら追放なしでウルフの勝ち', async () => {
  const cfg = { humans: [{ name: 'A' }, { name: 'B' }], ais: CONFIG.ais.slice(0, 2) };
  const plan = { ai1: 'ai2', ai2: 'ai1' };
  const ai = fakeAI({ voteFor: (p) => plan[p.id] });
  const g = await toVoting({ ai, config: cfg, seed: 9 });
  await humanVote(g, 'h1', 'ai1');
  assert.equal(g.phase, 'voting');
  await humanVote(g, 'h2', 'ai2');
  assert.equal(g.voteRound, 2);
  assert.deepEqual([...g.candidates].sort(), ['ai1', 'ai2']);
  await assert.rejects(humanVote(g, 'h1', 'h2'));
  await humanVote(g, 'h1', 'ai1');
  await humanVote(g, 'h2', 'ai2');
  assert.equal(g.phase, 'finished');
  assert.equal(g.result.expelledId, null);
  assert.equal(g.result.winner, 'wolf');
});

test('不正な操作を弾く', async () => {
  const { g } = newGame();
  await assert.rejects(advance(g));
  await assert.rejects(humanVote(g, 'h1', 'ai1'));
  assert.throws(() => humanSay(g, 'h1', 'まだ'));
  assert.throws(() => createGame({ ...CONFIG, humans: [] }));
  assert.throws(() => createGame({ ...CONFIG, humans: [{ name: 'ハル' }] }));
  assert.throws(() => createGame({ ...CONFIG, humans: [{ name: '@me' }] }));
  assert.throws(() => createGame({ ...CONFIG, ais: CONFIG.ais.slice(0, 1) }));
});

test('オフライン AI だけで最後まで遊べる（お題そのものは言わない）', async () => {
  const c = clock();
  const g = createGame(CONFIG, { rng: seeded(21), now: c.now, autoTick: false });
  await playTurns12(g);
  humanSay(g, 'h1', '@all どんなときに使う？');
  await runFree(g, c);
  while (g.phase === 'voting') await humanVote(g, 'h1', g.candidates.find((id) => id !== 'h1'));
  if (g.phase === 'guess') humanGuess(g, 'h1', 'なにか');
  assert.equal(g.phase, 'finished');
  assert.ok(g.log.filter((l) => l.turn === 3).length >= 4);
  for (const l of g.log) {
    const p = g.players.find((x) => x.id === l.playerId);
    if (p.type === 'ai') assert.ok(!l.text.includes(p.word), `AIがお題を言った: ${l.text}`);
  }
});

test('JSON パースと疑い度の整形', () => {
  assert.deepEqual(parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonLoose('はい。{"a":2} 以上'), { a: 2 });
  const view = { self: { id: 'ai1' }, players: [{ id: 'h1' }, { id: 'ai1' }, { id: 'ai2' }] };
  const s = sanitizeSuspicions({ h1: 3, ai1: 0.9, ai2: 1, bogus: 1 }, view);
  assert.deepEqual(Object.keys(s).sort(), ['ai2', 'h1']);
  assert.deepEqual(sanitizeSuspicions(null, view), { h1: 0.5, ai2: 0.5 });
});

test('お題の表記ゆれを吸収する', () => {
  assert.equal(normalizeWord('「プール」'), normalizeWord('ぷーる'));
  assert.equal(normalizeWord('ＰＣ'), normalizeWord('pc'));
});

test('3ターン目: API の回数上限で呼べない AI は後回しにし、呼べる AI が先に話す', async () => {
  const blocked = new Set(['ai2']);
  const ai = { ...fakeAI(), readyIn: (p) => (blocked.has(p.id) ? 5000 : 0) };
  const { g, c } = newGame({ ai });
  await playTurns12(g);
  c.add(FREE_TALK.minGapMs);
  humanSay(g, 'h1', '@ミオ @ソラ どう？');
  const first = await tickFree(g);
  assert.equal(first.playerId, 'ai3');
  assert.deepEqual(g.free.queue.map((q) => q.aiId), ['ai2'], 'ミオは列に残る');
  blocked.clear();
  c.add(FREE_TALK.minGapMs);
  assert.equal((await tickFree(g)).playerId, 'ai2');
});

test('3ターン目: 回数の枠が少ないときは間隔を広げ、枠がなければ人間に呼ばれた分だけ答える', async () => {
  let cap = 4 + 4; // 予約(AI3人+逆予測1)を除くと 4回分
  const ai = { ...fakeAI(), capacity: () => cap };
  const { g, c } = newGame({ ai });
  await playTurns12(g);
  // 残り60秒で4回 → 15秒に1回まで
  c.add(FREE_TALK.idleMs);
  assert.ok(await tickFree(g), '最初の1回');
  g.free.lastAiCallAt = c.now();
  c.add(10_000);
  g.free.lastMsgAt = 0;
  assert.equal(await tickFree(g), null, '15秒たつまで次は呼ばない');
  c.add(6_000);
  assert.ok(await tickFree(g));
  cap = 4; // 予約分しか残っていない
  c.add(30_000);
  g.free.lastMsgAt = 0;
  assert.equal(await tickFree(g), null, '話題振りはしない');
  humanSay(g, 'h1', '@ハル 最後に聞かせて');
  assert.equal((await tickFree(g))?.playerId, 'ai1', '人間に呼ばれたら答える');
});
