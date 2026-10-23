// AI プレイヤーの頭脳。各 AI には「自分のお題・公開ログ・性格・自分の過去の推理」だけを渡す。
// 他プレイヤーのお題やウルフの正体は view に含まれないので、構造的に漏れない。
import { complete, readyIn as providerReadyIn, capacityAt } from './providers.js';
import { mockTurn, mockVote, mockGuess, normalize } from './mockAI.js';

export const PERSONALITIES = {
  analyst: { label: '慎重・分析型', prompt: '慎重で論理的。発言の矛盾を静かに指摘する。自分からは情報を出しすぎない。' },
  questioner: { label: '積極・質問型', prompt: '好奇心旺盛で積極的。他のプレイヤーに具体的な質問をぶつけて反応を探る。' },
  trickster: { label: '直感・攪乱型', prompt: '直感で動き、ときどき場をかき回す。わざと曖昧なことを言ったり、意外な人を疑ったりする。' },
  cheerful: { label: '陽気・天然型', prompt: '明るくおしゃべり。思ったことをすぐ口にするが、意外と鋭い。' },
  cynic: { label: '皮肉屋', prompt: '少し皮肉っぽく、人の発言を疑ってかかる。でも根拠はちゃんと述べる。' },
};

const KIND_LABEL = { say: '一言', question: '質問', answer: '回答', free: '自由会話' };

function describePlayers(view) {
  return view.players
    .map((p) => `- ${p.name} (id: ${p.id}${p.human ? '・人間' : ''})${p.id === view.self.id ? ' ← あなた' : ''}`)
    .join('\n');
}

function describeLog(view) {
  if (view.log.length === 0) return '（まだ誰も発言していません）';
  return view.log.map((l) => {
    const to = l.to?.length ? ` → ${l.to.map((id) => (id === 'all' ? '全員' : view.players.find((p) => p.id === id)?.name || id)).join('・')}` : '';
    return `[${l.turn}ターン目・${KIND_LABEL[l.kind] || ''}] ${l.name}${to}: ${l.text}`;
  }).join('\n');
}

function systemPrompt(view) {
  const persona = PERSONALITIES[view.self.personality] || PERSONALITIES.analyst;
  return `あなたはワードウルフというゲームのプレイヤー「${view.self.name}」です。

# ルール
- 全員にお題（単語）が配られる。多数派は同じお題、1人だけ「ウルフ」として似ているが違うお題を持つ。
- 誰がウルフか、自分がウルフかどうかは誰にも知らされていない。あなた自身がウルフの可能性もある。
- 1ターン目: 順番に一言ずつ。2ターン目: 順番に、誰か1人へ質問し、相手が答える。3ターン目: 1分間の自由会話（@名前で呼びかけ、@allで全員）。4ターン目: 全員一斉投票。
- 最多票の人が追放される。ウルフが追放されれば多数派の勝ち、そうでなければウルフの勝ち。
- ウルフが追放されても、多数派のお題を当てればウルフの逆転勝ち。

# あなたの情報
- あなたのお題: 「${view.self.word}」
- 性格: ${persona.label} — ${persona.prompt}

# 心得
- お題の単語そのもの（「${view.self.word}」）は絶対に口にしない。
- 具体的すぎるとウルフにお題がばれる。抽象的すぎると自分が疑われる。そのバランスを取る。
- 他の人の発言が自分のお題とかみ合わなければ、自分がウルフの可能性も考え、周りに話を合わせる。
- 日本語の話し言葉で、性格に合った口調で話す。
- 出力は指定された JSON のみ。説明文やコードブロックは付けない。

# プレイヤー
${describePlayers(view)}`;
}

function memoryText(view) {
  if (!view.memory) return 'まだありません。';
  return `前回のあなたの作戦: ${view.memory.strategy}\n前回の疑い度: ${JSON.stringify(view.memory.suspicions)}`;
}

function otherIds(view) {
  return view.players.filter((p) => p.id !== view.self.id).map((p) => p.id);
}

function suspicionExample(view) {
  const ids = otherIds(view);
  return JSON.stringify(Object.fromEntries(ids.map((id) => [id, Number((1 / ids.length).toFixed(2))])));
}

function taskText(view, task) {
  switch (task.kind) {
    case 'intro':
      return '1ターン目、あなたの番です。お題について「一言」だけ話してください（1文、40文字程度まで）。';
    case 'ask':
      return `2ターン目、あなたが質問する番です。他のプレイヤーから1人選び、その人がウルフかどうか探れる質問を1つしてください（1文、50文字程度まで）。
質問相手の id を "to" に入れてください。候補: ${otherIds(view).join(', ')}`;
    case 'answer':
      return `2ターン目。${task.fromName} さんからあなたへの質問です:「${task.question}」
これに答えてください（1〜2文、50文字程度まで）。`;
    case 'free': {
      const why = {
        mention: `${task.fromName} さんがあなたを呼びました:「${task.triggerText}」 これに答えてください。`,
        all: `${task.fromName} さんが全員に呼びかけました:「${task.triggerText}」 あなたも答えてください。`,
        reply: `${task.fromName} さんの発言:「${task.triggerText}」 に反応してください。`,
        idle: '会話が少し止まっています。誰か1人を @名前 で呼んで、話を振ってください。',
      }[task.reason] || '';
      return `3ターン目の自由会話中です（残り約${task.remainingSec}秒）。
${why}
- 短く1文、40文字程度まで。チャットのテンポで。
- 誰かに聞きたいときは発言の中に「@名前」と書く（例: @${view.players.find((p) => p.id !== view.self.id)?.name}。id ではなく名前で。全員なら @all）。呼ぶのは多くても1人。毎回呼ぶ必要はない。
- 呼ばれていない話に割り込みすぎない。`;
    }
    default:
      return '';
  }
}

function turnPrompt(view, task) {
  const toField = task.kind === 'ask' ? '\n  "to": "質問相手のid",' : '';
  return `# これまでの会話
${describeLog(view)}

# あなたの以前の推理（他の人には見えない）
${memoryText(view)}

# 今やること
${taskText(view, task)}

次の形式の JSON で答えてください。
{${toField}
  "speech": "みんなに見える発言",
  "suspicions": ${suspicionExample(view)},
  "strategy": "次の狙い（非公開・短く）",
  "wolf_self": 0.0〜1.0 （自分がウルフだと思う確率）
}
suspicions は他プレイヤー全員の id をキーにし、それぞれがウルフだと思う度合いを合計1になるように。`;
}

function votePrompt(view, candidates) {
  const list = candidates.filter((id) => id !== view.self.id);
  return `# 会話ログ
${describeLog(view)}

# あなたの以前の推理（非公開）
${memoryText(view)}

4ターン目、全員一斉投票です。ウルフだと思う人を、次の候補から1人選んでください（自分には投票できません）。
候補: ${list.join(', ')}
次の形式の JSON で答えてください。
{ "vote": "候補のid", "reason": "理由（1文）", "suspicions": { "id": 確率, ... } }`;
}

function guessPrompt(view) {
  return `# 会話ログ
${describeLog(view)}

あなたはウルフだと見破られました。あなたのお題「${view.self.word}」は少数派でした。
会話から多数派のお題を推理して当ててください。当たれば逆転勝利です。
次の形式の JSON で答えてください。
{ "guess": "多数派のお題（単語）", "reason": "理由（1文）" }`;
}

/** LLM の出力から最初の JSON オブジェクトを取り出す。 */
export function parseJsonLoose(text) {
  if (!text) throw new Error('空の応答');
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error(`JSON を解釈できません: ${cleaned.slice(0, 120)}`);
  }
}

/** 疑い度を「他プレイヤーの id のみ・0〜1・合計1」に整える。 */
export function sanitizeSuspicions(raw, view) {
  const ids = otherIds(view);
  const out = {};
  for (const id of ids) {
    const v = Number(raw?.[id]);
    out[id] = Number.isFinite(v) && v > 0 ? Math.min(v, 1) : 0;
  }
  if (Object.values(out).every((v) => v === 0)) for (const id of ids) out[id] = 1;
  return normalize(out);
}

function maskWord(text, word) {
  return word ? text.split(word).join('〇〇') : text;
}

function clip(text, max = 120) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

async function askLLM(player, system, user, opts = {}) {
  const text = await complete(player.provider, { model: player.model, system, user, ...opts });
  return parseJsonLoose(text);
}

/** この AI がいま API を呼べるまでの待ち時間（ms）。自由会話で、呼べない AI を後回しにするのに使う。 */
export function readyIn(player) {
  return player.provider === 'mock' ? 0 : providerReadyIn(player.provider);
}

/** untilTs の時点で、この AI の API にあと何回分の枠があるか。 */
export function capacity(player, untilTs) {
  return player.provider === 'mock' ? Infinity : capacityAt(player.provider, untilTs);
}

/** 「@ai2」のような id での呼びかけを「@ミオ」に直す。 */
function idsToNames(text, view) {
  let t = text;
  for (const p of [...view.players].sort((a, b) => b.id.length - a.id.length)) t = t.split(`@${p.id}`).join(`@${p.name}`);
  return t;
}

/**
 * 1回分の行動（一言・質問・回答・自由会話）。
 * 返り値: { speech, to?, suspicions, strategy, wolfSelf, source, error? }
 * 自由会話で API が失敗したときは、オフライン発言で埋めずに { skip: true } を返す（会話が不自然にならないように）。
 */
export async function aiTurn(player, view, task) {
  if (player.provider === 'mock') return { ...mockTurn(view, task), source: 'mock' };
  const free = task.kind === 'free';
  try {
    const opts = free ? { timeoutMs: task.timeoutMs || 12000, retry429: false, maxWaitMs: 1500 } : {};
    const out = await askLLM(player, systemPrompt(view), turnPrompt(view, task), opts);
    const speech = clip(maskWord(idsToNames(String(out.speech || ''), view), view.self.word), free ? 80 : 120);
    if (!speech) throw new Error('発言が空でした');
    const result = {
      speech,
      suspicions: sanitizeSuspicions(out.suspicions, view),
      strategy: clip(out.strategy, 200),
      wolfSelf: Math.max(0, Math.min(1, Number(out.wolf_self) || 0)),
      source: 'llm',
    };
    if (task.kind === 'ask') {
      const others = otherIds(view);
      result.to = others.includes(out.to) ? out.to : others[Math.floor(Math.random() * others.length)];
    }
    return result;
  } catch (e) {
    if (free) return { skip: true, source: 'fallback', error: e.message, suspicions: view.memory?.suspicions || {}, strategy: '' };
    return { ...mockTurn(view, task), source: 'fallback', error: e.message };
  }
}

export async function aiVote(player, view, candidates) {
  const valid = candidates.filter((id) => id !== view.self.id);
  if (player.provider !== 'mock') {
    try {
      const out = await askLLM(player, systemPrompt(view), votePrompt(view, candidates));
      const vote = String(out.vote || '').trim();
      if (valid.includes(vote)) {
        return { vote, reason: clip(out.reason, 200), suspicions: sanitizeSuspicions(out.suspicions, view), source: 'llm' };
      }
      throw new Error(`無効な投票先: ${vote}`);
    } catch (e) {
      return { ...mockVote(view, valid), source: 'fallback', error: e.message };
    }
  }
  return { ...mockVote(view, valid), source: 'mock' };
}

export async function aiGuess(player, view) {
  if (player.provider !== 'mock') {
    try {
      const out = await askLLM(player, systemPrompt(view), guessPrompt(view));
      if (out.guess) return { guess: clip(out.guess, 30), reason: clip(out.reason, 200), source: 'llm' };
      throw new Error('guess がありません');
    } catch (e) {
      return { ...mockGuess(view), source: 'fallback', error: e.message };
    }
  }
  return { ...mockGuess(view), source: 'mock' };
}
