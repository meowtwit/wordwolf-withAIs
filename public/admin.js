// 管理画面。キャラクター・AI 接続・展示の動きを変更して data/settings.json に保存する。
const $ = (s, el = document) => el.querySelector(s);
const app = $('#app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let S = null; // 管理画面用の設定
let providers = [];
let file = '';
let dirty = false;

const pin = {
  get() { try { return sessionStorage.getItem('ww-admin-pin') || ''; } catch { return ''; } },
  set(v) { try { sessionStorage.setItem('ww-admin-pin', v); } catch {} },
};

async function api(path, body) {
  const res = await fetch(`/api/admin/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-pin': pin.get() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || `HTTP ${res.status}`); e.status = res.status; throw e; }
  return data;
}

function renderPin(msg = '') {
  $('#savebar').hidden = true;
  app.innerHTML = `<section class="panel cover" style="max-width:420px;margin:10vh auto">
    <h2>管理画面</h2><p class="muted">PIN を入れてください</p>
    <form id="pf" class="row" style="justify-content:center"><input type="password" id="pin" style="max-width:180px" autocomplete="off"><button class="btn moonlit">開く</button></form>
    ${msg ? `<p class="err">${esc(msg)}</p>` : ''}</section>`;
  $('#pin').focus();
  $('#pf').onsubmit = (e) => { e.preventDefault(); pin.set($('#pin').value); load(); };
}

async function load() {
  try {
    const d = await api('settings');
    S = d.settings; providers = d.providers; file = d.file;
    dirty = false;
    render();
  } catch (e) {
    if (e.status === 401) return renderPin(pin.get() ? 'PIN が違います' : '');
    app.innerHTML = `<p class="err">読み込めませんでした: ${esc(e.message)}</p>`;
  }
}

const provOpts = (sel) => providers.map((p) => `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${esc(p.label)}${p.available ? '' : '（キー未設定→オフラインで代行）'}</option>`).join('');

function render() {
  const k = S.kiosk;
  const a = S.api;
  const enabled = S.characters.filter((c) => c.enabled).length;
  const keyState = a.hasKey ? `<span class="ok">設定済み（末尾 ${esc(a.keyTail)}）</span>` : a.envKey ? '<span class="ok">.env のキーを使用中</span>' : '<span class="warn">未設定（AIはオフラインの簡易モードで話します）</span>';
  app.innerHTML = `
    <header class="row" style="justify-content:space-between">
      <div class="brand"><div class="moon" aria-hidden="true"></div><h1>月夜のワードウルフ　管理画面</h1></div>
      <span class="muted">お客さん向けの画面には出ません</span>
    </header>

    <section class="panel">
      <h2>AI との接続（Google Gemini）</h2>
      <p class="lead muted">APIキーは <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener" style="color:var(--moon)">Google AI Studio</a> で作れます。キーはこのPCの設定ファイルにだけ保存され、ゲーム画面には送られません。</p>
      <div class="grid2">
        <div><label class="f" for="key">APIキー　${keyState}</label>
          <input type="password" id="key" placeholder="${a.hasKey ? '変えるときだけ入力' : 'AIza... または AQ. で始まるキー'}" autocomplete="off">
          ${a.hasKey ? '<label class="check" style="margin-top:6px"><input type="checkbox" id="clearKey"> 保存されているキーを消す</label>' : ''}</div>
        <div><label class="f" for="model">モデル</label><input type="text" id="model" value="${esc(a.geminiModel)}">
          <p class="hint">おすすめ: gemini-flash-lite-latest（返事が約1秒）。gemini-flash-latest は1回60秒以上かかることがあります。</p></div>
        <div><label class="f" for="rpm">1分あたりの呼び出し上限</label><input type="number" id="rpm" min="0" max="10000" value="${a.geminiRpm}">
          <p class="hint">無料枠は15回/分なので 12 がおすすめ。有料にしたら 0（制限なし）や 300 などに。</p></div>
      </div>
      <div class="row" style="margin-top:12px"><button class="btn" type="button" id="test">接続テスト（AIを1回呼ぶ）</button><span class="hint">保存してからテストしてください</span></div>
      <div id="testout"></div>
    </section>

    <section class="panel">
      <h2>キャラクター</h2>
      <p class="lead muted">1ゲームに出るのは、有効なキャラクターの中からランダムに ${k.aiCount} 人です（下の「展示の動き」で変更）。いま有効: ${enabled} 人${enabled < 2 ? '　<span class="warn">2人以上を有効にしてください</span>' : ''}</p>
      <div class="chars">${S.characters.map((c, i) => `
        <div class="char ${c.enabled ? '' : 'off'}" style="--c:${esc(c.color)}" data-i="${i}">
          <div><img src="${esc(c.image)}" alt=""><label class="check" style="margin-top:8px"><input type="checkbox" data-f="enabled" ${c.enabled ? 'checked' : ''}> 出場する</label></div>
          <div class="fields">
            <div><label class="f">名前（声で呼びやすい名前に）</label><input type="text" data-f="name" maxlength="10" value="${esc(c.name)}"></div>
            <div><label class="f">ひとこと紹介（お客さんに見えます）</label><input type="text" data-f="tagline" maxlength="40" value="${esc(c.tagline)}"></div>
            <div class="full"><label class="f">性格（AIへの指示。お客さんには見えません）</label><textarea data-f="personality" maxlength="400">${esc(c.personality)}</textarea></div>
            <div class="full"><label class="f">話し方・口ぐせ</label><textarea data-f="speech" maxlength="200" style="min-height:50px">${esc(c.speech)}</textarea></div>
            <div><label class="f">AI</label><select data-f="provider">${provOpts(c.provider)}</select></div>
            <div><label class="f">モデル（空欄で上の設定）</label><input type="text" data-f="model" value="${esc(c.model)}" placeholder="${esc(a.geminiModel)}"></div>
            <div><label class="f">テーマ色</label><input type="color" data-f="color" value="${esc(c.color)}"></div>
            <div><label class="f">声の高さ <span data-pitch>${c.voicePitch}</span></label><div class="row" style="flex-wrap:nowrap"><input type="range" min="0.5" max="2" step="0.05" data-f="voicePitch" value="${c.voicePitch}"><button class="btn small" type="button" data-voice>試す</button></div></div>
            <div class="full"><label class="f">画像ファイル（public フォルダからの場所）</label><input type="text" data-f="image" value="${esc(c.image)}"></div>
            <div class="full row" style="justify-content:space-between"><button class="btn small" type="button" data-test>このキャラで接続テスト</button><button class="btn small ghost" type="button" data-reset>初期値にもどす</button></div>
          </div>
        </div>`).join('')}</div>
    </section>

    <section class="panel">
      <h2>展示の動き</h2>
      <div class="grid2">
        <div class="stack" style="gap:8px">
          <label class="check"><input type="checkbox" id="allowTwo" ${k.allowTwo ? 'checked' : ''}> 「ふたりで あそぶ」を出す</label>
          <label class="check"><input type="checkbox" id="voice" ${k.voice ? 'checked' : ''}> AIの発言を読み上げる</label>
          <label class="check"><input type="checkbox" id="mic" ${k.mic ? 'checked' : ''}> マイクボタンを出す（声で話せる）</label>
          <label class="check"><input type="checkbox" id="showMinds" ${k.showMinds ? 'checked' : ''}> 結果画面で「AIたちの頭の中」を見せる</label>
        </div>
        <div><label class="f" for="aiCount">1ゲームに出るAIの人数</label><select id="aiCount">${[2, 3, 4].map((n) => `<option value="${n}" ${n === k.aiCount ? 'selected' : ''}>${n}人</option>`).join('')}</select>
          <p class="hint">3人がおすすめ（人間1人と合わせて4人、1ゲーム約5〜8分）。</p></div>
        <div><label class="f" for="idleSec">操作がないとき「まだ遊んでいますか？」を出すまで（秒）</label><input type="number" id="idleSec" min="30" max="3600" value="${k.idleSec}">
          <p class="hint">20秒だれも押さなければタイトルに戻ります。</p></div>
        <div><label class="f" for="resultSec">結果画面からタイトルに戻るまで（秒）</label><input type="number" id="resultSec" min="15" max="3600" value="${k.resultSec}"></div>
      </div>
    </section>

    <section class="panel">
      <h2>管理画面の PIN</h2>
      <p class="lead muted">設定すると、この画面を開くときに PIN が必要になります。${S.hasPin ? '<span class="ok">いまは PIN あり</span>' : 'いまは PIN なし'}</p>
      <div class="row"><input type="password" id="newPin" placeholder="新しい PIN（数字など）" style="max-width:220px" autocomplete="new-password">
      ${S.hasPin ? '<label class="check"><input type="checkbox" id="clearPin"> PIN をなくす</label>' : ''}</div>
    </section>

    <section class="panel">
      <h2>そのほか</h2>
      <div class="kv"><span class="muted">設定ファイル</span><span>${esc(file)}</span>
      <span class="muted">ゲーム画面</span><span>http://localhost:${location.port || 80}/</span></div>
      <div class="row" style="margin-top:12px"><button class="btn" type="button" id="shutdown">サーバーを止める</button><span class="hint">展示を終えるとき。もう一度遊ぶときは start.bat をダブルクリック。</span></div>
    </section>`;

  $('#savebar').hidden = false;
  bind();
}

function markDirty() {
  dirty = true;
  $('#savemsg').className = 'warn';
  $('#savemsg').textContent = 'まだ保存していない変更があります';
}

function bind() {
  app.querySelectorAll('input, textarea, select').forEach((el) => el.addEventListener('input', markDirty));
  app.querySelectorAll('.char').forEach((card) => {
    const i = Number(card.dataset.i);
    card.querySelectorAll('[data-f]').forEach((el) => {
      const f = el.dataset.f;
      el.addEventListener(el.type === 'checkbox' ? 'change' : 'input', () => {
        const c = S.characters[i];
        c[f] = el.type === 'checkbox' ? el.checked : f === 'voicePitch' ? Number(el.value) : el.value;
        if (f === 'enabled') card.classList.toggle('off', !el.checked);
        if (f === 'color') card.style.setProperty('--c', el.value);
        if (f === 'voicePitch') card.querySelector('[data-pitch]').textContent = el.value;
        if (f === 'image') card.querySelector('img').src = el.value;
        markDirty();
      });
    });
    card.querySelector('[data-voice]').onclick = () => {
      const c = S.characters[i];
      try {
        speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(`こんばんは、${c.name}だよ。いっしょにウルフを探そう。`);
        u.lang = 'ja-JP'; u.pitch = c.voicePitch; u.rate = 1.1;
        const v = speechSynthesis.getVoices().filter((x) => /^ja/i.test(x.lang));
        if (v.length) u.voice = v[i % v.length];
        speechSynthesis.speak(u);
      } catch { /* 読み上げ非対応 */ }
    };
    card.querySelector('[data-reset]').onclick = () => {
      const d = S.defaults.find((x) => x.id === S.characters[i].id) || S.defaults[i % S.defaults.length];
      S.characters[i] = { ...d, enabled: S.characters[i].enabled };
      markDirty();
      render();
      markDirty();
    };
    card.querySelector('[data-test]').onclick = () => runTest(S.characters[i].id);
  });
  $('#test').onclick = () => runTest(S.characters.find((c) => c.enabled)?.id);
  $('#shutdown').onclick = async () => {
    if (!confirm('サーバーを止めますか？ ゲーム画面も使えなくなります。')) return;
    try { await api('shutdown', {}); } catch { /* 止まると返事が来ないことがある */ }
    app.innerHTML = '<section class="panel cover"><h2>サーバーを止めました</h2><p class="muted">このウィンドウは閉じて大丈夫です。</p></section>';
    $('#savebar').hidden = true;
  };
}

async function runTest(characterId) {
  const out = $('#testout');
  out.innerHTML = '<p class="muted">呼び出し中…</p>';
  try {
    const r = await api('test', { characterId });
    out.innerHTML = r.ok
      ? `<p class="ok">つながりました（${(r.ms / 1000).toFixed(1)}秒）</p><div class="result-box">${esc(r.name)}:「${esc(r.speech)}」</div>`
      : `<p class="warn">つながりませんでした（${(r.ms / 1000).toFixed(1)}秒）</p><div class="result-box">${esc(r.error)}</div>`;
  } catch (e) {
    out.innerHTML = `<p class="warn">${esc(e.message)}</p>`;
  }
  out.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function collect() {
  const body = {
    kiosk: {
      allowTwo: $('#allowTwo').checked,
      voice: $('#voice').checked,
      mic: $('#mic').checked,
      showMinds: $('#showMinds').checked,
      aiCount: Number($('#aiCount').value),
      idleSec: Number($('#idleSec').value),
      resultSec: Number($('#resultSec').value),
    },
    api: { geminiModel: $('#model').value.trim(), geminiRpm: Number($('#rpm').value) },
    characters: S.characters.map(({ id, name, image, color, voicePitch, tagline, personality, speech, enabled, provider, model }) => ({ id, name, image, color, voicePitch, tagline, personality, speech, enabled, provider, model })),
  };
  const key = $('#key').value.trim();
  if (key) body.api.geminiKey = key;
  if ($('#clearKey')?.checked) body.clearKey = true;
  const np = $('#newPin').value;
  if (np) body.adminPin = np;
  if ($('#clearPin')?.checked) body.adminPin = '';
  return body;
}

$('#save').onclick = async () => {
  const names = S.characters.map((c) => c.name.trim());
  if (names.some((n) => !n) || new Set(names).size !== names.length) {
    $('#savemsg').className = 'warn';
    $('#savemsg').textContent = 'キャラクターの名前が空か、同じ名前があります';
    return;
  }
  try {
    const body = collect();
    const d = await api('settings', body);
    if (body.adminPin !== undefined) pin.set(body.adminPin);
    S = d.settings; providers = d.providers;
    dirty = false;
    render();
    $('#savemsg').className = d.warning ? 'warn' : 'ok';
    $('#savemsg').textContent = d.warning || '保存しました。次のゲームから反映されます。';
  } catch (e) {
    $('#savemsg').className = 'warn';
    $('#savemsg').textContent = `保存できませんでした: ${e.message}`;
  }
};

addEventListener('beforeunload', (e) => { if (dirty) e.preventDefault(); });
load();
