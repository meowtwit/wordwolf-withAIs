// API なしで動くルールベースの AI。
// LLM 版と同じく「自分のお題」と「公開ログ」だけを見て判断する（他人のお題は見ない）。
import { hintsFor, allWords } from './topics.js';

const SPEECH_TEMPLATES = [
  (h) => `${h}って、なんだか関係ある気がするよね。`,
  (h) => `個人的には${h}のイメージが強いかな。`,
  (h) => `${h}を思い浮かべる人、多いんじゃない？`,
  (h) => `みんなは${h}って聞いてピンとくる？`,
  (h) => `${h}の話をすると盛り上がりそう。`,
];

const QUESTION_TEMPLATES = [
  (name) => `${name}さんの今の発言、ちょっと気になったんだけど詳しく聞きたいな。`,
  (name) => `${name}さんは、どういう時にそれを思い浮かべる？`,
  (name) => `うーん、${name}さんだけ少し方向性が違う気がする。`,
];

function pick(arr, rng) {
  return arr[Math.floor(rng() * arr.length)];
}

/** 公開ログから、自分のお題の連想語との一致度で疑い度を出す。 */
export function mockSuspicions(view, rng = Math.random) {
  const hints = hintsFor(view.self.word);
  const others = view.players.filter((p) => p.id !== view.self.id);
  const raw = {};
  for (const p of others) {
    const lines = view.log.filter((l) => l.playerId === p.id).map((l) => l.text);
    const matches = lines.reduce((n, t) => n + hints.filter((h) => t.includes(h)).length, 0);
    // 一致が少ないほど怪しい。発言がない人は平均的。
    const base = lines.length === 0 ? 0.5 : 1 / (1 + matches * 1.5);
    raw[p.id] = base + rng() * 0.25;
  }
  return normalize(raw);
}

export function normalize(raw) {
  const sum = Object.values(raw).reduce((a, b) => a + b, 0) || 1;
  const out = {};
  for (const [k, v] of Object.entries(raw)) out[k] = Math.round((v / sum) * 100) / 100;
  return out;
}

function topSuspect(suspicions) {
  return Object.entries(suspicions).sort((a, b) => b[1] - a[1])[0]?.[0];
}

export function mockSpeak(view, rng = Math.random) {
  const suspicions = mockSuspicions(view, rng);
  const used = view.log.filter((l) => l.playerId === view.self.id).map((l) => l.text).join(' ');
  const hints = hintsFor(view.self.word).filter((h) => !used.includes(h));
  const suspectId = topSuspect(suspicions);
  const suspect = view.players.find((p) => p.id === suspectId);
  let speech;
  if (view.round > 1 && suspect && rng() < 0.45) {
    speech = pick(QUESTION_TEMPLATES, rng)(suspect.name);
  } else {
    speech = pick(SPEECH_TEMPLATES, rng)(hints.length ? pick(hints, rng) : 'それ');
  }
  return {
    speech,
    suspicions,
    strategy: suspect
      ? `自分のお題「${view.self.word}」の連想語が少ない${suspect.name}を警戒`
      : '様子見',
    wolfSelf: 0.3,
  };
}

export function mockVote(view, candidates, rng = Math.random) {
  const s = mockSuspicions(view, rng);
  const target = candidates
    .filter((id) => id !== view.self.id)
    .sort((a, b) => (s[b] ?? 0) - (s[a] ?? 0))[0];
  const name = view.players.find((p) => p.id === target)?.name;
  return { vote: target, reason: `${name}さんの発言が自分のお題と一番かみ合わなかったから`, suspicions: s };
}

/** 追放されたウルフとして多数派のお題を当てる。辞書の連想語と他人の発言の一致で推定。 */
export function mockGuess(view) {
  const othersText = view.log.filter((l) => l.playerId !== view.self.id).map((l) => l.text).join(' ');
  let best = { word: view.self.word, score: -1 };
  for (const w of allWords()) {
    if (w.word === view.self.word) continue;
    const score = w.hints.filter((h) => othersText.includes(h)).length;
    if (score > best.score) best = { word: w.word, score };
  }
  return { guess: best.word, reason: '他の人の発言に出てきた言葉から連想した' };
}
