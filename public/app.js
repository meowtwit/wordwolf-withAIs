// 月夜のワードウルフ — フロントエンド（依存なし）
const $ = (s, el = document) => el.querySelector(s);
const main = $('#main');
const dock = $('#dock');
const statusEl = $('#status');
const stepsEl = $('#steps');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const AI_PRESETS = [
  { name: 'ハル', personality: 'analyst' },
  { name: 'ミオ', personality: 'questioner' },
  { name: 'ソラ', personality: 'trickster' },
  { name: 'レン', personality: 'cheerful' },
];
const VOICE_PITCH = { ai1: 1.0, ai2: 1.35, ai3: 0.8, ai4: 1.15 };
const STEPS = [
  { n: 1, label: 'ひとこと' },
  { n: 2, label: '質問' },
  { n: 3, label: '自由会話' },
  { n: 4, label: '一斉投票' },
];

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 保存できなくても遊べる */ } },
};

let config = { providers: [], personalities: [] };
let setup = null;
let game = null;
let ui = {};

async function api(path, body) {
  const res = await fetch(`/api/${path}`, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || `HTTP ${res.status}`); e.status = res.status; throw e; }
  return data;
}
const post = (action, body = {}) => api(`games/${game.id}/${action}`, body);

// ---------- 小物 ----------
const P = (id) => game.players.find((p) => p.id === id);
const humans = () => game.players.filter((p) => p.type === 'human');
const aisOf = () => game.players.filter((p) => p.type === 'ai');
const colorOf = (p) => `var(--c-${p.id})`;
const face = (p, cls = 'face') => `<div class="${cls}" style="--c:${colorOf(p)}">${esc([...p.name][0])}</div>`;
const personalityLabel = (id) => config.personalities.find((p) => p.id === id)?.label || '';
const providerLabel = (id) => config.providers.find((p) => p.id === id)?.label || id;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 発言中の @名前 を色付けして HTML にする。 */
function withMentions(text) {
  let html = esc(text);
  const names = [...game.players.map((p) => p.name), 'all', '全員', 'みんな'].sort((a, b) => b.length - a.length);
  for (const n of names) html = html.split(`@${esc(n)}`).join(`\u0000${esc(n)}\u0001`);
  return html.replace(/\u0000([^\u0001]*)\u0001/g, '<span class="mention">@$1</span>');
}

// ---------- 読み上げ ----------
const tts = {
  ok: 'speechSynthesis' in window,
  voices: [],
  queue: Promise.resolve(),
  pending: 0,
  load() { if (this.ok) { const v = speechSynthesis.getVoices().filter((x) => /^ja/i.test(x.lang)); if (v.length) this.voices = v; } },
  unlock() { if (this.ok) try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); } catch {} },
  speakNow(text, id) {
    return new Promise((res) => {
      try {
        const u = new SpeechSynthesisUtterance(text.replace(/@/g, ''));
        u.lang = 'ja-JP';
        const idx = Number(id.replace(/\D/g, '')) - 1;
        if (this.voices.length) u.voice = this.voices[idx % this.voices.length];
        u.pitch = VOICE_PITCH[id] || 1; u.rate = 1.15;
        const t = setTimeout(res, 2500 + text.length * 250);
        u.onend = u.onerror = () => { clearTimeout(t); res(); };
        speechSynthesis.speak(u);
      } catch { res(); }
    });
  },
  /** 読み上げを順番待ちに入れる。自由会話で溜まりすぎたら古いものは飛ばす。 */
  say(text, id) {
    if (!this.ok || !setup.voice) return;
    this.pending++;
    const mine = this.pending;
    this.queue = this.queue.then(async () => {
      if (game?.phase === 'free' && this.pending - mine >= 2) return;
      await this.speakNow(text, id);
    }).finally(() => { if (mine === this.pending) this.pending = 0; });
  },
  idle() { return this.queue; },
  stop() { if (this.ok) try { speechSynthesis.cancel(); } catch {} this.pending = 0; this.queue = Promise.resolve(); },
};
if (tts.ok) { tts.load(); speechSynthesis.onvoiceschanged = () => tts.load(); }

// ---------- 音声入力 ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const mic = { rec: null, on: false, blocked: !SR };
function toggleMic() { mic.on ? stopMic() : startMic(); }
function stopMic() { try { mic.rec?.stop(); } catch {} }
function startMic() {
  if (!SR || mic.on) return;
  tts.stop();
  const rec = new SR();
  rec.lang = 'ja-JP'; rec.interimResults = true; rec.continuous = false;
  let finalText = '';
  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) finalText += e.results[i][0].transcript; else interim += e.results[i][0].transcript;
    }
    const box = $('#text'); if (box) box.value = finalText + interim;
  };
  rec.onerror = (e) => {
    if (['not-allowed', 'service-not-allowed', 'audio-capture'].includes(e.error)) {
      mic.blocked = true;
      $('#mic')?.setAttribute('hidden', '');
      hint('マイクを使えませんでした。ブラウザのマイク許可を確認するか、キーボードの音声入力を使ってください。');
    }
  };
  rec.onend = () => {
    mic.on = false; $('#mic')?.classList.remove('on');
    if (finalText.trim() && $('#say')) $('#say').requestSubmit();
  };
  try { rec.start(); mic.rec = rec; mic.on = true; $('#mic')?.classList.add('on'); } catch { mic.blocked = true; $('#mic')?.setAttribute('hidden', ''); }
}

// ---------- 設定 ----------
function defaultSetup() {
  const real = config.providers.find((p) => p.id === 'gemini' && p.available)
    || config.providers.find((p) => !['mock', 'ollama'].includes(p.id) && p.available);
  const provider = real ? real.id : 'mock';
  return {
    humans: 1, names: ['あなた', 'ゲスト'], voice: true,
    ais: AI_PRESETS.slice(0, 3).map((a) => ({ ...a, provider, model: '' })),
  };
}
const saveSetup = () => store.set('ww-setup-v2', setup);

function renderSetup() {
  stepsEl.hidden = true;
  statusEl.textContent = '';
  dock.innerHTML = '';
  const seg = (key, opts, cur) => `<div class="seg" role="group">${opts.map(([v, l]) => `<button type="button" data-set="${key}" data-val="${v}" aria-pressed="${String(cur) === String(v)}">${esc(l)}</button>`).join('')}</div>`;
  const provOpts = (sel) => config.providers.map((p) => `<option value="${p.id}" ${p.id === sel ? 'selected' : ''} ${p.available ? '' : 'disabled'}>${esc(p.label)}${p.available ? '' : '（キー未設定）'}</option>`).join('');
  const persOpts = (sel) => config.personalities.map((p) => `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${esc(p.label)}</option>`).join('');

  main.innerHTML = `<div class="stack">
    <section class="panel">
      <h2>村にウルフがひとり紛れている</h2>
      <p class="muted" style="margin:0">みんなに同じお題が配られますが、1人だけ少し違うお題を持っています。それが誰なのかは、AIにもあなたにも分かりません。</p>
      <ol class="muted" style="margin:8px 0 0;padding-left:1.4em">
        <li>ルーレットで話す順番を決めて、順番に<b>ひとこと</b>ずつ</li>
        <li>順番に、誰か1人に<b>質問</b>。聞かれた人が答える</li>
        <li><b>1分間の自由会話</b>。@名前 で呼びかけ（複数・@all もOK）</li>
        <li>全員で<b>一斉投票</b>。ウルフが見破られても、多数派のお題を当てれば逆転勝利</li>
      </ol>
    </section>
    <section class="panel">
      <h3>人間</h3>
      ${seg('humans', [[1, '1人'], [2, '2人']], setup.humans)}
      <div class="ai-grid" style="margin-top:6px">
        ${Array.from({ length: setup.humans }, (_, i) => `<div><label class="f" for="hn${i}">プレイヤー${i + 1}の名前</label><input type="text" id="hn${i}" data-name="${i}" maxlength="10" value="${esc(setup.names[i])}"></div>`).join('')}
      </div>
      ${setup.humans === 2 ? '<p class="muted">2人のときは1台を交代で使います。お題の確認と投票のときは、相手に画面を見せないでください。</p>' : ''}
    </section>
    <section class="panel">
      <div class="row" style="justify-content:space-between"><h3 style="margin:0">AIの村人</h3>
        <div class="row"><button class="btn small" type="button" data-ai="-" ${setup.ais.length <= 2 ? 'disabled' : ''}>1人減らす</button>
        <button class="btn small" type="button" data-ai="+" ${setup.ais.length >= 4 ? 'disabled' : ''}>1人増やす</button></div></div>
      <p class="muted">それぞれ別々に考え、自分のお題と会話だけを手がかりにします。名前は声で呼びやすいものがおすすめです。</p>
      <div class="ai-grid">${setup.ais.map((a, i) => {
        const prov = config.providers.find((p) => p.id === a.provider);
        return `<div class="ai-card" style="--c:var(--c-ai${i + 1})">
          <label class="f" for="an${i}">名前</label><input type="text" id="an${i}" data-ai-f="name" data-i="${i}" maxlength="10" value="${esc(a.name)}">
          <label class="f" for="ap${i}">性格</label><select id="ap${i}" data-ai-f="personality" data-i="${i}">${persOpts(a.personality)}</select>
          <label class="f" for="av${i}">AIモデル</label><select id="av${i}" data-ai-f="provider" data-i="${i}">${provOpts(a.provider)}</select>
          ${a.provider !== 'mock' ? `<label class="f" for="am${i}">モデル名（空欄で ${esc(prov?.defaultModel)}）</label><input type="text" id="am${i}" data-ai-f="model" data-i="${i}" value="${esc(a.model)}" placeholder="${esc(prov?.defaultModel)}">` : ''}
        </div>`;
      }).join('')}</div>
    </section>
    <section class="panel row" style="justify-content:space-between">
      <div><h3>AIの声</h3>${seg('voice', [[true, '読み上げる'], [false, '読み上げない']], setup.voice)}</div>
      <p class="muted" style="margin:0;max-width:36ch">${mic.blocked ? 'このブラウザはマイク入力に対応していません。キーボードの音声入力なら使えます。' : 'マイクボタンで声でも話せます（Chrome / Edge / Safari）。'}</p>
    </section>
    <div class="row" style="justify-content:center"><button class="btn moonlit big" type="button" id="start">ゲームを始める</button></div>
    ${ui.error ? `<p class="err" style="text-align:center">${esc(ui.error)}</p>` : ''}
  </div>`;

  main.querySelectorAll('[data-set]').forEach((b) => b.onclick = () => {
    setup[b.dataset.set] = b.dataset.set === 'voice' ? b.dataset.val === 'true' : Number(b.dataset.val);
    saveSetup(); renderSetup();
  });
  main.querySelectorAll('[data-name]').forEach((el) => el.oninput = () => { setup.names[el.dataset.name] = el.value; saveSetup(); });
  main.querySelectorAll('[data-ai-f]').forEach((el) => {
    const f = () => {
      const a = setup.ais[el.dataset.i];
      a[el.dataset.aiF] = el.value;
      if (el.dataset.aiF === 'provider') a.model = '';
      saveSetup();
      if (el.dataset.aiF === 'provider') renderSetup();
    };
    el.tagName === 'SELECT' ? (el.onchange = f) : (el.oninput = f);
  });
  main.querySelectorAll('[data-ai]').forEach((b) => b.onclick = () => {
    if (b.dataset.ai === '+') setup.ais.push({ ...AI_PRESETS[setup.ais.length], provider: setup.ais[0].provider, model: setup.ais[0].model });
    else setup.ais.pop();
    saveSetup(); renderSetup();
  });
  $('#start').onclick = startGame;
}

async function startGame() {
  ui.error = '';
  try {
    tts.unlock();
    game = await api('games', { humans: setup.names.slice(0, setup.humans).map((name) => ({ name })), ais: setup.ais });
    ui = { revealIdx: 0, shown: false, speaker: 'h1', rendered: 0, mode: '', target: null };
    renderRoulette();
  } catch (e) {
    ui.error = e.message;
    renderSetup();
  }
}

// ---------- ルーレット ----------
async function renderRoulette() {
  stepsEl.hidden = true;
  statusEl.textContent = '順番決め';
  dock.innerHTML = '';
  main.innerHTML = `<section class="panel cover">
    <h2>ルーレットで話す順番を決めます</h2>
    <div class="wheel">${game.order.map((_, i) => `<div class="slot spin" id="slot${i}"><span class="num">${i + 1}</span><span class="nm">？</span></div>`).join('')}</div>
    <button class="btn moonlit big" type="button" id="go" hidden>お題を確認する</button>
  </section>`;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const left = [...game.players];
  for (let i = 0; i < game.order.length; i++) {
    const slot = $(`#slot${i}`);
    const nm = slot.querySelector('.nm');
    const spinFor = reduce ? 0 : 900 + i * 250;
    const t0 = performance.now();
    while (performance.now() - t0 < spinFor) {
      nm.textContent = left[Math.floor(Math.random() * left.length)].name;
      await sleep(70);
    }
    const p = P(game.order[i]);
    left.splice(left.indexOf(p), 1);
    slot.className = 'slot fixed';
    slot.style.setProperty('--c', colorOf(p));
    slot.innerHTML = `<span class="num">${i + 1}</span>${face(p)}<span class="nm">${esc(p.name)}</span>`;
    await sleep(reduce ? 0 : 250);
  }
  const go = $('#go');
  go.hidden = false;
  go.onclick = renderReveal;
}

// ---------- お題の確認 ----------
function renderReveal() {
  const hs = humans();
  const h = hs[ui.revealIdx];
  statusEl.textContent = 'お題の確認';
  if (!ui.shown) {
    main.innerHTML = `<section class="panel cover">
      ${hs.length > 1 ? '<p>ほかの人は画面を見ないでください。</p>' : ''}
      <h2>${esc(h.name)}さんのお題</h2><p class="muted">あなたが多数派か、ウルフかは分かりません。</p>
      <button class="btn moonlit big" type="button" id="show">お題を見る</button></section>`;
    $('#show').onclick = async () => {
      try { ui.word = (await post('word', { playerId: h.id })).word; ui.shown = true; renderReveal(); } catch (e) { alertMsg(e.message); }
    };
    return;
  }
  const last = ui.revealIdx === hs.length - 1;
  main.innerHTML = `<section class="panel cover"><p>${esc(h.name)}さんのお題は</p><div class="word">${esc(ui.word)}</div>
    <p class="muted">この言葉そのものは言わないように話しましょう。</p>
    <button class="btn moonlit big" type="button" id="next">${last ? '覚えた。村へ行く' : '覚えた。次の人へ渡す'}</button></section>`;
  $('#next').onclick = async () => {
    ui.shown = false; ui.word = '';
    ui.revealIdx++;
    if (ui.revealIdx < hs.length) return renderReveal();
    try { game = await post('start'); } catch (e) { return alertMsg(e.message); }
    renderTalkShell();
    update();
  };
}
function alertMsg(m) { main.insertAdjacentHTML('beforeend', `<p class="err" style="text-align:center">${esc(m)}</p>`); }

// ---------- 会話（1〜3ターン目） ----------
function renderSteps() {
  stepsEl.hidden = false;
  stepsEl.innerHTML = STEPS.map((s) => `<div class="step ${game.turn === s.n ? 'now' : game.turn > s.n ? 'done' : ''}"><b>TURN ${s.n}</b><span>${s.label}</span></div>`).join('');
}

function renderTalkShell() {
  main.innerHTML = '<div class="villagers" id="villagers"></div><div class="log" id="log"></div>';
  ui.rendered = 0; ui.lastTurn = 0; ui.mode = '';
  dock.innerHTML = '';
}

function renderVillagers() {
  const el = $('#villagers'); if (!el) return;
  const active = game.phase === 'free' ? game.free?.thinkingId : game.actorId;
  el.innerHTML = game.order.map((id, i) => {
    const p = P(id);
    return `<div class="v ${active === id ? 'speaking' : ''}" style="--c:${colorOf(p)}"><span class="no">${i + 1}</span>${face(p)}<div class="nm">${esc(p.name)}</div><div class="tg">${p.type === 'human' ? '人間' : esc(personalityLabel(p.personality))}</div></div>`;
  }).join('');
}

function msgHtml(l) {
  const p = P(l.playerId);
  const toNames = (l.to || []).map((id) => (id === 'all' ? '全員' : P(id)?.name)).filter(Boolean);
  const tag = l.kind === 'question' ? `<span class="to">→ ${esc(toNames.join('・'))}さんへ質問</span>`
    : l.kind === 'answer' ? `<span class="to">↩ ${esc(toNames.join('・'))}さんへの答え</span>` : '';
  return `<div class="msg ${p.type} ${l.kind}" style="--c:${colorOf(p)}">${face(p)}<div class="bubble"><div class="who">${esc(p.name)}${tag}</div>${withMentions(l.text)}</div></div>`;
}

const TURN_TITLE = { 1: 'ひとことずつ', 2: '順番に質問', 3: '自由会話（1分）' };

function appendNewLog() {
  const log = $('#log'); if (!log) return;
  while (ui.rendered < game.log.length) {
    const l = game.log[ui.rendered++];
    if (l.turn !== ui.lastTurn) {
      ui.lastTurn = l.turn;
      log.insertAdjacentHTML('beforeend', `<div class="sep"><b>TURN ${l.turn}</b>${TURN_TITLE[l.turn] || ''}</div>`);
    }
    $('#typing')?.remove();
    log.insertAdjacentHTML('beforeend', msgHtml(l));
    if (P(l.playerId).type === 'ai') {
      tts.say(l.text, l.playerId);
      const called = humans().filter((h) => l.to?.includes(h.id) || l.to?.includes('all'));
      if (l.kind === 'free' && called.length) hint(`${l.name}さんが ${called.map((h) => h.name).join('・')}さんを呼んでいます`);
    }
  }
  // 次に話す AI の「考え中」
  $('#typing')?.remove();
  const thinking = game.phase === 'free' ? game.free?.thinkingId : (ui.pending && P(game.actorId)?.type === 'ai' ? game.actorId : null);
  if (thinking) {
    const p = P(thinking);
    log.insertAdjacentHTML('beforeend', `<div class="msg typing" id="typing" style="--c:${colorOf(p)}">${face(p)}<div class="bubble"><div class="who">${esc(p.name)}</div><span class="dots"><i></i><i></i><i></i></span></div></div>`);
  }
  main.scrollTo({ top: main.scrollHeight, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}

/** いまの入力欄の種類。変わったときだけ作り直す（入力中の文字を消さないため）。 */
function modeOf() {
  if (game.phase === 'free') return 'free';
  const a = P(game.actorId);
  if (!a) return 'none';
  if (a.type === 'ai') return `ai:${a.id}:${game.phase}:${game.qa?.step || ''}`;
  if (game.phase === 'intro') return `intro:${a.id}`;
  return game.qa.step === 'ask' ? `ask:${a.id}` : `answer:${a.id}:${game.cursor}`;
}

const MIC_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-2.08A7 7 0 0 0 19 12h-2Z"/></svg>';

function composer({ banner = '', placeholder, extra = '', tools = '' }) {
  return `<div class="composer">
    ${banner}
    ${extra}
    <form id="say" autocomplete="off">
      <button class="mic" type="button" id="mic" aria-label="声で話す" ${mic.blocked ? 'hidden' : ''}>${MIC_SVG}</button>
      <input type="text" id="text" maxlength="120" placeholder="${esc(placeholder)}">
      <button class="btn moonlit" type="submit" id="send">送る</button>
    </form>
    <div class="tools"><div class="row">${tools}</div><div class="row"><button class="btn small" type="button" id="peek">自分のお題</button></div></div>
    <div class="hint" id="hint"></div>
  </div>`;
}

function buildDock(mode) {
  ui.mode = mode;
  ui.target = null;
  if (mode === 'none') { dock.innerHTML = ''; return; }
  if (mode.startsWith('ai:')) {
    const a = P(game.actorId);
    const what = game.phase === 'intro' ? 'ひとこと考えています' : game.qa.step === 'ask' ? '誰に質問するか考えています' : `${P(game.qa.from).name}さんの質問への答えを考えています`;
    dock.innerHTML = `<div class="composer"><div class="banner">${esc(a.name)}さんが${what}…</div>
      <div class="tools"><div></div><div class="row"><button class="btn small" type="button" id="peek">自分のお題</button></div></div></div>`;
    $('#peek').onclick = peek;
    return;
  }
  const [kind, pid] = mode.split(':');
  const me = P(pid);
  if (kind === 'intro') {
    dock.innerHTML = composer({ banner: `<div class="banner">${esc(me.name)}さんの番です。お題について<b>ひとこと</b>どうぞ。</div>`, placeholder: 'ひとこと（例: 夏によく行くかな）' });
  } else if (kind === 'ask') {
    const targets = game.order.filter((id) => id !== pid).map(P);
    dock.innerHTML = composer({
      banner: `<div class="banner">${esc(me.name)}さんの番です。誰か1人に<b>質問</b>しましょう。</div>`,
      extra: `<div class="targets" id="targets">${targets.map((p) => `<button type="button" class="target" data-t="${p.id}" style="--c:${colorOf(p)}" aria-pressed="false">${esc(p.name)}</button>`).join('')}</div>`,
      placeholder: '質問（相手を選ぶか、名前を入れて話す）',
    });
    dock.querySelectorAll('[data-t]').forEach((b) => b.onclick = () => {
      ui.target = b.dataset.t;
      dock.querySelectorAll('[data-t]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.t === ui.target)));
      $('#text').focus();
    });
  } else if (kind === 'answer') {
    const from = P(game.qa.from);
    const q = [...game.log].reverse().find((l) => l.kind === 'question');
    dock.innerHTML = composer({ banner: `<div class="banner ask">${esc(from.name)}さんから${esc(me.name)}さんへの質問:「${esc(q?.text || '')}」</div>`, placeholder: '答える' });
  } else if (mode === 'free') {
    const hs = humans();
    ui.speaker = ui.speaker || hs[0].id;
    dock.innerHTML = composer({
      extra: `<div class="timer" id="timer"><span class="sec" id="sec">60</span><div class="meter"><i id="meter" style="width:100%"></i></div></div>
        <div class="hint" id="queue"></div>
        <div class="targets">${game.order.filter((id) => P(id).type === 'ai').map(P).map((p) => `<button type="button" class="target" data-m="${esc(p.name)}" style="--c:${colorOf(p)}">@${esc(p.name)}</button>`).join('')}<button type="button" class="target" data-m="all" style="--c:var(--moon)">@all</button></div>`,
      placeholder: '@名前 で呼びかけ（例: @ミオ それ冬も使う？）',
      tools: hs.length > 1 ? `<span class="hint">話す人</span><div class="seg" id="who">${hs.map((h) => `<button type="button" data-sp="${h.id}" aria-pressed="${ui.speaker === h.id}">${esc(h.name)}</button>`).join('')}</div>` : '',
    });
    dock.querySelectorAll('[data-m]').forEach((b) => b.onclick = () => {
      const box = $('#text');
      const tag = `@${b.dataset.m} `;
      if (!box.value.includes(tag)) box.value = (box.value ? `${box.value.trimEnd()} ` : '') + tag;
      box.focus();
    });
    dock.querySelectorAll('[data-sp]').forEach((b) => b.onclick = () => {
      ui.speaker = b.dataset.sp;
      dock.querySelectorAll('[data-sp]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.sp === ui.speaker)));
    });
  }
  $('#peek').onclick = peek;
  $('#mic').onclick = toggleMic;
  $('#say').onsubmit = (e) => { e.preventDefault(); submit(kind, pid); };
  if (!matchMedia('(pointer: coarse)').matches) $('#text').focus();
}

function hint(t) { const el = $('#hint'); if (el) el.textContent = t; }

async function submit(kind, pid) {
  const box = $('#text');
  const text = box.value.trim();
  if (!text) return;
  try {
    if (kind === 'intro' || kind === 'answer') {
      game = await post('speak', { playerId: pid, text });
    } else if (kind === 'ask') {
      let target = ui.target;
      if (!target) {
        // 声で「ミオは〜？」と聞いたときは名前から相手を決める
        const t = text.normalize('NFKC');
        target = game.order.filter((id) => id !== pid).map(P).sort((a, b) => b.name.length - a.name.length).find((p) => t.includes(p.name))?.id;
      }
      if (!target) return hint('質問する相手を選んでください（名前を入れて話してもOK）');
      game = await post('ask', { playerId: pid, targetId: target, text });
    } else {
      game = await post('say', { playerId: ui.speaker, text });
    }
    box.value = '';
    hint('');
    update();
  } catch (e) {
    hint(e.message);
  }
}

function peek() {
  const hs = humans();
  const h = hs.find((x) => x.id === (ui.mode.split(':')[1] || ui.speaker)) || hs[0];
  if (hs.length > 1 && !ui.peekArmed) {
    ui.peekArmed = true;
    hint(`${h.name}さん以外は画面を見ないでください。もう一度押すと表示します。`);
    setTimeout(() => { ui.peekArmed = false; }, 4000);
    return;
  }
  ui.peekArmed = false;
  post('word', { playerId: h.id }).then(({ word }) => {
    hint(`${h.name}さんのお題:「${word}」（5秒で消えます）`);
    setTimeout(() => hint(''), 5000);
  }).catch((e) => hint(e.message));
}

function updateQueue() {
  const el = $('#queue'); if (!el || !game.free) return;
  const parts = [];
  if (game.free.thinkingId) parts.push(`考え中: ${P(game.free.thinkingId).name}`);
  if (game.free.queue.length) {
    parts.push(`次: ${game.free.queue.map((q) => `${P(q.id).name}${q.fromId ? `（${P(q.fromId).name}から）` : ''}`).join('、')}`);
  }
  el.textContent = parts.join(' ／ ');
}

function updateTimer() {
  if (game.phase !== 'free' || !game.free) return;
  const left = Math.max(0, ui.freeEndsAt - Date.now());
  const sec = Math.ceil(left / 1000);
  const el = $('#sec'); if (!el) return;
  el.textContent = String(sec);
  $('#meter').style.width = `${(left / game.free.durationMs) * 100}%`;
  $('#timer').classList.toggle('low', sec <= 10);
  statusEl.textContent = `残り ${sec} 秒`;
}

// ---------- 進行の同期 ----------
let pollTimer = null;
let clockTimer = null;

function update() {
  if (['voting', 'guess', 'finished'].includes(game.phase)) {
    clearInterval(pollTimer); pollTimer = null;
    clearInterval(clockTimer); clockTimer = null;
    stopMic();
    return renderAfterTalk();
  }
  renderSteps();
  if (!$('#log')) renderTalkShell();
  renderVillagers();
  appendNewLog();
  const mode = modeOf();
  if (mode !== ui.mode) buildDock(mode);

  if (game.phase === 'free') {
    ui.freeEndsAt = Date.now() + game.free.remainingMs;
    if (!pollTimer) pollTimer = setInterval(poll, 700);
    if (!clockTimer) clockTimer = setInterval(updateTimer, 250);
    updateTimer();
    updateQueue();
  } else {
    statusEl.textContent = `${game.turn}ターン目`;
    if (mode.startsWith('ai:')) driveAI();
  }
}

async function poll() {
  if (ui.polling) return;
  ui.polling = true;
  try { game = await api(`games/${game.id}`); update(); } catch { /* 次の poll で再試行 */ } finally { ui.polling = false; }
}

/** 1・2ターン目の AI の手番。読み上げが終わってから次の AI を動かす。 */
async function driveAI() {
  if (ui.pending) return;
  ui.pending = true;
  try {
    await tts.idle();
    await sleep(500);
    appendNewLog();
    game = await post('advance');
  } catch (e) {
    if (e.status !== 409) hint(e.message);
    await sleep(1000);
    try { game = await api(`games/${game.id}`); } catch {}
  } finally {
    ui.pending = false;
  }
  update();
}

// ---------- 投票・逆転・結果 ----------
function renderAfterTalk() {
  dock.innerHTML = '';
  renderSteps();
  if (game.phase === 'voting') return renderVote();
  if (game.phase === 'guess') return renderGuess();
  return renderResult();
}

function renderVote() {
  statusEl.textContent = game.voteRound > 1 ? '決選投票' : '一斉投票';
  tts.stop();
  const runoff = game.voteRound > 1 ? `<p class="banner">同票だったので、もう一度一斉投票します。候補: ${game.candidates.map((id) => esc(P(id).name)).join('、')}</p>` : '';
  const voter = humans().find((h) => !game.voted.includes(h.id));
  if (!voter || ui.voting) {
    main.innerHTML = `<section class="panel cover"><h2>AIが投票しています</h2><p class="muted">それぞれが自分の推理だけで、別々に決めています。</p><div class="dots"><i></i><i></i><i></i></div></section>`;
    return;
  }
  if (humans().length > 1 && ui.voteShownFor !== voter.id) {
    main.innerHTML = `<section class="panel cover">${runoff}<h2>${esc(voter.name)}さんの投票</h2><p>ほかの人は画面を見ないでください。</p><button class="btn moonlit big" type="button" id="open">投票する</button></section>`;
    $('#open').onclick = () => { ui.voteShownFor = voter.id; renderVote(); };
    return;
  }
  const opts = game.candidates.filter((id) => id !== voter.id).map(P);
  main.innerHTML = `<div class="stack"><section class="panel">${runoff}<h2>${esc(voter.name)}さん、ウルフだと思う人は？</h2>
    <p class="muted">全員の票は、そろってから一斉に公開されます。</p>
    <div class="choices">${opts.map((p) => `<button class="choice" type="button" data-v="${p.id}" style="--c:${colorOf(p)}">${face(p)}<div><b>${esc(p.name)}</b><div class="muted">${p.type === 'human' ? '人間' : esc(personalityLabel(p.personality))}</div></div></button>`).join('')}</div></section>
    <details class="panel"><summary>会話を見返す</summary><div class="log" style="margin-top:10px">${game.log.map(msgHtml).join('')}</div></details></div>`;
  main.querySelectorAll('[data-v]').forEach((b) => b.onclick = async () => {
    const last = humans().filter((h) => !game.voted.includes(h.id)).length === 1;
    ui.voteShownFor = null;
    if (last) { ui.voting = true; renderVote(); }
    try {
      game = await post('vote', { playerId: voter.id, targetId: b.dataset.v });
    } catch (e) {
      ui.voting = false; renderVote(); return alertMsg(e.message);
    }
    ui.voting = false;
    update();
  });
}

function voteReveal(history) {
  const h = history[history.length - 1];
  if (!h) return '';
  const lines = game.order.filter((id) => h.votes[id]).map((id, i) => {
    const v = h.votes[id];
    return `<div class="line" style="animation-delay:${i * 0.25}s">${face(P(id))}<b>${esc(P(id).name)}</b><span class="arrow">→</span>${face(P(v.target))}<b>${esc(P(v.target).name)}</b></div>`;
  }).join('');
  const counts = Object.entries(h.counts).sort((a, b) => b[1] - a[1]).map(([id, n]) => `${esc(P(id).name)} ${n}票`).join(' / ');
  return `<section class="panel"><h2>せーの、一斉に公開</h2><div class="reveal">${lines}</div><p class="muted" style="margin:10px 0 0">${counts}</p></section>`;
}

function renderGuess() {
  const w = P(game.guesserId);
  statusEl.textContent = '逆転のチャンス';
  main.innerHTML = `<div class="stack">${voteReveal(game.voteHistory || [])}
    <section class="panel cover"><p>見破られたのは</p><div class="word" style="color:var(--wolf)">${esc(w.name)}</div>
    <p><b>${esc(w.name)}さんはウルフでした。</b></p>
    <p class="muted">${esc(w.name)}さん、多数派のお題を当てれば逆転勝利です。</p>
    <form id="gf" class="row" style="justify-content:center;margin-top:12px"><input type="text" id="gtext" maxlength="20" placeholder="多数派のお題は？" style="max-width:240px"><button class="btn moonlit" type="submit">答える</button></form>
    </section></div>`;
  $('#gf').onsubmit = async (e) => {
    e.preventDefault();
    const guess = $('#gtext').value.trim();
    if (!guess) return;
    try { game = await post('guess', { playerId: w.id, guess }); update(); } catch (err) { alertMsg(err.message); }
  };
}

function bars(s) {
  return `<div class="bars">${Object.entries(s || {}).sort((a, b) => b[1] - a[1]).map(([id, v]) => {
    const p = P(id);
    return `<span>${esc(p?.name || id)}</span><div class="bar" style="--c:${p ? colorOf(p) : 'var(--mist-dim)'}"><i style="width:${Math.round(v * 100)}%"></i></div><span>${Math.round(v * 100)}%</span>`;
  }).join('')}</div>`;
}

const THOUGHT_LABEL = { intro: '1ターン目・ひとこと', ask: '2ターン目・質問', answer: '2ターン目・回答', free: '3ターン目・自由会話', vote: '4ターン目・投票' };

function renderResult() {
  tts.stop();
  const r = game.result;
  const w = P(game.wolfId);
  statusEl.textContent = 'ゲーム終了';
  const src = (t) => (t.source === 'fallback' ? `<span class="chip warn" title="${esc(t.error)}">API失敗</span>` : t.source === 'mock' ? '<span class="chip">オフライン</span>' : '');
  main.innerHTML = `<div class="stack">
    <section class="panel verdict ${r.winner}">
      <div class="muted">${r.winner === 'wolf' ? 'WOLF WINS' : 'VILLAGE WINS'}</div>
      <div class="big">${r.winner === 'wolf' ? 'ウルフの勝ち' : '村人の勝ち'}</div>
      <p style="margin:0 0 6px">${esc(r.reason)}</p>
      <p style="margin:0">ウルフは <span class="wolfmark">${esc(w.name)}</span>（お題「${esc(game.topic.minority)}」）。村人のお題は「${esc(game.topic.majority)}」でした。</p>
      ${r.guess ? `<p class="muted">ウルフの逆予測: 「${esc(r.guess.text)}」 ${r.guess.correct ? '正解' : '不正解'}${r.guess.reason ? `（${esc(r.guess.reason)}）` : ''}</p>` : ''}
    </section>
    ${voteReveal(game.voteHistory)}
    <section class="panel"><h2>投票の理由</h2><div class="tbl"><table>
      <thead><tr><th>投票した人</th><th>投票先</th><th>理由</th></tr></thead><tbody>
      ${game.order.map((id) => { const v = game.voteHistory[game.voteHistory.length - 1]?.votes[id]; const p = P(id); return v ? `<tr><td>${esc(p.name)}${id === game.wolfId ? ' <span class="wolfmark">ウルフ</span>' : ''}<div class="muted">${esc(game.words[id])}</div></td><td>${esc(P(v.target).name)}</td><td>${esc(v.reason || '—')}</td></tr>` : ''; }).join('')}
      </tbody></table></div></section>
    <section class="panel stack"><div><h2>AIたちの頭の中</h2><p class="muted" style="margin:0">ゲーム中は見えなかった「だれが怪しいか」の変化と、それぞれの作戦です。</p></div>
      ${aisOf().map((p, i) => `<details class="mind" ${i === 0 ? 'open' : ''} style="--c:${colorOf(p)}"><summary><b style="color:${colorOf(p)}">${esc(p.name)}</b> <span class="muted">${esc(personalityLabel(p.personality))}・${esc(providerLabel(p.provider))}${p.model ? ` (${esc(p.model)})` : ''}・お題「${esc(game.words[p.id])}」${p.id === game.wolfId ? '・ウルフ' : ''}</span></summary>
        ${(game.thoughts[p.id] || []).map((t) => `<div class="think"><div class="meta">${THOUGHT_LABEL[t.kind] || t.kind}${typeof t.wolfSelf === 'number' && t.source === 'llm' && t.kind !== 'vote' ? `<span>自分がウルフだと思う確率 ${Math.round(t.wolfSelf * 100)}%</span>` : ''}${src(t)}</div>${bars(t.suspicions)}${t.strategy ? `<div class="thought">${esc(t.strategy)}</div>` : ''}</div>`).join('')}
      </details>`).join('')}
    </section>
    <details class="panel"><summary>会話をぜんぶ見る</summary><div class="log" style="margin-top:10px">${game.log.map(msgHtml).join('')}</div></details>
    <div class="row" style="justify-content:center"><button class="btn moonlit big" type="button" id="again">同じ設定でもう一度</button><button class="btn big" type="button" id="back">設定に戻る</button></div>
  </div>`;
  main.scrollTo({ top: 0 });
  $('#again').onclick = startGame;
  $('#back').onclick = () => { game = null; renderSetup(); };
}

// ---------- 起動 ----------
(async function init() {
  try {
    config = await api('config');
  } catch (e) {
    main.innerHTML = `<p class="err">サーバーに接続できません: ${esc(e.message)}</p>`;
    return;
  }
  const saved = store.get('ww-setup-v2', null);
  setup = saved && Array.isArray(saved.ais) && saved.ais.length >= 2 ? saved : defaultSetup();
  for (const a of setup.ais) {
    if (!config.providers.find((p) => p.id === a.provider && p.available)) { a.provider = 'mock'; a.model = ''; }
  }
  renderSetup();
})();
