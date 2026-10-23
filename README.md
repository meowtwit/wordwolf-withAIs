# 🐺 Word Wolf with AIs

人間1〜2人 ＋ 独立したAI 3人（1〜4人に変更可）で遊ぶ、ブラウザ版ワードウルフです。
AIそれぞれに性格とモデルを設定でき、AI同士が疑い合ったり、人間を誘導したりします。
ゲーム終了後には、**各AIの「誰が怪しいか」の推理の変化と作戦**がすべて公開されます。

## 遊び方

```bash
npm start          # → http://localhost:3000
```

- 依存パッケージはありません（Node.js 20 以上が必要）。
- APIキーがなくても、**オフライン（ルールベース）AI**ですぐに遊べます。
- LLMを使う場合は `.env.example` を `.env` にコピーして、使いたいサービスのキーを入れてください。

### ゲームの流れ

1. 人間1〜2人とAIを配置（AIごとに性格・モデルを選択）
2. ランダムに1人だけ別のお題（ウルフ）。**誰がウルフかはAIにも人間にも分からない**
3. 決まった順番で全員が発言（1〜3周）
4. 全員が投票。同票なら1回だけ決選投票、それでも同票なら追放なし（ウルフの勝ち）
5. ウルフが追放されたら、ウルフは多数派のお題を当てれば逆転勝利
6. 結果画面で、お題・投票理由・AIの推理過程を公開

人間2人の場合は、1台の端末を交代で使います。お題の確認と投票は「他の人は見ないで」画面を挟んで1人ずつ行います。

## AI の設計

```
ゲーム管理サーバー（src/game.js）… お題配布・発言順・ログ・投票集計・勝敗判定
   ├─ AI 1（慎重・分析型）独立した記憶
   ├─ AI 2（積極・質問型）独立した記憶
   └─ AI 3（直感・攪乱型）独立した記憶
```

- 各AIに渡すのは **自分のお題・公開された会話ログ・自分の性格・自分の前回の推理** だけ（`aiView()`）。
  他人のお題やウルフの正体は渡さないので、構造的に漏れません（テストで確認済み）。
- 発言時、AIは次の JSON を返します。`speech` 以外はゲーム中は非公開です。
  ```json
  { "speech": "それって屋内でも楽しめるよね？",
    "suspicions": { "h1": 0.15, "ai2": 0.70, "ai3": 0.15 },
    "strategy": "ai2の反応を確認する",
    "wolf_self": 0.2 }
  ```
- AIがお題をそのまま言ってしまったら1回だけ言い直させ、それでも含まれていれば「〇〇」に伏せます。
- APIがエラーやタイムアウトになったら、そのターンだけオフラインAIが代わりに発言します（結果画面に表示されます）。
- API呼び出しは発言・投票・逆転回答のときだけです。AI 3人・2周なら、発言6回＋投票3回の約9回です。

### 性格プリセット

慎重・分析型 / 積極・質問型 / 直感・攪乱型 / 陽気・天然型 / 皮肉屋（`src/ai.js` の `PERSONALITIES` で追加できます）

## 対応AIプロバイダ

| id | サービス | 環境変数 | 既定モデル |
| --- | --- | --- | --- |
| `mock` | オフライン（APIなし） | — | ルールベース |
| `gemini` | Google Gemini API | `GEMINI_API_KEY` | `gemini-2.5-flash` |
| `groq` | GroqCloud | `GROQ_API_KEY` | `llama-3.3-70b-versatile` |
| `openrouter` | OpenRouter | `OPENROUTER_API_KEY` | `meta-llama/llama-3.3-70b-instruct:free` |
| `huggingface` | Hugging Face Inference Providers | `HF_TOKEN` | `meta-llama/Llama-3.1-8B-Instruct` |
| `cerebras` | Cerebras Inference | `CEREBRAS_API_KEY` | `llama3.1-8b` |
| `ollama` | ローカル（Ollama など OpenAI 互換） | `OLLAMA_BASE_URL` | `qwen2.5:7b` |

- 既定モデルは `*_MODEL` 環境変数か、画面の「モデル名」欄で変更できます。提供されるモデルや無料枠は変わりやすいので、各サービスで最新の情報を確認してください。
- AIごとに別のプロバイダを選べます（例: AI 01 は Gemini、AI 02 は Groq、AI 03 はローカル）。
- APIキーはサーバー側（`.env`）にだけ置き、ブラウザには送りません。
- **各サービスの利用規約（年齢条件など）を必ず確認してから使ってください。** 条件を満たさない場合でも、オフラインAIやローカルモデル（Ollama）なら外部サービスなしで遊べます。

## 開発

```bash
npm test     # ゲーム進行・情報漏洩・投票/決選/逆転のテスト
npm run dev  # ファイル変更で自動再起動
```

```
server.js          HTTP サーバー + API
src/game.js        ゲーム進行（状態・手番・投票・判定・公開状態のフィルタ）
src/ai.js          AIの性格・プロンプト・JSON解析・フォールバック
src/providers.js   各AI APIの呼び出し
src/mockAI.js      オフラインAI
src/topics.js      お題ペア（20組）
public/            フロントエンド（HTML/CSS/JS）
```

### API

| メソッド | パス | 内容 |
| --- | --- | --- |
| GET | `/api/config` | 使えるプロバイダと性格の一覧 |
| POST | `/api/games` | ゲーム作成 `{ humans:[{name}], ais:[{name,personality,provider,model}], rounds }` |
| GET | `/api/games/:id` | 公開状態（終了前はお題・ウルフ・AIの推理を含まない） |
| POST | `/api/games/:id/word` | 人間プレイヤーのお題確認 `{ playerId }` |
| POST | `/api/games/:id/advance` | AIの手番を進める |
| POST | `/api/games/:id/speak` | 人間の発言 `{ playerId, text }` |
| POST | `/api/games/:id/vote` | 人間の投票 `{ playerId, targetId }`（全員そろうとAIが投票し集計） |
| POST | `/api/games/:id/guess` | 追放された人間ウルフの逆転回答 `{ playerId, guess }` |

ゲームの状態はサーバーのメモリ上にあり、6時間で消えます。ローカルや身内で遊ぶ前提の作りです（`/word` に認証はありません）。

## claude.ai で遊べる版（artifact/）

`artifact/` には、サーバーなしで claude.ai 上のページとして動く版があります。

- AIの頭脳は、ページを開いた人の Claude（Gemini などの外部APIは使いません。ページから外部サービスに通信できないため）
- 順番に話すのではなく、普通の会話のように進みます。人が話すか「AIの話を聞く」を押すたびに、AIが1〜2人返事をします。名前を呼ぶと、その相手が答えます
- AIの発言の読み上げと、マイクでの音声入力（使える環境のみ。使えないときはスマホのキーボードの音声入力で代用）
- Claude を使えないときは、オフラインの簡易AIで遊べます

`artifact/src.html` を編集したら、`node artifact/build.mjs` でお題データを埋め込んだ `artifact/wordwolf.html` を作り直します。
