// 月夜のワードウルフ — お客さん向け画面（展示用キオスク）。設定は admin.html で行う。
const $ = (s, el = document) => el.querySelector(s);
const main = $('#main');
const dock = $('#dock');
const statusEl = $('#status');
const stepsEl = $('#steps');
const sideEl = $('#side');
const shellEl = $('.shell');
const overlay = $('#overlay');

/** ノートPCなど横に広い画面か（会話の横に順番を並べる2列表示にする） */
const isWide = () => matchMedia('(min-width: 1024px)').matches;
/** 主ボタンにフォーカスして、Enter / Space で進めるようにする */
const focusPrimary = (sel) => { if (!matchMedia('(pointer: coarse)').matches) $(sel)?.focus(); };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const STEPS = [
  { n: 1, label: 'ひとこと' },
  { n: 2, label: 'しつもん①' },
  { n: 3, label: 'しつもん②' },
  { n: 4, label: 'いっせい投票' },
];

let K = { kiosk: { allowTwo: true, voice: true, mic: true, showMinds: true, idleSec: 180, resultSec: 120 }, characters: [] };
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

function setScreen(name) {
  document.body.dataset.screen = name;
  ui.screen = name;
}

/** 会話中だけ、話す順番の欄（ノートPCでは右側）を出す */
function setTalking(on) {
  shellEl.classList.toggle('talking', on);
  sideEl.hidden = !on;
  if (!on) sideEl.innerHTML = '';
}

// ---------- 小物 ----------
const P = (id) => game.players.find((p) => p.id === id);
const humans = () => game.players.filter((p) => p.type === 'human');
const aisOf = () => game.players.filter((p) => p.type === 'ai');
const colorOf = (p) => p.color || (p.id === 'h2' ? 'var(--c-h2)' : 'var(--c-h1)');
function face(p, cls = 'face') {
  if (p.image) return `<img class="${cls} pic" src="${esc(p.image)}" alt="" style="--c:${colorOf(p)}">`;
  return `<div class="${cls}" style="--c:${colorOf(p)}">${esc([...p.name][0])}</div>`;
}
const tagOf = (p) => (p.type === 'human' ? 'にんげん' : p.tagline || '');

// ---------- 読み上げ ----------
const tts = {
  ok: 'speechSynthesis' in window,
  voices: [],
  queue: Promise.resolve(),
  load() {
    if (!this.ok) return;
    const v = speechSynthesis.getVoices().filter((x) => /^ja/i.test(x.lang));
    // 自然な声（Edge の「Natural」など）を優先
    v.sort((a, b) => Number(/natural|online/i.test(b.name)) - Number(/natural|online/i.test(a.name)));
    if (v.length) this.voices = v;
  },
  unlock() { if (this.ok) try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); } catch {} },
  speakNow(text, p) {
    return new Promise((res) => {
      try {
        const u = new SpeechSynthesisUtterance(text);
        u.lang = 'ja-JP';
        const idx = Math.max(0, Number(p.id.replace(/\D/g, '')) - 1);
        if (this.voices.length) u.voice = this.voices[idx % this.voices.length];
        u.pitch = p.voicePitch || 1; u.rate = 1.1;
        const t = setTimeout(res, 2500 + text.length * 260);
        u.onend = u.onerror = () => { clearTimeout(t); res(); };
        speechSynthesis.speak(u);
      } catch { res(); }
    });
  },
  say(text, p) {
    if (!this.ok || !K.kiosk.voice) return;
    this.queue = this.queue.then(() => this.speakNow(text, p));
  },
  idle() { return this.queue; },
  stop() { if (this.ok) try { speechSynthesis.cancel(); } catch {} this.queue = Promise.resolve(); },
};
if (tts.ok) { tts.load(); speechSynthesis.onvoiceschanged = () => tts.load(); }

// ---------- 音声入力 ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const mic = { rec: null, on: false, blocked: !SR };
const micUsable = () => K.kiosk.mic && !mic.blocked;
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
    touch();
  };
  rec.onerror = (e) => {
    if (['not-allowed', 'service-not-allowed', 'audio-capture'].includes(e.error)) {
      mic.blocked = true;
      $('#mic')?.setAttribute('hidden', '');
      hint('マイクが使えませんでした。キーボードで入力してね。');
    }
  };
  rec.onend = () => {
    mic.on = false; $('#mic')?.classList.remove('on');
    if (finalText.trim() && $('#say')) $('#say').requestSubmit();
  };
  try { rec.start(); mic.rec = rec; mic.on = true; $('#mic')?.classList.add('on'); hint('聞いています… 話しおわったら、少し待ってね'); } catch { mic.blocked = true; $('#mic')?.setAttribute('hidden', ''); }
}

// ---------- 放置されたらタイトルに戻る ----------
let lastInput = Date.now();
function touch() { lastInput = Date.now(); if (ui.idleWarn) hideIdle(); }
['pointerdown', 'keydown', 'input', 'wheel', 'touchstart'].forEach((ev) => addEventListener(ev, touch, { passive: true }));

/** いまお客さんの操作を待っている画面か（AI が考えている間は数えない） */
function waitingForPeople() {
  if (['title', 'result'].includes(ui.screen)) return false;
  if (ui.screen === 'talk' && (ui.mode || '').startsWith('ai:')) return false;
  if (ui.voting || ui.busy) return false;
  return true;
}

function showIdle() {
  ui.idleWarn = true;
  let left = 20;
  overlay.hidden = false;
  const draw = () => {
    overlay.innerHTML = `<div class="panel cover idle">
      <h2>まだ あそんでいますか？</h2>
      <p>あと <b>${left}</b> びょうで タイトルにもどります</p>
      <button class="btn moonlit big" type="button" id="stay">つづける</button></div>`;
    $('#stay').onclick = hideIdle;
    focusPrimary('#stay');
  };
  draw();
  ui.idleTimer = setInterval(() => {
    left--;
    if (left <= 0) { hideIdle(); goTitle(); return; }
    draw();
  }, 1000);
}
function hideIdle() {
  ui.idleWarn = false;
  clearInterval(ui.idleTimer);
  overlay.hidden = true;
  overlay.innerHTML = '';
  lastInput = Date.now();
}
// 操作待ちになった時刻と最後の操作の、新しいほうから数える（AI が考えている時間は数えない）
setInterval(() => {
  if (ui.idleWarn) return;
  if (!waitingForPeople()) { ui.waitStart = 0; return; }
  if (!ui.waitStart) ui.waitStart = Date.now();
  if (Date.now() - Math.max(lastInput, ui.waitStart) > K.kiosk.idleSec * 1000) showIdle();
}, 1000);

async function goTitle() {
  clearInterval(ui.resultTimer);
  tts.stop();
  stopMic();
  game = null;
  ui = {};
  try { K = await api('kiosk'); } catch { /* 前の設定のまま */ }
  renderTitle();
}
$('#quit').onclick = () => {
  if (ui.quitArmed) { ui.quitArmed = false; goTitle(); return; }
  ui.quitArmed = true;
  $('#quit').textContent = 'もう一度おすと タイトルへ';
  setTimeout(() => { ui.quitArmed = false; $('#quit').textContent = 'タイトルへ'; }, 3000);
};

function fatal(msg) {
  setTalking(false);
  dock.innerHTML = '';
  main.innerHTML = `<section class="panel cover"><h2>うまく進めませんでした</h2>
    <p class="muted">${esc(msg)}</p><p>もう一度ためしても直らないときは、スタッフに声をかけてください。</p>
    <button class="btn moonlit big" type="button" id="totitle">タイトルへもどる</button></section>`;
  $('#totitle').onclick = goTitle;
}

// ---------- タイトル ----------
function renderTitle() {
  setScreen('title');
  setTalking(false);
  stepsEl.hidden = true;
  dock.innerHTML = '';
  statusEl.textContent = '';
  main.innerHTML = `<div class="title" id="titlebox">
    <img class="title-img" src="img/title.webp" alt="月夜のワードウルフ　AIと会話でウルフを探せ！">
    <div class="title-cta">
      <button class="btn moonlit huge pulse" type="button" id="begin">はじめる</button>
      <p>画面をタッチ、またはクリックしてね</p>
    </div>
  </div>`;
  const begin = () => {
    tts.unlock();
    if (K.kiosk.allowTwo) renderMode(); else newGame(1);
  };
  $('#titlebox').onclick = begin;
  focusPrimary('#begin');
}

// ---------- 人数えらび ----------
function renderMode() {
  setScreen('mode');
  statusEl.textContent = '';
  main.innerHTML = `<section class="mode">
    <h2>なんにんで あそぶ？</h2>
    <div class="mode-cards">
      <button class="mode-card" type="button" data-n="1">
        <span class="mode-faces">${K.characters.slice(0, 3).map((c) => `<img src="${esc(c.image)}" alt="">`).join('')}</span>
        <b>ひとりで あそぶ</b><span>あなた と AIの なかまたち</span>
      </button>
      <button class="mode-card" type="button" data-n="2">
        <span class="mode-faces">${K.characters.slice(0, 2).map((c) => `<img src="${esc(c.image)}" alt="">`).join('')}</span>
        <b>ふたりで あそぶ</b><span>1台の画面を こうたいで つかうよ</span>
      </button>
    </div>
    <button class="btn ghost" type="button" id="back">タイトルへもどる</button>
  </section>`;
  main.querySelectorAll('[data-n]').forEach((b) => b.onclick = () => newGame(Number(b.dataset.n)));
  $('#back').onclick = goTitle;
  focusPrimary('[data-n="1"]');
}

async function newGame(n) {
  setScreen('loading');
  main.innerHTML = '<section class="panel cover"><h2>村の じゅんびちゅう…</h2><div class="dots"><i></i><i></i><i></i></div></section>';
  try {
    game = await api('games', { humans: n });
    ui = { screen: 'rules', rule: 0, revealIdx: 0, shown: false, rendered: 0, mode: '' };
    renderRules();
  } catch (e) {
    fatal(e.message);
  }
}

// ---------- ルール説明 ----------
function ruleSlides() {
  const two = humans().length > 1;
  const wordCard = (w, wolf) => `<div class="wcard ${wolf ? 'odd' : ''}"><span>お題</span><b>${w}</b></div>`;
  return [
    {
      title: 'この村に、ウルフが ひとり まぎれこんでいる',
      body: `<div class="wcards">${wordCard('海')}${wordCard('海')}${wordCard('海')}${wordCard('プール', true)}</div>
        <p>みんなに「お題」が 1つずつ くばられます。<br>ほとんどの人は 同じお題。でも <b>1人だけ、すこし ちがうお題</b> をもっています。それが <b class="wolfmark">ウルフ</b> です。</p>
        <p class="muted">だれがウルフかは、AIにも あなたにも わかりません。<br>もしかしたら、あなたが ウルフかも…？</p>`,
    },
    {
      title: 'きょうの なかまたち',
      body: `<div class="members">${[...aisOf(), ...humans()].map((p) => `<div class="member" style="--c:${colorOf(p)}">${face(p, 'member-face')}<b>${esc(p.name)}</b><span>${esc(tagOf(p))}</span></div>`).join('')}</div>
        <p>AIたちも、自分のお題しか しりません。<br>みんなの話を聞いて、<b>ひとりひとり じぶんで考えて</b> ウルフをさがします。</p>`,
    },
    {
      title: 'あそびかた',
      body: `<ol class="howto">
        <li><b>TURN 1　ひとこと</b><span>話す順番を ルーレットで決めて、お題について ひとことずつ話そう</span></li>
        <li><b>TURN 2　しつもん</b><span>じぶんの番に、だれか1人を えらんで しつもん。聞かれた人は その場で答えるよ</span></li>
        <li><b>TURN 3　もういちど しつもん</b><span>さっきの答えで 気になった人を、もっと ほりさげよう</span></li>
        <li><b>TURN 4　いっせい投票</b><span>ウルフだと思う人に 投票。票は 全員そろってから いっせいに 公開！</span></li>
      </ol>`,
    },
    {
      title: 'かちまけ と コツ',
      body: `<div class="winlose">
          <div><b>ウルフを 追放できたら</b><span class="win">村人の かち！</span></div>
          <div><b>ちがう人を 追放したら</b><span class="lose">ウルフの かち！</span></div>
          <div><b>ウルフは さいごに</b><span>村人のお題を 当てたら <em>逆転がち</em></span></div>
        </div>
        <ul class="tips">
          <li>お題の ことばそのものは 言っちゃダメ</li>
          <li>くわしく言いすぎると、ウルフに お題がバレちゃう。ぼかしすぎると、こんどは あなたが あやしまれるよ</li>
          <li>話すときは キーボードで入力${micUsable() ? '、または マイクボタンを おして 声で話してね' : 'してね'}</li>
          ${two ? '<li>お題を見るときと 投票するときは、あいてに 画面を見せないでね</li>' : ''}
        </ul>`,
    },
  ];
}

function renderRules() {
  setScreen('rules');
  const slides = ruleSlides();
  const i = ui.rule;
  const s = slides[i];
  const last = i === slides.length - 1;
  statusEl.textContent = 'ルール説明';
  main.innerHTML = `<section class="rules panel">
    <div class="rules-head"><span class="rules-no">${i + 1} / ${slides.length}</span><button class="btn small ghost" type="button" id="skip">ルールをとばす</button></div>
    <h2>${s.title}</h2>
    <div class="rules-body">${s.body}</div>
    <div class="rules-nav">
      <button class="btn" type="button" id="prev">${i === 0 ? 'もどる' : 'まえへ'}</button>
      <div class="dots-nav">${slides.map((_, k) => `<i class="${k === i ? 'on' : ''}"></i>`).join('')}</div>
      <button class="btn moonlit big" type="button" id="nextrule">${last ? 'ゲームスタート！' : 'つぎへ'}</button>
    </div>
  </section>`;
  $('#prev').onclick = () => { if (i === 0) { goTitle(); } else { ui.rule--; renderRules(); } };
  $('#nextrule').onclick = () => { if (last) renderRoulette(); else { ui.rule++; renderRules(); } };
  $('#skip').onclick = renderRoulette;
  focusPrimary('#nextrule');
}

// ---------- ルーレット ----------
async function renderRoulette() {
  setScreen('roulette');
  ui.busy = true;
  statusEl.textContent = '順番きめ';
  main.innerHTML = `<section class="panel cover">
    <h2>ルーレットで 話す順番を きめるよ</h2>
    <div class="wheel">${game.order.map((_, i) => `<div class="slot spin" id="slot${i}"><span class="num">${i + 1}</span><span class="nm">？</span></div>`).join('')}</div>
    <button class="btn moonlit big" type="button" id="go" hidden>お題を かくにんする</button>
  </section>`;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const left = [...game.players];
  for (let i = 0; i < game.order.length; i++) {
    const slot = $(`#slot${i}`);
    if (!slot) return; // 途中でタイトルに戻った
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
  ui.busy = false;
  touch();
  const go = $('#go');
  if (!go) return;
  go.hidden = false;
  go.onclick = renderReveal;
  focusPrimary('#go');
}

// ---------- お題の確認 ----------
function renderReveal() {
  setScreen('reveal');
  const hs = humans();
  const h = hs[ui.revealIdx];
  statusEl.textContent = 'お題の かくにん';
  if (!ui.shown) {
    main.innerHTML = `<section class="panel cover">
      ${hs.length > 1 ? `<p class="banner ask" style="display:inline-block">${esc(h.name)} 以外の人は、画面を見ないでね</p>` : ''}
      <h2>${esc(h.name)}の お題</h2><p class="muted">あなたが 村人か ウルフかは、まだ わかりません。</p>
      <button class="btn moonlit big" type="button" id="show">お題を見る</button></section>`;
    focusPrimary('#show');
    $('#show').onclick = async () => {
      try { ui.word = (await post('word', { playerId: h.id })).word; ui.shown = true; renderReveal(); } catch (e) { fatal(e.message); }
    };
    return;
  }
  const last = ui.revealIdx === hs.length - 1;
  main.innerHTML = `<section class="panel cover"><p>${esc(h.name)}の お題は</p><div class="word">${esc(ui.word)}</div>
    <p class="muted">この ことばそのものは 言わないように 話してね。<br>ゲーム中も「自分のお題」ボタンで 見なおせるよ。</p>
    <button class="btn moonlit big" type="button" id="next">${last ? 'おぼえた！ 村へ行く' : 'おぼえた！ 次の人へ わたす'}</button></section>`;
  focusPrimary('#next');
  $('#next').onclick = async () => {
    ui.shown = false; ui.word = '';
    ui.revealIdx++;
    if (ui.revealIdx < hs.length) return renderReveal();
    try { game = await post('start'); } catch (e) { return fatal(e.message); }
    renderTalkShell();
    update();
  };
}

// ---------- 会話（1〜3ターン目） ----------
function renderSteps() {
  stepsEl.hidden = false;
  stepsEl.innerHTML = STEPS.map((s) => `<div class="step ${game.turn === s.n ? 'now' : game.turn > s.n ? 'done' : ''}"><b>TURN ${s.n}</b><span>${s.label}</span></div>`).join('');
}

const TURN_NOTE = {
  1: 'お題について、順番に ひとことずつ 話そう。',
  2: '順番に、だれか1人を えらんで しつもん。聞かれた人は その場で答えるよ。',
  3: 'しつもんの 2しゅうめ。さっきの答えで 気になった人を ほりさげよう。',
};
const TURN_TITLE = { 1: 'ひとことずつ', 2: 'しつもん（1しゅうめ）', 3: 'しつもん（2しゅうめ）' };

function renderTalkShell() {
  setScreen('talk');
  main.innerHTML = '<div class="log" id="log"></div>';
  sideEl.innerHTML = `<h3 class="side-h">話す順番</h3><div class="villagers" id="villagers"></div>
    <div class="side-note" id="sidenote"></div>`;
  setTalking(true);
  ui.rendered = 0; ui.lastTurn = 0; ui.mode = '';
  dock.innerHTML = '';
}

function renderSideNote() {
  const el = $('#sidenote'); if (!el) return;
  const a = P(game.actorId);
  const now = a ? (game.phase === 'qa' && game.qa.step === 'answer'
    ? `いまは ${a.name} が ${P(game.qa.from).name} の しつもんに 答える番`
    : `いまは ${a.name} の番`) : '';
  el.innerHTML = `<b>TURN ${game.turn}</b><p>${esc(TURN_NOTE[game.turn] || '')}</p>${now ? `<p class="now">${esc(now)}</p>` : ''}`;
}

function renderVillagers() {
  const el = $('#villagers'); if (!el) return;
  const active = game.actorId;
  el.innerHTML = game.order.map((id, i) => {
    const p = P(id);
    return `<div class="v ${active === id ? 'speaking' : ''}" style="--c:${colorOf(p)}"><span class="no">${i + 1}</span>${face(p)}<div class="nm">${esc(p.name)}</div><div class="tg">${esc(tagOf(p))}</div></div>`;
  }).join('');
}

function msgHtml(l) {
  const p = P(l.playerId);
  const toNames = (l.to || []).map((id) => P(id)?.name).filter(Boolean);
  const tag = l.kind === 'question' ? `<span class="to">→ ${esc(toNames.join('・'))} へ しつもん</span>`
    : l.kind === 'answer' ? `<span class="to">↩ ${esc(toNames.join('・'))} への答え</span>` : '';
  return `<div class="msg ${p.type} ${l.kind}" style="--c:${colorOf(p)}">${face(p)}<div class="bubble"><div class="who">${esc(p.name)}${tag}</div>${esc(l.text)}</div></div>`;
}

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
    const p = P(l.playerId);
    if (p.type === 'ai') tts.say(l.text, p);
  }
  $('#typing')?.remove();
  const thinking = ui.pending && P(game.actorId)?.type === 'ai' ? game.actorId : null;
  if (thinking) {
    const p = P(thinking);
    log.insertAdjacentHTML('beforeend', `<div class="msg typing" id="typing" style="--c:${colorOf(p)}">${face(p)}<div class="bubble"><div class="who">${esc(p.name)}</div><span class="dots"><i></i><i></i><i></i></span></div></div>`);
  }
  main.scrollTo({ top: main.scrollHeight, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}

/** いまの入力欄の種類。変わったときだけ作り直す（入力中の文字を消さないため）。 */
function modeOf() {
  const a = P(game.actorId);
  if (!a) return 'none';
  if (a.type === 'ai') return `ai:${a.id}:${game.phase}:${game.qa?.step || ''}`;
  if (game.phase === 'intro') return `intro:${a.id}`;
  return game.qa.step === 'ask' ? `ask:${a.id}:${game.qaRound}` : `answer:${a.id}:${game.qaRound}:${game.cursor}`;
}

const MIC_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-2.08A7 7 0 0 0 19 12h-2Z"/></svg>';

function composer({ banner = '', placeholder, extra = '' }) {
  return `<div class="composer">
    ${banner}
    ${extra}
    <form id="say" autocomplete="off">
      <button class="mic" type="button" id="mic" aria-label="声で話す" ${micUsable() ? '' : 'hidden'}>${MIC_SVG}</button>
      <input type="text" id="text" maxlength="120" placeholder="${esc(placeholder)}">
      <button class="btn moonlit" type="submit" id="send">おくる</button>
    </form>
    <div class="tools"><div class="hint" id="hint">${micUsable() ? 'マイクボタンを おすと 声で話せるよ' : 'Enter キーで おくれるよ'}</div><button class="btn small" type="button" id="peek">自分のお題</button></div>
  </div>`;
}

function buildDock(mode) {
  ui.mode = mode;
  ui.target = null;
  if (mode === 'none') { dock.innerHTML = ''; return; }
  if (mode.startsWith('ai:')) {
    const a = P(game.actorId);
    const what = game.phase === 'intro' ? 'ひとこと 考えているよ' : game.qa.step === 'ask' ? 'だれに しつもんするか 考えているよ' : `${P(game.qa.from).name} の しつもんへの 答えを 考えているよ`;
    dock.innerHTML = `<div class="composer"><div class="banner">${esc(a.name)} が ${what}…</div>
      <div class="tools"><div class="hint" id="hint"></div><button class="btn small" type="button" id="peek">自分のお題</button></div></div>`;
    $('#peek').onclick = peek;
    return;
  }
  touch();
  const [kind, pid] = mode.split(':');
  const me = P(pid);
  const two = humans().length > 1;
  const who = two ? `${esc(me.name)} の番！` : 'あなたの番！';
  if (kind === 'intro') {
    dock.innerHTML = composer({ banner: `<div class="banner now">${who} お題について <b>ひとこと</b> どうぞ。</div>`, placeholder: 'ひとこと（例: 夏になると 行きたくなるよね）' });
  } else if (kind === 'ask') {
    const targets = game.order.filter((id) => id !== pid).map(P);
    dock.innerHTML = composer({
      banner: `<div class="banner now">${who} だれに <b>しつもん</b> する？ えらんでから しつもんを 入れてね。</div>`,
      extra: `<div class="targets" id="targets">${targets.map((p) => `<button type="button" class="target" data-t="${p.id}" style="--c:${colorOf(p)}" aria-pressed="false">${face(p, 'tface')}${esc(p.name)}</button>`).join('')}</div>`,
      placeholder: 'しつもん（例: それって 一年のうち いつ楽しむもの？）',
    });
    dock.querySelectorAll('[data-t]').forEach((b) => b.onclick = () => {
      ui.target = b.dataset.t;
      dock.querySelectorAll('[data-t]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.t === ui.target)));
      $('#text').focus();
    });
  } else if (kind === 'answer') {
    const from = P(game.qa.from);
    const q = [...game.log].reverse().find((l) => l.kind === 'question');
    dock.innerHTML = composer({ banner: `<div class="banner ask">${esc(from.name)} から ${two ? esc(me.name) : 'あなた'} への しつもん:「${esc(q?.text || '')}」</div>`, placeholder: '答えを 入れてね' });
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
        // 声で「ミルフィは〜？」と聞いたときは名前から相手を決める
        const t = text.normalize('NFKC');
        target = game.order.filter((id) => id !== pid).map(P).sort((a, b) => b.name.length - a.name.length).find((p) => t.includes(p.name))?.id;
      }
      if (!target) return hint('だれに しつもんするか、上の ボタンで えらんでね');
      game = await post('ask', { playerId: pid, targetId: target, text });
    }
    box.value = '';
    hint('');
    update();
  } catch (e) {
    if (e.status === 404) return fatal(e.message);
    hint(e.message);
  }
}

function peek() {
  const hs = humans();
  const h = hs.find((x) => x.id === ui.mode.split(':')[1]) || hs[0];
  if (hs.length > 1 && !ui.peekArmed) {
    ui.peekArmed = true;
    hint(`${h.name} 以外は 画面を見ないでね。もう一度 おすと 表示します`);
    setTimeout(() => { ui.peekArmed = false; }, 4000);
    return;
  }
  ui.peekArmed = false;
  post('word', { playerId: h.id }).then(({ word }) => {
    hint(`${h.name} の お題:「${word}」（5びょうで きえます）`);
    setTimeout(() => hint(''), 5000);
  }).catch((e) => hint(e.message));
}

// ---------- 進行の同期 ----------
function update() {
  if (!game) return;
  if (['voting', 'guess', 'finished'].includes(game.phase)) {
    stopMic();
    return renderAfterTalk();
  }
  renderSteps();
  if (!$('#log')) renderTalkShell();
  renderVillagers();
  renderSideNote();
  appendNewLog();
  const mode = modeOf();
  if (mode !== ui.mode) buildDock(mode);
  statusEl.textContent = `TURN ${game.turn}`;
  if (mode.startsWith('ai:')) driveAI();
}

/** AI の手番。読み上げが終わってから次の AI を動かす。 */
async function driveAI() {
  if (ui.pending) return;
  ui.pending = true;
  const id = game.id;
  try {
    await tts.idle();
    await sleep(500);
    if (!game || game.id !== id) return;
    appendNewLog();
    const slow = setTimeout(() => hint('いま AIが 混みあっています。少し待ってね…'), 8000);
    try { game = await post('advance'); } finally { clearTimeout(slow); hint(''); }
  } catch (e) {
    if (e.status === 404) { ui.pending = false; return fatal(e.message); }
    if (e.status !== 409) hint('ちょっと 混みあっています… もう一度 ためすね');
    await sleep(1500);
    try { if (game?.id === id) game = await api(`games/${id}`); } catch {}
  } finally {
    ui.pending = false;
  }
  if (game && game.id === id) update();
}

// ---------- 投票・逆転・結果 ----------
function renderAfterTalk() {
  setTalking(false);
  dock.innerHTML = '';
  renderSteps();
  if (game.phase === 'voting') return renderVote();
  if (game.phase === 'guess') return renderGuess();
  return renderResult();
}

function renderVote() {
  setScreen('vote');
  statusEl.textContent = game.voteRound > 1 ? 'けっせん投票' : 'いっせい投票';
  tts.stop();
  const runoff = game.voteRound > 1 ? `<p class="banner">同じ票数だったので、もう一度 投票！ こうほ: ${game.candidates.map((id) => esc(P(id).name)).join('、')}</p>` : '';
  const voter = humans().find((h) => !game.voted.includes(h.id));
  if (!voter || ui.voting) {
    main.innerHTML = `<section class="panel cover"><h2>AIたちが 投票しているよ</h2><p class="muted">それぞれ じぶんの 推理だけで、べつべつに 決めています。</p><div class="dots"><i></i><i></i><i></i></div></section>`;
    return;
  }
  if (humans().length > 1 && ui.voteShownFor !== voter.id) {
    main.innerHTML = `<section class="panel cover">${runoff}<h2>${esc(voter.name)} の 投票</h2><p>ほかの人は 画面を見ないでね。</p><button class="btn moonlit big" type="button" id="open">投票する</button></section>`;
    $('#open').onclick = () => { ui.voteShownFor = voter.id; renderVote(); };
    focusPrimary('#open');
    return;
  }
  const opts = game.candidates.filter((id) => id !== voter.id).map(P);
  main.innerHTML = `<div class="vote-layout"><section class="panel vote-main">${runoff}<h2>${humans().length > 1 ? esc(voter.name) : 'あなた'} が ウルフだと思うのは？</h2>
    <p class="muted">みんなの票は、そろってから いっせいに 公開されるよ。${isWide() ? '数字キーでも えらべます。' : ''}</p>
    <div class="choices">${opts.map((p, i) => `<button class="choice" type="button" data-v="${p.id}" style="--c:${colorOf(p)}">${face(p)}<div><b>${esc(p.name)}</b><div class="muted">${esc(tagOf(p))}</div></div><kbd>${i + 1}</kbd></button>`).join('')}</div></section>
    <details class="panel vote-log" ${isWide() ? 'open' : ''}><summary>会話を 見かえす</summary><div class="log" style="margin-top:10px">${game.log.map(msgHtml).join('')}</div></details></div>`;
  ui.voteKeys = opts.map((p) => p.id);
  main.querySelectorAll('[data-v]').forEach((b) => b.onclick = async () => {
    const last = humans().filter((h) => !game.voted.includes(h.id)).length === 1;
    ui.voteShownFor = null;
    if (last) { ui.voting = true; renderVote(); }
    try {
      game = await post('vote', { playerId: voter.id, targetId: b.dataset.v });
    } catch (e) {
      ui.voting = false;
      if (e.status === 404) return fatal(e.message);
      renderVote(); return;
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
    return `<div class="line" style="animation-delay:${i * 0.3}s">${face(P(id))}<b>${esc(P(id).name)}</b><span class="arrow">→</span>${face(P(v.target))}<b>${esc(P(v.target).name)}</b></div>`;
  }).join('');
  const counts = Object.entries(h.counts).sort((a, b) => b[1] - a[1]).map(([id, n]) => `${esc(P(id).name)} ${n}票`).join(' ／ ');
  return `<section class="panel"><h2>せーの！ いっせいに 公開</h2><div class="reveal">${lines}</div><p class="muted" style="margin:10px 0 0">${counts}</p></section>`;
}

function renderGuess() {
  setScreen('guess');
  const w = P(game.guesserId);
  statusEl.textContent = '逆転の チャンス';
  main.innerHTML = `<div class="stack narrow">${voteReveal(game.voteHistory || [])}
    <section class="panel cover"><p>見やぶられたのは…</p>${face(w, 'big-face')}<div class="word" style="color:var(--wolf)">${esc(w.name)}</div>
    <p><b>${esc(w.name)} が ウルフでした！</b></p>
    <p class="muted">でも、まだ チャンスがあるよ。村人のお題を 当てたら 逆転がち！</p>
    <form id="gf" class="row" style="justify-content:center;margin-top:12px"><input type="text" id="gtext" maxlength="20" placeholder="村人のお題は？" style="max-width:260px"><button class="btn moonlit" type="submit">答える</button></form>
    </section></div>`;
  $('#gtext').focus();
  $('#gf').onsubmit = async (e) => {
    e.preventDefault();
    const guess = $('#gtext').value.trim();
    if (!guess) return;
    try { game = await post('guess', { playerId: w.id, guess }); update(); } catch (err) { fatal(err.message); }
  };
}

function bars(s) {
  return `<div class="bars">${Object.entries(s || {}).sort((a, b) => b[1] - a[1]).map(([id, v]) => {
    const p = P(id);
    return `<span>${esc(p?.name || id)}</span><div class="bar" style="--c:${p ? colorOf(p) : 'var(--mist-dim)'}"><i style="width:${Math.round(v * 100)}%"></i></div><span>${Math.round(v * 100)}%</span>`;
  }).join('')}</div>`;
}

const THOUGHT_LABEL = { intro: 'ひとこと', ask: 'しつもん', answer: '答え', vote: '投票' };

function renderResult() {
  setScreen('result');
  tts.stop();
  const r = game.result;
  const w = P(game.wolfId);
  const villageWin = r.winner === 'citizens';
  statusEl.textContent = 'けっか';
  const minds = K.kiosk.showMinds ? `<section class="panel stack"><div><h2>AIたちの 頭の中</h2><p class="muted" style="margin:0">ゲーム中は ひみつだった「だれが あやしいと思っていたか」と、それぞれの作戦です。</p></div>
      ${aisOf().map((p, i) => `<details class="mind" ${i === 0 || isWide() ? 'open' : ''} style="--c:${colorOf(p)}"><summary>${face(p, 'tface')}<b style="color:${colorOf(p)}">${esc(p.name)}</b> <span class="muted">お題「${esc(game.words[p.id])}」${p.id === game.wolfId ? '・ウルフ' : ''}</span></summary>
        ${(game.thoughts[p.id] || []).map((t) => `<div class="think"><div class="meta">TURN ${t.turn}・${THOUGHT_LABEL[t.kind] || t.kind}${typeof t.wolfSelf === 'number' && t.source === 'llm' && t.kind !== 'vote' ? `<span>自分がウルフかも度 ${Math.round(t.wolfSelf * 100)}%</span>` : ''}</div>${bars(t.suspicions)}${t.strategy ? `<div class="thought">${esc(t.strategy)}</div>` : ''}</div>`).join('')}
      </details>`).join('')}
    </section>` : '';
  main.innerHTML = `<div class="result-layout"><div class="stack">
    <section class="panel verdict ${r.winner}">
      <div class="verdict-faces">${face(w, 'big-face')}</div>
      <div class="muted">${villageWin ? 'VILLAGE WINS' : 'WOLF WINS'}</div>
      <div class="big">${villageWin ? '村人の かち！' : 'ウルフの かち！'}</div>
      <p style="margin:0 0 6px">${esc(r.reason)}</p>
      <p style="margin:0">ウルフは <span class="wolfmark">${esc(w.name)}</span>（お題「${esc(game.topic.minority)}」）。<br>村人のお題は「${esc(game.topic.majority)}」でした。</p>
      ${r.guess ? `<p class="muted">ウルフの 逆転チャレンジ:「${esc(r.guess.text)}」 ${r.guess.correct ? '⭕ せいかい！' : '❌ ざんねん'}</p>` : ''}
    </section>
    ${voteReveal(game.voteHistory)}
    <section class="panel"><h2>投票の りゆう</h2><div class="tbl"><table>
      <thead><tr><th>投票した人</th><th>投票先</th><th>りゆう</th></tr></thead><tbody>
      ${game.order.map((id) => { const v = game.voteHistory[game.voteHistory.length - 1]?.votes[id]; const p = P(id); return v ? `<tr><td>${esc(p.name)}${id === game.wolfId ? ' <span class="wolfmark">ウルフ</span>' : ''}<div class="muted">${esc(game.words[id])}</div></td><td>${esc(P(v.target).name)}</td><td>${esc(v.reason || '—')}</td></tr>` : ''; }).join('')}
      </tbody></table></div></section>
    <div class="row" style="justify-content:center"><button class="btn moonlit big" type="button" id="again">もう一回 あそぶ</button><button class="btn big" type="button" id="back">タイトルへ</button></div>
    <p class="note" id="countdown"></p>
    </div><div class="stack">
    ${minds}
    <details class="panel"><summary>会話を ぜんぶ見る</summary><div class="log" style="margin-top:10px">${game.log.map(msgHtml).join('')}</div></details>
  </div></div>`;
  main.scrollTo({ top: 0 });
  $('#again').onclick = () => { clearInterval(ui.resultTimer); game = null; if (K.kiosk.allowTwo) renderMode(); else newGame(1); };
  $('#back').onclick = goTitle;
  focusPrimary('#again');
  // しばらく操作がなければタイトルへ
  clearInterval(ui.resultTimer);
  ui.resultTimer = setInterval(() => {
    const left = Math.ceil((K.kiosk.resultSec * 1000 - (Date.now() - lastInput)) / 1000);
    const el = $('#countdown');
    if (!el) { clearInterval(ui.resultTimer); return; }
    if (left <= 0) { clearInterval(ui.resultTimer); goTitle(); return; }
    el.textContent = left <= 30 ? `あと ${left} びょうで タイトルに もどります` : '';
  }, 1000);
}

// ---------- キーボード ----------
document.addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, textarea, select') || e.ctrlKey || e.metaKey || e.altKey) return;
  if (ui.screen === 'title' && e.target === document.body && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); $('#titlebox')?.click(); return; }
  if (ui.screen === 'rules') {
    if (e.key === 'ArrowRight') $('#nextrule')?.click();
    if (e.key === 'ArrowLeft' && ui.rule > 0) $('#prev')?.click();
  }
  if (game?.phase === 'voting' && /^[1-9]$/.test(e.key)) {
    const id = ui.voteKeys?.[Number(e.key) - 1];
    const btn = id && main.querySelector(`[data-v="${id}"]`);
    if (btn) { e.preventDefault(); btn.click(); }
  }
});
// 展示中に右クリックメニューや長押しメニューが出ないように
addEventListener('contextmenu', (e) => { if (!e.target.closest('input')) e.preventDefault(); });

// ---------- 起動 ----------
(async function init() {
  for (let i = 0; ; i++) {
    try { K = await api('kiosk'); break; } catch (e) {
      main.innerHTML = '<section class="panel cover"><h2>じゅんびちゅう…</h2><p class="muted">サーバーの起動を まっています</p></section>';
      await sleep(Math.min(5000, 1000 + i * 500));
    }
  }
  renderTitle();
})();
