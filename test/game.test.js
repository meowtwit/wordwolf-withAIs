import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame, advance, humanSpeak, humanVote, humanGuess, publicState, aiView, currentSpeaker, wordFor, normalizeWord,
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
    { name: 'AI 01', personality: 'analyst', provider: 'mock' },
    { name: 'AI 02', personality: 'questioner', provider: 'mock' },
    { name: 'AI 03', personality: 'trickster', provider: 'mock' },
  ],
  rounds: 2,
};

/** 投票先を指定できる偽 AI。受け取った view を記録する。 */
function fakeAI({ voteFor, guess } = {}) {
  const views = [];
  return {
    views,
    async aiSpeak(p, view) {
      views.push(view);
      return { speech: `${p.name}の発言${view.log.length}`, suspicions: {}, strategy: 's', wolfSelf: 0.2, source: 'llm' };
    },
    async aiVote(p, view, candidates) {
      views.push(view);
      const target = voteFor(p, candidates);
      return { vote: target, reason: 'r', suspicions: {}, source: 'llm' };
    },
    async aiGuess(p, view) {
      views.push(view);
      return { guess: guess ?? 'はずれ', reason: 'g', source: 'llm' };
    },
  };
}

async function playDiscussion(game) {
  while (game.phase === 'discussion') {
    const sp = currentSpeaker(game);
    if (sp.type === 'ai') await advance(game);
    else humanSpeak(game, sp.id, 'なんとなく夏っぽいよね');
  }
}

test('お題: ウルフ1人だけが少数派のお題を持つ', () => {
  for (let seed = 1; seed < 30; seed++) {
    const g = createGame(CONFIG, { rng: seeded(seed) });
    const wolves = g.players.filter((p) => p.word === g.topic.minority.word);
    assert.equal(wolves.length, 1);
    assert.equal(wolves[0].id, g.wolfId);
    assert.notEqual(g.topic.majority.word, g.topic.minority.word);
  }
});

test('情報漏洩: 終了前の公開状態にお題・ウルフ・AIの推理が含まれない', async () => {
  const g = createGame(CONFIG, { rng: seeded(3), ai: fakeAI({ voteFor: (p, c) => c.find((id) => id !== p.id) }) });
  await playDiscussion(g);
  const json = JSON.stringify(publicState(g));
  assert.ok(!json.includes(g.topic.majority.word));
  assert.ok(!json.includes(g.topic.minority.word));
  for (const k of ['wolfId', 'thoughts', 'words', 'topic', 'memory']) assert.ok(!(k in publicState(g)), k);
});

test('情報漏洩: AI に渡す view には自分のお題しか入らない', async () => {
  const ai = fakeAI({ voteFor: (p, c) => c.find((id) => id !== p.id) });
  const g = createGame(CONFIG, { rng: seeded(5), ai });
  await playDiscussion(g);
  for (const v of ai.views) {
    const self = g.players.find((p) => p.id === v.self.id);
    assert.equal(v.self.word, self.word);
    const otherWord = self.word === g.topic.majority.word ? g.topic.minority.word : g.topic.majority.word;
    assert.ok(!JSON.stringify(v).includes(otherWord), '他人のお題が view に含まれている');
    assert.ok(!('wolfId' in v));
  }
  // 記憶は自分のものだけ
  const v = aiView(g, g.players.find((p) => p.id === 'ai2'));
  assert.deepEqual(v.memory, g.memory.ai2);
});

test('お題確認は人間だけ', () => {
  const g = createGame(CONFIG, { rng: seeded(2) });
  assert.equal(wordFor(g, 'h1'), g.players[0].word);
  assert.throws(() => wordFor(g, 'ai1'));
});

test('発言順: 人間の手番では AI は進めず、周回後に投票へ', async () => {
  const g = createGame(CONFIG, { rng: seeded(7), ai: fakeAI({ voteFor: (p, c) => c[0] }) });
  await playDiscussion(g);
  assert.equal(g.log.length, 2 * 4);
  assert.equal(g.phase, 'voting');
  assert.deepEqual(new Set(g.log.map((l) => l.round)), new Set([1, 2]));
});

test('ウルフ以外を追放するとウルフの勝ち', async () => {
  let g;
  let innocent;
  const ai = fakeAI({ voteFor: (p, c) => (p.id === innocent ? c.find((id) => id !== p.id) : innocent) });
  g = createGame(CONFIG, { rng: seeded(11), ai });
  innocent = g.players.find((p) => p.id !== g.wolfId && p.id !== 'h1').id;
  await playDiscussion(g);
  await humanVote(g, 'h1', innocent);
  assert.equal(g.phase, 'finished');
  assert.equal(g.result.expelledId, innocent);
  assert.equal(g.result.winner, 'wolf');
  const st = publicState(g);
  assert.equal(st.wolfId, g.wolfId);
  assert.ok(st.thoughts.ai1.length > 0);
});

test('ウルフ(AI)を追放し、逆転に失敗すれば多数派の勝ち / 成功すればウルフの勝ち', async () => {
  for (const guessRight of [false, true]) {
    let g;
    const ai = {
      ...fakeAI({ voteFor: () => null }),
      async aiVote(p, view, c) {
        const target = p.id === g.wolfId ? c.find((id) => id !== p.id) : g.wolfId;
        return { vote: target, reason: 'r', suspicions: {}, source: 'llm' };
      },
      async aiGuess() { return { guess: guessRight ? g.topic.majority.word : 'ちがう', reason: '', source: 'llm' }; },
    };
    // ウルフが AI になる seed を探す
    for (let seed = 1; ; seed++) {
      g = createGame(CONFIG, { rng: seeded(seed), ai });
      if (g.wolfId !== 'h1') break;
    }
    await playDiscussion(g);
    await humanVote(g, 'h1', g.wolfId);
    assert.equal(g.phase, 'finished');
    assert.equal(g.result.expelledId, g.wolfId);
    assert.equal(g.result.winner, guessRight ? 'wolf' : 'citizens');
  }
});

test('人間ウルフが追放されたら逆転フェーズで回答できる', async () => {
  let g;
  const ai = {
    ...fakeAI({ voteFor: () => null }),
    async aiVote() { return { vote: 'h1', reason: '', suspicions: {}, source: 'llm' }; },
  };
  for (let seed = 1; ; seed++) {
    g = createGame(CONFIG, { rng: seeded(seed), ai });
    if (g.wolfId === 'h1') break;
  }
  await playDiscussion(g);
  await humanVote(g, 'h1', 'ai1');
  assert.equal(g.phase, 'guess');
  assert.equal(publicState(g).guesserId, 'h1');
  assert.throws(() => humanGuess(g, 'ai1', 'x'));
  humanGuess(g, 'h1', ` ${g.topic.majority.word} `);
  assert.equal(g.result.winner, 'wolf');
});

test('同票なら決選投票、それでも同票なら追放なしでウルフの勝ち', async () => {
  // 2人(人間) + 2 AI。h1→ai1, h2→ai2, ai1→ai2, ai2→ai1 で 2-2 の同票
  const cfg = { humans: [{ name: 'A' }, { name: 'B' }], ais: CONFIG.ais.slice(0, 2), rounds: 1 };
  const plan = { ai1: 'ai2', ai2: 'ai1' };
  const ai = {
    ...fakeAI({ voteFor: () => null }),
    async aiVote(p, view, c) { return { vote: plan[p.id], reason: '', suspicions: {}, source: 'llm' }; },
  };
  const g = createGame(cfg, { rng: seeded(9), ai });
  await playDiscussion(g);
  await humanVote(g, 'h1', 'ai1');
  assert.equal(g.phase, 'voting');
  await humanVote(g, 'h2', 'ai2');
  assert.equal(g.phase, 'voting');
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
  const g = createGame(CONFIG, { rng: seeded(4), ai: fakeAI({ voteFor: (p, c) => c[0] }) });
  await assert.rejects(humanVote(g, 'h1', 'ai1'));
  assert.throws(() => createGame({ ...CONFIG, humans: [] }));
  assert.throws(() => createGame({ ...CONFIG, humans: [{ name: 'AI 01' }] }));
  await playDiscussion(g);
  await assert.rejects(humanVote(g, 'h1', 'h1'));
});

test('オフライン AI だけで最後まで遊べる', async () => {
  const g = createGame(CONFIG, { rng: seeded(21) });
  await playDiscussion(g);
  const target = g.candidates.find((id) => id !== 'h1');
  await humanVote(g, 'h1', target);
  while (g.phase === 'voting') await humanVote(g, 'h1', g.candidates.find((id) => id !== 'h1'));
  if (g.phase === 'guess') humanGuess(g, 'h1', 'なにか');
  assert.equal(g.phase, 'finished');
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
  assert.ok(Math.abs(s.h1 + s.ai2 - 1) < 0.02);
  assert.deepEqual(sanitizeSuspicions(null, view), { h1: 0.5, ai2: 0.5 });
});

test('お題の表記ゆれを吸収する', () => {
  assert.equal(normalizeWord('「プール」'), normalizeWord('ぷーる'));
  assert.equal(normalizeWord('ＰＣ'), normalizeWord('pc'));
});
