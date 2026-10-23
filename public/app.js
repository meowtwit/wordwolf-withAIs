// Word Wolf with AIs — フロントエンド（依存なし）
const $app = document.getElementById('app');
const $status = document.getElementById('status');
const $modal = document.getElementById('modal');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const AI_COLORS = ['var(--ai1)', 'var(--ai2)', 'var(--ai3)', 'var(--ai4)'];
const AI_PRESETS = [
  { name: 'AI 01', personality: 'analyst' },
  { name: 'AI 02', personality: 'questioner' },
  { name: 'AI 03', personality: 'trickster' },
  { name: 'AI 04', personality: 'cheerful' },
];

let config = { providers: [], personalities: [] };
let game = null;
const ui = { revealIndex: 0, revealShown: false, voteShown: false, pending: false, pendingLabel: '', error: '', notice: '' };

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 保存できなくても動く */ } },
};

let setup = null;

async function api(path, body) {
  const res = await fetch(`/api/${path}`, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function run(label, fn) {
  ui.pending = true; ui.pendingLabel = label; ui.error = '';
  render();
  try {
    await fn();
  } catch (e) {
    ui.error = e.message;
  } finally {
    ui.pending = false; ui.pendingLabel = '';
    render();
  }
}

// ---------- helpers ----------
const humans = () => game.players.filter((p) => p.type === 'human');
const player = (id) => game.players.find((p) => p.id === id);
function colorOf(p) {
  if (p.type === 'human') return 'var(--human)';
  return AI_COLORS[(Number(p.id.replace('ai', '')) - 1) % AI_COLORS.length];
}
function initials(p) { return p.type === 'human' ? p.name.slice(0, 2) : p.name.replace(/\s+/g, '').slice(-2); }
function avatar(p) { return `<div class="avatar" style="--c:${colorOf(p)}">${esc(initials(p))}</div>`; }
const providerLabel = (id) => config.providers.find((p) => p.id === id)?.label || id;
const personalityLabel = (id) => config.personalities.find((p) => p.id === id)?.label || id;

// ---------- setup ----------
function defaultSetup() {
  const firstReal = config.providers.find((p) => p.id !== 'mock' && p.id !== 'ollama' && p.available);
  const provider = firstReal ? firstReal.id : 'mock';
  return {
    humanCount: 1,
    humanNames: ['あなた', 'P2'],
    rounds: 2,
    ais: AI_PRESETS.slice(0, 3).map((a) => ({ ...a, provider, model: '' })),
  };
}

function renderSetup() {
  $status.textContent = '';
  const providerOptions = (sel) => config.providers.map((p) =>
    `<option value="${p.id}" ${p.id === sel ? 'selected' : ''} ${p.available ? '' : 'disabled'}>${esc(p.label)}${p.available ? '' : '（キー未設定）'}</option>`).join('');
  const personalityOptions = (sel) => config.personalities.map((p) =>
    `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${esc(p.label)}</option>`).join('');

  $app.innerHTML = `
    <section class="card">
      <h2>ゲームの流れ</h2>
      <p class="muted">1人だけ違うお題を持つ「ウルフ」を会話で探します。誰がウルフかはAIにも、あなたにも分かりません。
      全員が順番に発言し、${setup.rounds}周したら投票。最多票の人を追放します。ウルフが追放されても、多数派のお題を当てれば逆転勝利です。</p>
    </section>

    <section class="card">
      <h2>人間プレイヤー</h2>
      <div class="seg" role="group" aria-label="人数">
        ${[1, 2].map((n) => `<button data-humans="${n}" class="${setup.humanCount === n ? 'on' : ''}">${n}人</button>`).join('')}
      </div>
      <div class="grid" style="margin-top:8px">
        ${Array.from({ length: setup.humanCount }, (_, i) => `
          <div><label for="hn${i}">プレイヤー${i + 1}の名前</label>
          <input type="text" id="hn${i}" data-hname="${i}" maxlength="12" value="${esc(setup.humanNames[i])}"></div>`).join('')}
      </div>
      ${setup.humanCount === 2 ? '<p class="muted">2人の場合はスマホやPCを交代で使います。お題の確認と投票の時は、相手に画面を見せないでください。</p>' : ''}
    </section>

    <section class="card">
      <div class="row" style="justify-content:space-between">
        <h2 style="margin:0">AIプレイヤー</h2>
        <div class="row">
          <button class="btn small" data-ai-remove ${setup.ais.length <= 1 ? 'disabled' : ''}>− 減らす</button>
          <button class="btn small" data-ai-add ${setup.ais.length >= 4 ? 'disabled' : ''}>＋ 増やす</button>
        </div>
      </div>
      <p class="muted">AIはそれぞれ独立した記憶を持ち、自分のお題と公開された会話だけを見て推理します。</p>
      <div class="grid">
        ${setup.ais.map((a, i) => {
          const prov = config.providers.find((p) => p.id === a.provider);
          return `
          <div class="ai-card" style="--c:${AI_COLORS[i]}">
            <label>名前</label><input type="text" data-ai="${i}" data-field="name" maxlength="12" value="${esc(a.name)}">
            <label>性格</label><select data-ai="${i}" data-field="personality">${personalityOptions(a.personality)}</select>
            <label>AIモデル</label><select data-ai="${i}" data-field="provider">${providerOptions(a.provider)}</select>
            ${a.provider !== 'mock' ? `<label>モデル名（空欄で既定: ${esc(prov?.defaultModel)}）</label>
            <input type="text" data-ai="${i}" data-field="model" value="${esc(a.model)}" placeholder="${esc(prov?.defaultModel)}">` : ''}
          </div>`;
        }).join('')}
      </div>
    </section>

    <section class="card">
      <h2>会話の周回数</h2>
      <div class="seg">${[1, 2, 3].map((n) => `<button data-rounds="${n}" class="${setup.rounds === n ? 'on' : ''}">${n}周</button>`).join('')}</div>
    </section>

    <div class="row" style="justify-content:center">
      <button class="btn primary big" data-start ${ui.pending ? 'disabled' : ''}>ゲーム開始</button>
    </div>
    ${ui.error ? `<p class="error" style="text-align:center">${esc(ui.error)}</p>` : ''}
  `;

  $app.querySelectorAll('[data-humans]').forEach((b) => b.onclick = () => { setup.humanCount = Number(b.dataset.humans); saveSetup(); render(); });
  $app.querySelectorAll('[data-rounds]').forEach((b) => b.onclick = () => { setup.rounds = Number(b.dataset.rounds); saveSetup(); render(); });
  $app.querySelectorAll('[data-hname]').forEach((el) => el.oninput = () => { setup.humanNames[el.dataset.hname] = el.value; saveSetup(); });
  $app.querySelectorAll('[data-ai]').forEach((el) => {
    const handler = () => {
      setup.ais[el.dataset.ai][el.dataset.field] = el.value;
      if (el.dataset.field === 'provider') setup.ais[el.dataset.ai].model = '';
      saveSetup();
      if (el.tagName === 'SELECT') render();
    };
    el.tagName === 'SELECT' ? (el.onchange = handler) : (el.oninput = handler);
  });
  $app.querySelector('[data-ai-add]').onclick = () => {
    const base = setup.ais[setup.ais.length - 1];
    setup.ais.push({ ...AI_PRESETS[setup.ais.length], provider: base.provider, model: base.model });
    saveSetup(); render();
  };
  $app.querySelector('[data-ai-remove]').onclick = () => { setup.ais.pop(); saveSetup(); render(); };
  $app.querySelector('[data-start]').onclick = startGame;
}

function saveSetup() { store.set('ww-setup', setup); }

function startGame() {
  run('ゲームを準備中…', async () => {
    game = await api('games', {
      humans: setup.humanNames.slice(0, setup.humanCount).map((name) => ({ name })),
      ais: setup.ais,
      rounds: setup.rounds,
    });
    Object.assign(ui, { revealIndex: 0, revealShown: false, voteShown: false, notice: '' });
    ui.word = {};
  });
}

// ---------- reveal ----------
function renderReveal() {
  const hs = humans();
  const h = hs[ui.revealIndex];
  $status.textContent = 'お題の確認';
  if (!ui.revealShown) {
    $app.innerHTML = `
      <section class="card cover">
        ${hs.length > 1 ? `<p>他の人は画面を見ないでください。</p>` : ''}
        <h2>${esc(h.name)}さんのお題</h2>
        <p class="muted">ボタンを押すと、あなただけのお題が表示されます。</p>
        <button class="btn primary big" data-show ${ui.pending ? 'disabled' : ''}>お題を見る</button>
        ${ui.error ? `<p class="error">${esc(ui.error)}</p>` : ''}
      </section>`;
    $app.querySelector('[data-show]').onclick = () => run('', async () => {
      const { word } = await api(`games/${game.id}/word`, { playerId: h.id });
      ui.word[h.id] = word;
      ui.revealShown = true;
    });
    return;
  }
  const last = ui.revealIndex === hs.length - 1;
  $app.innerHTML = `
    <section class="card cover">
      <p>${esc(h.name)}さんのお題は</p>
      <div class="big-word">${esc(ui.word[h.id])}</div>
      <p class="muted">あなたが多数派か、ウルフかは分かりません。お題そのものは言わないように！</p>
      <button class="btn primary big" data-next>${last ? '覚えた！ 会話を始める' : '覚えた！ 次の人へ渡す'}</button>
    </section>`;
  $app.querySelector('[data-next]').onclick = () => {
    ui.revealShown = false;
    if (hs.length > 1) delete ui.word[h.id]; // 2人プレイでは画面上に残さない
    ui.revealIndex++;
    render();
  };
}

// ---------- discussion ----------
function playersStrip() {
  return `<div class="players">${game.players.map((p) => `
    <div class="player ${p.id === game.currentSpeakerId ? 'active' : ''}" style="--c:${colorOf(p)}">
      ${game.phase === 'voting' && game.voted.includes(p.id) ? '<span class="voted" title="投票済み">✅</span>' : ''}
      ${avatar(p)}
      <div class="name">${esc(p.name)}</div>
      <div class="sub">${p.type === 'human' ? '人間' : esc(personalityLabel(p.personality))}</div>
    </div>`).join('')}</div>`;
}

function chatLog({ typingId } = {}) {
  let html = '';
  let lastRound = 0;
  const meIds = humans().length === 1 ? [humans()[0].id] : [];
  for (const l of game.log) {
    if (l.round !== lastRound) { html += `<div class="round-sep">― ${l.round}周目 ―</div>`; lastRound = l.round; }
    const p = player(l.playerId);
    html += `<div class="msg ${meIds.includes(p.id) ? 'me' : ''}" style="--c:${colorOf(p)}">${avatar(p)}
      <div class="bubble"><div class="who">${esc(p.name)}</div>${esc(l.text)}</div></div>`;
  }
  if (typingId) {
    const p = player(typingId);
    html += `<div class="msg typing" style="--c:${colorOf(p)}">${avatar(p)}
      <div class="bubble"><div class="who">${esc(p.name)}</div><span class="dots"><span>●</span><span>●</span><span>●</span></span> 考え中</div></div>`;
  }
  return `<div class="chat">${html || '<p class="muted" style="text-align:center">会話を始めましょう。</p>'}</div>`;
}

function wordButtons() {
  return humans().map((h) => `<button class="btn small" data-peek="${h.id}">🔒 ${esc(h.name)}のお題</button>`).join(' ');
}

function bindPeek() {
  $app.querySelectorAll('[data-peek]').forEach((b) => b.onclick = () => peekWord(b.dataset.peek));
}

function peekWord(id) {
  const p = player(id);
  $modal.innerHTML = `<div class="card cover">
    <h2>${esc(p.name)}さんのお題</h2>
    ${humans().length > 1 ? '<p class="muted">他の人に見られていないか確認してください。</p>' : ''}
    <div class="big-word" id="peek-word">••••</div>
    <div class="row" style="justify-content:center">
      <button class="btn primary" data-reveal>表示する</button><button class="btn" data-close>閉じる</button>
    </div></div>`;
  $modal.classList.remove('hidden');
  $modal.querySelector('[data-close]').onclick = () => { $modal.classList.add('hidden'); $modal.innerHTML = ''; };
  $modal.querySelector('[data-reveal]').onclick = async () => {
    try {
      const { word } = await api(`games/${game.id}/word`, { playerId: id });
      document.getElementById('peek-word').textContent = word;
    } catch (e) { document.getElementById('peek-word').textContent = e.message; }
  };
}

let advanceTimer = null;
function scheduleAdvance() {
  clearTimeout(advanceTimer);
  advanceTimer = setTimeout(() => {
    if (!game || game.phase !== 'discussion' || ui.pending) return;
    const sp = player(game.currentSpeakerId);
    if (sp?.type !== 'ai') return;
    run('', async () => { game = await api(`games/${game.id}/advance`, {}); });
  }, 900);
}

function renderDiscussion() {
  const sp = player(game.currentSpeakerId);
  $status.textContent = `${game.round}/${game.rounds}周目・発言 ${game.turn + 1}/${game.totalTurns}`;
  const aiTurn = sp.type === 'ai';
  $app.innerHTML = `
    ${playersStrip()}
    <div class="row" style="justify-content:flex-end;margin-bottom:10px">${wordButtons()}</div>
    <section class="card">${chatLog({ typingId: aiTurn && ui.pending ? sp.id : null })}
      ${ui.error ? `<p class="error">${esc(ui.error)} <button class="btn small" data-retry>再試行</button></p>` : ''}
    </section>
    ${aiTurn ? '' : `<div class="composer"><div class="inner">
      <div class="hint">${esc(sp.name)}さんの番です（お題そのものは言わないように）</div>
      <form data-speak><input type="text" id="speech" maxlength="120" placeholder="発言を入力…" autocomplete="off" ${ui.pending ? 'disabled' : ''}>
      <button class="btn primary" ${ui.pending ? 'disabled' : ''}>発言</button></form></div></div>`}
  `;
  bindPeek();
  window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  const retry = $app.querySelector('[data-retry]');
  if (retry) retry.onclick = () => { ui.error = ''; render(); };
  if (aiTurn) {
    if (!ui.pending && !ui.error) scheduleAdvance();
    return;
  }
  const form = $app.querySelector('[data-speak]');
  const input = document.getElementById('speech');
  input.focus();
  form.onsubmit = (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    run('', async () => { game = await api(`games/${game.id}/speak`, { playerId: sp.id, text }); });
  };
}

// ---------- voting ----------
function renderVoting() {
  $status.textContent = game.voteRound > 1 ? '決選投票' : '投票';
  const voter = humans().find((h) => !game.voted.includes(h.id));
  const runoff = game.voteRound > 1
    ? `<p class="muted">同票のため決選投票です。候補: ${game.candidates.map((id) => esc(player(id).name)).join('、')}</p>` : '';

  if (!voter || ui.pending) {
    $app.innerHTML = `${playersStrip()}<section class="card cover"><h2>AIが投票中…</h2><div class="spinner"></div>
      <p class="muted">それぞれのAIが、自分の推理をもとに独立して投票しています。</p>
      ${ui.error ? `<p class="error">${esc(ui.error)}</p>` : ''}</section>`;
    return;
  }

  if (humans().length > 1 && !ui.voteShown) {
    $app.innerHTML = `${playersStrip()}<section class="card cover">${runoff}
      <h2>${esc(voter.name)}さんの投票</h2><p>他の人は画面を見ないでください。</p>
      <button class="btn primary big" data-open>投票する</button></section>`;
    $app.querySelector('[data-open]').onclick = () => { ui.voteShown = true; render(); };
    return;
  }

  const options = game.candidates.filter((id) => id !== voter.id).map(player);
  $app.innerHTML = `
    ${playersStrip()}
    <section class="card">
      <h2>${esc(voter.name)}さん、ウルフだと思う人に投票してください</h2>${runoff}
      <div class="vote-list">${options.map((p) => `
        <button class="vote-option" data-vote="${p.id}" style="--c:${colorOf(p)}">${avatar(p)}<div><b>${esc(p.name)}</b>
        <div class="muted">${p.type === 'human' ? '人間' : esc(personalityLabel(p.personality))}</div></div></button>`).join('')}
      </div>
      ${ui.error ? `<p class="error">${esc(ui.error)}</p>` : ''}
    </section>
    <details class="card"><summary>会話ログを見返す</summary><div style="margin-top:10px">${chatLog()}</div></details>`;
  $app.querySelectorAll('[data-vote]').forEach((b) => b.onclick = () => {
    run('', async () => {
      const before = game.voteRound;
      game = await api(`games/${game.id}/vote`, { playerId: voter.id, targetId: b.dataset.vote });
      ui.voteShown = false;
      if (game.phase === 'voting' && game.voteRound > before) ui.notice = '同票でした。決選投票を行います。';
    });
  });
}

// ---------- guess ----------
function renderGuess() {
  const wolf = player(game.guesserId);
  $status.textContent = '逆転のチャンス';
  $app.innerHTML = `
    <section class="card cover">
      <p>追放されたのは…</p>
      <div class="big-word" style="color:var(--danger)">${esc(wolf.name)}</div>
      <p><b>${esc(wolf.name)}さんはウルフでした！</b></p>
      <p class="muted">${esc(wolf.name)}さん、多数派のお題を当てれば逆転勝利です。</p>
      <form data-guess class="row" style="justify-content:center;margin-top:12px">
        <input type="text" id="guess" maxlength="30" placeholder="多数派のお題は？" style="max-width:260px">
        <button class="btn primary" ${ui.pending ? 'disabled' : ''}>回答する</button>
      </form>
      ${ui.error ? `<p class="error">${esc(ui.error)}</p>` : ''}
    </section>`;
  $app.querySelector('[data-guess]').onsubmit = (e) => {
    e.preventDefault();
    const guess = document.getElementById('guess').value.trim();
    if (!guess) return;
    run('', async () => { game = await api(`games/${game.id}/guess`, { playerId: wolf.id, guess }); });
  };
}

// ---------- results ----------
function suspicionBars(susp) {
  return `<div class="bars">${Object.entries(susp || {}).sort((a, b) => b[1] - a[1]).map(([id, v]) => {
    const p = player(id);
    return `<span>${esc(p?.name || id)}</span><div class="bar" style="--c:${p ? colorOf(p) : 'var(--muted)'}"><i style="width:${Math.round(v * 100)}%"></i></div><span>${Math.round(v * 100)}%</span>`;
  }).join('')}</div>`;
}

function renderResults() {
  const r = game.result;
  const wolf = player(game.wolfId);
  const expelled = r.expelledId ? player(r.expelledId) : null;
  $status.textContent = 'ゲーム終了';
  const lastVotes = game.voteHistory[game.voteHistory.length - 1];
  const sourceTag = (s) => s.source === 'fallback'
    ? `<span class="tag warn" title="${esc(s.error)}">API失敗→オフラインで代行</span>`
    : s.source === 'mock' ? '<span class="tag">オフライン</span>' : '';

  $app.innerHTML = `
    <section class="card banner ${r.winner}">
      <div class="muted">${r.winner === 'wolf' ? 'WOLF WINS' : 'CITIZENS WIN'}</div>
      <div class="win">${r.winner === 'wolf' ? 'ウルフの勝ち！' : '多数派の勝ち！'}</div>
      <p>${esc(r.reason)}</p>
      <p>ウルフは <b class="wolf-mark">${esc(wolf.name)}</b>（お題「${esc(game.topic.minority)}」）。
      多数派のお題は「${esc(game.topic.majority)}」でした。</p>
      ${expelled ? `<p class="muted">追放: ${esc(expelled.name)}</p>` : ''}
      ${r.guess ? `<p class="muted">ウルフの逆転回答: 「${esc(r.guess.text)}」 ${r.guess.correct ? '⭕ 正解' : '❌ 不正解'}${r.guess.reason ? `（${esc(r.guess.reason)}）` : ''}</p>` : ''}
    </section>

    <section class="card">
      <h2>投票結果${game.voteHistory.length > 1 ? '（決選投票）' : ''}</h2>
      <table><thead><tr><th>投票者</th><th>投票先</th><th>理由</th></tr></thead><tbody>
      ${game.players.map((p) => {
        const v = lastVotes?.votes[p.id];
        return v ? `<tr><td>${esc(p.name)}${p.id === game.wolfId ? ' <span class="wolf-mark">🐺</span>' : ''}<div class="muted">${esc(game.words[p.id])}</div></td>
          <td>${esc(player(v.target).name)}</td><td>${esc(v.reason || '—')}</td></tr>` : '';
      }).join('')}
      </tbody></table>
    </section>

    <section class="card">
      <h2>AIたちの推理の舞台裏</h2>
      <p class="muted">ゲーム中は非公開だった、各AIの「誰が怪しいか」の変化と作戦です。</p>
      ${game.players.filter((p) => p.type === 'ai').map((p) => `
        <details class="card" style="background:var(--panel-2)" ${p === game.players.find((x) => x.type === 'ai') ? 'open' : ''}>
          <summary><b style="color:${colorOf(p)}">${esc(p.name)}</b>
            <span class="muted">— ${esc(personalityLabel(p.personality))} / ${esc(providerLabel(p.provider))}${p.model ? ` (${esc(p.model)})` : ''} / お題「${esc(game.words[p.id])}」${p.id === game.wolfId ? ' 🐺' : ''}</span></summary>
          <div class="timeline" style="margin-top:10px">
            ${(game.thoughts[p.id] || []).map((t) => `
              <div class="step">
                <div class="meta">${t.kind === 'vote' ? '🗳 投票時' : `💬 ${t.round}周目の発言時`}
                  ${typeof t.wolfSelf === 'number' && t.kind === 'speech' && t.source === 'llm' ? `・自分がウルフだと思う確率 ${Math.round(t.wolfSelf * 100)}%` : ''} ${sourceTag(t)}</div>
                ${suspicionBars(t.suspicions)}
                ${t.strategy ? `<div class="strategy">💭 ${esc(t.strategy)}</div>` : ''}
              </div>`).join('')}
          </div>
        </details>`).join('')}
    </section>

    <details class="card"><summary>会話ログ</summary><div style="margin-top:10px">${chatLog()}</div></details>

    <div class="row" style="justify-content:center">
      <button class="btn primary big" data-again>同じ設定でもう一度</button>
      <button class="btn big" data-setup>設定に戻る</button>
    </div>`;
  $app.querySelector('[data-again]').onclick = startGame;
  $app.querySelector('[data-setup]').onclick = () => { game = null; ui.error = ''; render(); };
  window.scrollTo({ top: 0 });
}

// ---------- router ----------
function render() {
  if (!game) return renderSetup();
  if (ui.revealIndex < humans().length) return renderReveal();
  if (ui.notice) {
    const n = ui.notice; ui.notice = '';
    setTimeout(() => alert(n), 50);
  }
  switch (game.phase) {
    case 'discussion': return renderDiscussion();
    case 'voting': return renderVoting();
    case 'guess': return renderGuess();
    case 'finished': return renderResults();
    default: $app.textContent = `unknown phase: ${game.phase}`;
  }
}

(async function init() {
  try {
    config = await api('config');
  } catch (e) {
    $app.innerHTML = `<p class="error">サーバーに接続できません: ${esc(e.message)}</p>`;
    return;
  }
  const saved = store.get('ww-setup', null);
  setup = saved && Array.isArray(saved.ais) ? saved : defaultSetup();
  // 保存された設定のプロバイダが使えなくなっていたらオフラインに戻す
  for (const a of setup.ais) {
    if (!config.providers.find((p) => p.id === a.provider && p.available)) { a.provider = 'mock'; a.model = ''; }
  }
  render();
})();
