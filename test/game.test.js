import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame, startTalk, advance, humanSpeak, humanAsk, humanVote, humanGuess,
  publicState, aiView, currentActor, wordFor, normalizeWord, QA_ROUNDS,
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


/** 呼ばれ方を記録する偽 AI。 */
function fakeAI({ voteFor = (p, c) => c.find((id) => id !== p.id), guess = 'はずれ' } = {}) {
  const calls = [];
  return {
    calls,
    async aiTurn(p, view, task) {
      calls.push({ id: p.id, view, task });
      const others = view.players.filter((x) => x.id !== p.id).map((x) => x.id);
      const speech = `${p.name}の${task.kind}`;
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
  const g = createGame(opts.config || CONFIG, { rng: seeded(opts.seed || 3), ai: opts.ai || fakeAI() });
  return { g };
}

/** 1〜3ターン目を最後まで進める（そのあと投票になる）。 */
async function playTurns(g) {
  startTalk(g);
  while (g.phase === 'intro' || g.phase === 'qa') {
    const a = currentActor(g);
    if (a.type === 'ai') await advance(g);
    else if (g.phase === 'qa' && g.qa.step === 'ask') humanAsk(g, a.id, g.order.find((id) => id !== a.id), 'それっていつ使う？');
    else humanSpeak(g, a.id, '夏っぽいよね');
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

test('2・3ターン目: 質問を2周。順番に1人へ質問し、聞かれた人が答え、そのあと投票', async () => {
  const ai = fakeAI();
  const { g } = newGame({ ai });
  await playTurns(g);
  for (const turn of [2, 3]) {
    const qa = g.log.filter((l) => l.turn === turn);
    assert.equal(qa.length, g.order.length * 2, `${turn}ターン目`);
    for (let i = 0; i < g.order.length; i++) {
      const q = qa[i * 2];
      const a = qa[i * 2 + 1];
      assert.equal(q.kind, 'question');
      assert.equal(q.playerId, g.order[i]);
      assert.equal(a.kind, 'answer');
      assert.equal(a.playerId, q.to[0]);
      assert.notEqual(q.to[0], q.playerId);
    }
  }
  assert.equal(QA_ROUNDS, 2);
  assert.equal(g.log.filter((l) => l.turn > 3).length, 0);
  assert.equal(g.phase, 'voting');
  assert.equal(publicState(g).turn, 4);
  // AI には何周目の質問かが伝わる
  const rounds = ai.calls.filter((c) => c.task.kind === 'ask').map((c) => [c.task.round, c.view.turn]);
  assert.ok(rounds.some(([r, t]) => r === 1 && t === 2));
  assert.ok(rounds.some(([r, t]) => r === 2 && t === 3));
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

test('情報漏洩: 終了前の公開状態にお題・ウルフ・AIの推理が含まれない', async () => {
  const { g } = newGame();
  const check = () => {
    const st = publicState(g);
    const json = JSON.stringify(st);
    assert.ok(!json.includes(g.topic.majority.word), g.phase);
    assert.ok(!json.includes(g.topic.minority.word), g.phase);
    for (const k of ['wolfId', 'thoughts', 'words', 'topic', 'memory']) assert.ok(!(k in st), k);
  };
  check();
  await playTurns(g);
  check();
});

test('情報漏洩: AI に渡す view には自分のお題しか入らない', async () => {
  const ai = fakeAI();
  const { g } = newGame({ ai, seed: 5 });
  await playTurns(g);
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
  const { g } = newGame(opts);
  await playTurns(g);
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
  assert.throws(() => createGame({ ...CONFIG, humans: [] }));
  assert.throws(() => createGame({ ...CONFIG, humans: [{ name: 'ハル' }] }));
  assert.throws(() => createGame({ ...CONFIG, ais: CONFIG.ais.slice(0, 1) }));
});

test('オフライン AI だけで最後まで遊べる（お題そのものは言わない）', async () => {
  const g = createGame(CONFIG, { rng: seeded(21) });
  await playTurns(g);
  while (g.phase === 'voting') await humanVote(g, 'h1', g.candidates.find((id) => id !== 'h1'));
  if (g.phase === 'guess') humanGuess(g, 'h1', 'なにか');
  assert.equal(g.phase, 'finished');
  assert.equal(g.log.filter((l) => l.turn === 3).length, g.order.length * 2);
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

