// API なしで動くルールベースの AI。
// LLM 版と同じく「自分のお題」と「公開ログ」だけを見て判断する（他人のお題は見ない）。
import { hintsFor, allWords } from './topics.js';

const INTRO = [
  (h) => `${h}って感じがするよね。`,
  (h) => `わたしは${h}を思い浮かべたかな。`,
  (h) => `${h}が好きな人は多そう。`,
];
const QUESTIONS = [
  (h) => `${h}って聞いて、どう思う？`,
  () => 'それって、一年のうちいつごろ楽しむもの？',
  () => '最近それに関わったのはいつ？',
  () => 'それって、ひとりでも楽しめる？',
];
const ANSWERS = [
  (h) => `うーん、${h}のイメージかな。`,
  (h) => `${h}と関係あると思うよ。`,
  () => '人によると思うけど、わたしはわりと好きだよ。',
];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/** 公開ログから、自分のお題の連想語との一致度で疑い度を出す。 */
export function mockSuspicions(view) {
  const hints = hintsFor(view.self.word);
  const raw = {};
  for (const p of view.players.filter((x) => x.id !== view.self.id)) {
    const lines = view.log.filter((l) => l.playerId === p.id).map((l) => l.text);
    const matches = lines.reduce((n, t) => n + hints.filter((h) => t.includes(h)).length, 0);
    raw[p.id] = (lines.length === 0 ? 0.5 : 1 / (1 + matches * 1.5)) + Math.random() * 0.25;
  }
  return normalize(raw);
}

export function normalize(raw) {
  const sum = Object.values(raw).reduce((a, b) => a + b, 0) || 1;
  const out = {};
  for (const [k, v] of Object.entries(raw)) out[k] = Math.round((v / sum) * 100) / 100;
  return out;
}

function topSuspect(s) {
  return Object.entries(s).sort((a, b) => b[1] - a[1])[0]?.[0];
}

function freshHint(view) {
  const used = view.log.filter((l) => l.playerId === view.self.id).map((l) => l.text).join(' ');
  const hints = hintsFor(view.self.word).filter((h) => !used.includes(h));
  return hints.length ? pick(hints) : pick(hintsFor(view.self.word).length ? hintsFor(view.self.word) : ['それ']);
}

export function mockTurn(view, task) {
  const suspicions = mockSuspicions(view);
  const suspectId = topSuspect(suspicions);
  const suspect = view.players.find((p) => p.id === suspectId);
  const h = freshHint(view);
  let speech;
  let to;
  if (task.kind === 'intro') speech = pick(INTRO)(h);
  else if (task.kind === 'ask') { speech = pick(QUESTIONS)(h); to = suspectId; }
  else speech = pick(ANSWERS)(h);
  return {
    speech,
    ...(to ? { to } : {}),
    suspicions,
    strategy: suspect ? `自分のお題「${view.self.word}」の連想語が少ない${suspect.name}を警戒` : '様子見',
    wolfSelf: 0.3,
  };
}

export function mockVote(view, candidates) {
  const s = mockSuspicions(view);
  const target = candidates.filter((id) => id !== view.self.id).sort((a, b) => (s[b] ?? 0) - (s[a] ?? 0))[0];
  const name = view.players.find((p) => p.id === target)?.name;
  return { vote: target, reason: `${name}さんの発言が自分のお題と一番かみ合わなかったから`, suspicions: s };
}

/** 見破られたウルフとして多数派のお題を当てる。辞書の連想語と他人の発言の一致で推定。 */
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
