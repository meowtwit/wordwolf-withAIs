// AI プレイヤーの頭脳。各 AI には「自分のお題・公開ログ・性格・自分の過去の推理」だけを渡す。
// 他プレイヤーのお題やウルフの正体は view に含まれないので、構造的に漏れない。
import { complete } from './providers.js';
import { mockSpeak, mockVote, mockGuess, normalize } from './mockAI.js';

export const PERSONALITIES = {
  analyst: {
    label: '慎重・分析型',
    prompt: '慎重で論理的。発言の矛盾を静かに指摘する。自分からは情報を出しすぎない。',
  },
  questioner: {
    label: '積極・質問型',
    prompt: '好奇心旺盛で積極的。他のプレイヤーに具体的な質問をぶつけて反応を探る。',
  },
  trickster: {
    label: '直感・攪乱型',
    prompt: '直感で動き、ときどき場をかき回す。わざと曖昧なことを言ったり、意外な人を疑ったりする。',
  },
  cheerful: {
    label: '陽気・天然型',
    prompt: '明るくおしゃべり。思ったことをすぐ口にするが、意外と鋭い。',
  },
  cynic: {
    label: '皮肉屋',
    prompt: '少し皮肉っぽく、人の発言を疑ってかかる。でも根拠はちゃんと述べる。',
  },
};

function describePlayers(view) {
  return view.players
    .map((p) => `- ${p.name} (id: ${p.id})${p.id === view.self.id ? ' ← あなた' : ''}`)
    .join('\n');
}

function describeLog(view) {
  if (view.log.length === 0) return '（まだ誰も発言していません）';
  return view.log.map((l) => `[${l.round}周目] ${l.name}: ${l.text}`).join('\n');
}

function systemPrompt(view) {
  const persona = PERSONALITIES[view.self.personality] || PERSONALITIES.analyst;
  return `あなたはワードウルフというゲームのプレイヤー「${view.self.name}」です。

# ルール
- 全員にお題（単語）が配られる。多数派は同じお題、1人だけ「ウルフ」として似ているが違うお題を持つ。
- 誰がウルフか、自分がウルフかどうかは誰にも知らされていない。あなた自身がウルフの可能性もある。
- 会話の後、全員が投票し、最多票の人が追放される。ウルフが追放されれば多数派の勝ち、そうでなければウルフの勝ち。
- ウルフが追放されても、多数派のお題を当てればウルフの逆転勝ち。

# あなたの情報
- あなたのお題: 「${view.self.word}」
- 性格: ${persona.label} — ${persona.prompt}

# 心得
- お題の単語そのもの（「${view.self.word}」）は絶対に口にしない。
- 具体的すぎるとウルフにお題がばれる。抽象的すぎると自分が疑われる。そのバランスを取る。
- 他の人の発言が自分のお題とかみ合わなければ、自分がウルフの可能性も考え、周りに話を合わせる。
- 発言は日本語で1〜2文、60文字程度まで。性格に合った口調で。
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

function speakPrompt(view) {
  const ids = otherIds(view);
  const example = Object.fromEntries(ids.map((id) => [id, Number((1 / ids.length).toFixed(2))]));
  return `# これまでの会話（${view.round}/${view.rounds}周目）
${describeLog(view)}

# あなたの以前の推理（他の人には見えない）
${memoryText(view)}

あなたの番です。次の形式の JSON で答えてください。
{
  "speech": "みんなに向けた発言",
  "suspicions": ${JSON.stringify(example)},
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

投票の時間です。ウルフだと思う人を、次の候補から1人選んでください（自分には投票できません）。
候補: ${list.join(', ')}
次の形式の JSON で答えてください。
{ "vote": "候補のid", "reason": "理由（1文）", "suspicions": { "id": 確率, ... } }`;
}

function guessPrompt(view) {
  return `# 会話ログ
${describeLog(view)}

あなたはウルフとして追放されました。あなたのお題「${view.self.word}」は少数派でした。
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

async function askLLM(player, system, user) {
  const text = await complete(player.provider, { model: player.model, system, user });
  return parseJsonLoose(text);
}

export async function aiSpeak(player, view) {
  if (player.provider === 'mock') return { ...mockSpeak(view), source: 'mock' };
  try {
    const system = systemPrompt(view);
    let out = await askLLM(player, system, speakPrompt(view));
    if (String(out.speech || '').includes(view.self.word)) {
      // お題をそのまま言ってしまったら1回だけやり直す
      out = await askLLM(player, system, `${speakPrompt(view)}\n\n注意: 前回の案はお題「${view.self.word}」を直接含んでいました。言い換えてください。`);
    }
    const speech = clip(maskWord(out.speech, view.self.word));
    if (!speech) throw new Error('発言が空でした');
    return {
      speech,
      suspicions: sanitizeSuspicions(out.suspicions, view),
      strategy: clip(out.strategy, 200),
      wolfSelf: Math.max(0, Math.min(1, Number(out.wolf_self) || 0)),
      source: 'llm',
    };
  } catch (e) {
    return { ...mockSpeak(view), source: 'fallback', error: e.message };
  }
}

export async function aiVote(player, view, candidates) {
  const valid = candidates.filter((id) => id !== view.self.id);
  if (player.provider !== 'mock') {
    try {
      const out = await askLLM(player, systemPrompt(view), votePrompt(view, candidates));
      const vote = String(out.vote || '').trim();
      if (valid.includes(vote)) {
        return {
          vote,
          reason: clip(out.reason, 200),
          suspicions: sanitizeSuspicions(out.suspicions, view),
          source: 'llm',
        };
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
