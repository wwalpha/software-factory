# P1-D: Builder Worker stdin — 2026-10-10

P1-Dのみ。基点は現在のcleanなmaster `1636b1c5afdd2e14d26fbf53f0f5c25f5f79714b`。
helperで作成した `task/p1-d-stdin` の専用worktreeで実装・検証。
実リポジトリのmerge/push/deploy、Live有効化、自己改善採用は行わない。

## 原因とBefore/After

1010v1時点の指摘はコード確認によるものだった。今回の現行コードでも
Builder用DockerRunnerの `docker run` に `-i` がなかった。
Workerはstdin EOF後のJSON.parseを行い、chunkごとの `String(chunk)` は
UTF-8文字途中の分割を正しく復元できず、byte上限・schema検証・入力待ちの期限もなかった。
P0のProduct Workerとは別経路である。

**今回の実Docker再現:** 基点でbuildしたDockerRunnerとcodex-workerを使用し、
モデルadapterだけをテストfixtureに交換したイメージで実行した。
正常な4項目を送ったが、Workerの空stdinによる早期終了となり、RunnerFactは
`failed`、candidateなし、`stopped: true`。約 **235.6 ms**。
WorkerのJSON.parse位置とstdoutの空結果からモデル境界へ進まないことを確認した。
追加切り分けとして同じ基点Worker/入力で `-i` の有無だけを変更した。
なしはexit 1、stdout空、stderrの `Unexpected end of JSON input` をassert。
ありはexit 0、4項目deepEqual。コマンドは
`node /private/tmp/p1d-baseline-input.mjs <baseline-image-ID>`。
これは実GPT/Codex失敗の再現ではない。

再現コマンドは `node /private/tmp/p1d-baseline.mjs <baseline-image-ID>`。
この一時probeは基点の `dist/src/adapters/docker.js` とfixture入力を使用し、
基点のWorkerを `COPY codex-worker.js /factory/dist/src/adapters/codex-worker.js`
でfixtureイメージへ置いた。expected failure、candidateなし、専用名のコンテナ不在をassertした。

**After:** 本番DockerRunnerに `-i` を追加、TTYなし。
既存 `runProcess` の `child.stdin.end(input)` をそのまま利用して入力後にEOFを送る。
`readWorkerInput` はBufferをbyte数で制限して連結し、strict UTF-8 decode後にJSON.parse。
4項目だけのenvelope、非空stringのprompt、既存Attempt/RoleRecipe/ModelBinding schemaを検証する。
ModelBindingを既存ContractMapへ公開しただけで、canonical schema/生成型/永続データの変更はない。

既存110秒Worker期限をstdin待ちからモデル実行まで共有する。
入力不正・上限超過・入力待ち期限ではモデル起動前にexit 2、stdoutなし、
stderrは内容を含まない固定文。入力から信頼できないAttempt ID/RunnerFactを作らない。
Runnerの120秒期限と停止確認は維持し、abort後の結果もcompletedにしない。
Docker exit 125は起動失敗、その他の非zero exitはWorker失敗として固定detailで区別。
モデル境界のtimeout分類も既存RunnerFact outcomeへ維持する。

## 本番共通経路とテスト境界

正常・cancel・Runner timeout・早期終了・起動失敗は実際の
`DockerRunner.run -> runProcess -> docker run -i -> codex-worker -> readWorkerInput`
を通す。モデルモジュールだけをテストイメージ内の
`tests/fixtures/codex-worker-model.mjs` に交換する。
fixtureは受信4項目をworkspace内へ保存し、そのJSON全体を送信値とdeepEqualする。
失敗入力では保存がないことと非zero exitを確認し、モデル呼出し0とする。
モデル正常処理はfixture。実SDK/モデル/provider HTTPの成功は検証していない。

本番proxyの生成とGuard側権限設定、network none、非root、read-only、cap-drop ALL、
no-new-privileges、CPU 1、memory 1 GiB、PID 128、workspace/ipcのみのbind mountを維持。
実コンテナinspectで値、OpenStdin=true、Tty=false、credentialを含まないEnvをassertした。
fixtureはproxyを呼ばない。既存Guard権限は全offline回帰で確認する。
プロキシそのものをstub化したり、本番payload/envへ偽成功モードを追加したりしない。

Worker単体の分割入力・不正入力・上限・EOFなしは同じ本番Workerを実Dockerで起動し、
stdinを制御する。単なるecho/catをDocker到達の合格条件にはしていない。
process helperの補助回帰だけにecho相当のstdin/EOF確認がある。

## 検証環境・コマンド・結果

macOS **27.0.1 arm64**、Node **24.21.0**、npm **11.19.0**、
Docker Engine server **29.8.2** (Desktop Linux)。Workerは同じ指定Node/npmのLinux arm64。
環境制約、依存バージョン、package-lock/.node-version/.npmrcを変更していない。

```sh
export PATH="/Users/macmini/Documents/projects/software-factory/.local/node-v24.21.0-darwin-arm64/bin:$PATH"
# 以下は専用worktreeでhelper execのtask usage lock下に実行
npm ci
npm run check
docker build -f config/Dockerfile.worker -t software-factory-p1d-worker:local .
docker build --build-arg WORKER_IMAGE=software-factory-p1d-worker:local \
  -f tests/fixtures/Dockerfile.worker-input -t software-factory-p1d-fixture:local .
WORKER_INPUT_IMAGE="$(docker image inspect software-factory-p1d-fixture:local --format '{{.Id}}')" \
  npm run test:docker:stdin
PRODUCT_CHECK_IMAGE="$(docker image inspect software-factory-p1d-worker:local --format '{{.Id}}')" \
  npm run test:docker:checks
```

| 検証                           | 結果    | 範囲                                                          |
| ------------------------------ | ------- | ------------------------------------------------------------- |
| npm ci                         | PASS    | 指定環境、132 packages、依存更新なし                          |
| npm run check                  | PASS    | schema/typecheck/lint/format/build、145件、skip/cancel/fail 0 |
| npm run test:docker:stdin      | PASS    | 無課金実Docker、3件、skip/cancel/fail 0                       |
| npm run test:docker:checks     | PASS    | 現行P0の既存実Docker隔離回帰、6件、skip/cancel/fail 0         |
| 有料API、test:live、Live有効化 | NOT RUN | 明示禁止、本作業の合格条件外                                  |

初回checkはfixtureのNode global参照2件のLintでFAIL、明示importで修正。
次は追加fixtureの長いUnix socketパスがmacOS上限を超えてFAIL (144/145 PASS)。
fixture一時名を短くして修正。元の保護条件・テスト期待値は緩めていない。
最終コードで上記を再実行した結果をPASSとして記録する。

| ケース                    | 根拠・結果                                                                                               |
| ------------------------- | -------------------------------------------------------------------------------------------------------- |
| A 正常JSON                | 本番RunnerとWorkerで4項目全体deepEqual、欠落/変形0                                                       |
| B 分割・UTF-8             | 共通readerでbyte単位分割、実Workerでも日本語途中分割、改行/引用符/バックスラッシュを保持                 |
| C EOF                     | EOF前はreaderが完了しない、EOF後はモデルfixtureに進む                                                    |
| D 空/不正/途中切れ/schema | 共通readerは全4項目の型を拒否、Worker subprocess/実Dockerでも拒否、モデル呼出し0/成功扱い0               |
| E byte上限                | 1,048,576 bytesちょうどは全体一致、+1 byteは拒否、invalid UTF-8も拒否                                    |
| F EOFなし/部分入力        | 実110秒期限でempty/partialともexit 2、モデル呼出し0、CLI正常終了後にもState.Running=falseを確認          |
| G timeout/cancel          | 本番Runner、rm --force後にinspectまたは成功したpsで不在確認、停止未確認0                                 |
| H 起動/早期終了           | 実Docker exit 125とWorker exit 2のfixed detailを区別、fallbackなし、candidateなし                        |
| I ログ                    | fixture secret/prompt/keyがWorker stdout/stderrとRunnerFactにないことをassert、エラー文を固定            |
| J 既存                    | process子孫停止、Guard/P1-A〜C/P0/全offline回帰、および既存P0実Docker回帰                                |
| 停止不能                  | offline docker CLI失敗fixtureではstop/isStopped=false、RunnerFact uncertain/stopped=false、attemptを保持 |

## 測定と制約

各値は1回の最終実行値で、性能保証や比較統計ではない。
入力読取り/起動/終了の値は次の範囲を含む。

| ケース            |       ms | 測定範囲                                    |
| ----------------- | -------: | ------------------------------------------- |
| 正常の本番Runner  |    347.4 | input送信開始から結果・コンテナ削除確認まで |
| 実Docker分割入力  |    257.7 | CLI起動からWorker終了・State停止確認まで    |
| cancel            |    155.1 | Runner開始から停止・削除確認まで            |
| Runner timeout    | 120191.3 | 実120秒期限と停止・削除確認まで             |
| 空入力、EOFなし   | 110243.4 | 実110秒Worker期限、終了・State停止確認まで  |
| 部分入力、EOFなし | 110243.9 | 同上                                        |

通常readerのbyte単位split+EOF補助回帰は約1.2秒（意図的なchunk間待機を含む）。
入力待ちの短期限補助回帰は約40ms（意図的な40ms期限）。
実Dockerの不正入力終了は約168〜217ms（起動・State停止確認を含む、削除時間除外）。

入力上限は **JSON全体1 MiB**。Runtimeの既存128 KiB Builder prompt上限とは別で、
JSON escapeやrecipe/scope/bindingの合計が新しい上限を超えれば拒否する。
長大envelopeを以前のように無制限に受け付ける互換性は維持しない。
既存runProcess、proxy、隔離条件、Guard契約、停止確認ロジックは再利用している。
入力waitが成立したため、EOF漏れは110秒期限で顕在化し、停止不能ならuncertainを維持する。
Unix socketパス長等、既存proxyの起動条件を変更する作業は含めない。

テストには専用 `p1d-<UUID>` 名、Builder用label、単体Worker用run labelを付与した。
削除は今回の名前だけ。各コンテナの非稼働と削除後不在を確認する。
volumeを作成/一括削除しない。他利用者のコンテナを削除しない。
テストイメージは再現用にローカル保持し、GuardのworkerImageへ登録しない。

stdin成功を実GPT/Codex成功、Live全体の安全性、P0完了/escape耐性の証明にはしない。
P1-A〜C/P2、共通process出力decode、Live設定/自己改善採用には範囲を広げない。

## 変更ファイル

- `src/adapters/docker.ts`: stdin接続、Builder label、abort判定、固定失敗detail。
- `src/adapters/worker-input.ts`: byte上限/strict UTF-8/既存schema/期限付き共通入力。
- `src/adapters/codex-worker.ts`: 共通入力を利用、入力失敗の内容非公開、期限共有/timeout分類。
- `src/adapters/contracts.ts`: 既存ModelBinding validatorの公開。
- `tests/worker-input.integration.test.ts`: 共通入力/process/停止未確認の6件。
- `tests/fixtures/worker-input.ts`, `codex-worker-model.mjs`, `Dockerfile.worker-input`: テスト構成内の入力/モデルfixture。
- `scripts/worker-input-docker.ts`: 本番Runner/Workerを使う実Docker3件。
- `package.json`, `README.md`, 本記録: 実行入口・再現手順・結果。

本番 `config/Dockerfile.worker`、canonical schema/生成型、process helper、Guard/P0/P1-A〜Cのコードは変更しない。

検証イメージID:

- production: sha256:6998777118254ccdf032a156774711c77e33516aeb84ae3fb138d3d806d60d6e
- test-only model fixture: sha256:121c808593cd8d2e26774dffccdf843d1f7190504f7d85ba949ae135157219a7
- baseline fixture: sha256:ae4d0f9d8230a4ed2d17aa4d235c6382e60a5ce8ba2157766cb93a96903b9071
