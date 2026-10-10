# 判定器と製品の信頼境界：検証記録 — 2026-10-10

対象は software-factory-master-1010v1。実装、回帰、以下の実Docker隔離試験は完了。
**全面的なLive readinessは承認していない。** この記録は今回の実測であり、
Node 22の既存プローブや末尾の過去記録を今回の結果として転記していない。

## 原因と変更

旧方式は保護Nodeテストが製品をimportしており、同じランタイムのassertを製品が
書き換えられた。`isolation: 'process'`はテストを親から分けるだけだった。
今回、保護テスト・期待値・assert・合否集約は信頼側ホストのEvaluatorに置き、
候補のimportは別のProduct Workerだけが行う。Liveの製品呼出しは毎回、別の
Dockerコンテナ。EvaluatorやGuardのPID namespace、書込み可能領域、判定socket、
秘密情報を共有しない。Fakeは同じ構造のホスト子プロセスだが、管理されたfixture
専用であり、悪意あるコードのsandboxとは呼ばない。

- `src/adapters/checks.ts`, `check-worker.ts`, 新規`evaluator-loader.ts`：
  保護テストと信頼側helperの確定snapshotをhash確認し、その同じbytesを実行する。
  旧import経路と未登録のhelperを拒否。各宣言ファイルでnamed testの実行を要求し、
  skip/todo/空のテストは合格しない。方法・protocol・runtime/helperをcheckVersionに含めた。
- 新規`product-call.ts`, `product-protocol.ts`, `product-worker.ts`,
  `product-broker.ts`：候補内moduleのown named function exportを、型付き要求で呼ぶ。
  結果・エラーは非信頼の観測データ。業務データの`passed`を禁止せず、期待値とassertは
  信頼側だけが保持する。通常ログ、応答FD、Evaluatorの判定チャネルを分ける。
  request IDは対応付けであり、製品や関数実行の真正性を証明しない。
- `src/adapters/process.ts`：別FDのbytesを保持し、分割UTF-8も損失なく検証。
  通常ログと応答の合計上限を適用し、繰返しkillを抑え、停止未確認はuncertain。
  Dockerはcreate→attach→force remove→daemon上の不在確認。CLI終了だけでは停止としない。
  停止未確認はcancelより優先する。Docker失敗からホストへfallbackしない。
- `src/guard/service.ts`：LiveではDocker製品実行を持つProtectedChecksを要求。
  sealは全登録checkと受入条件、現在のversion・inputDigest・targetDigest・environment、
  保存済みReceipt一致、Ed25519署名を要求する。cancelを証拠発行前にも確認する。
  公開CheckPort、schema、Receiptと署名方式は変更していない。
- `examples/checks/*.mjs`と統合テスト内の動的保護テスト：外部呼出しへ移行。
  repairの下限・上限・範囲内・境界一致、refactorの公開関数・正規化・配列・空配列・
  重複削減を維持。関数型はWorkerで明示的に検査し、ソース構造は信頼側が同じsnapshotを読む。
  ファイル名、export名、既知の値をEvaluator本体へ埋め込んでいない。
- 新規`tests/checks.integration.test.ts`, `tests/fixtures/check-products.ts`,
  `scripts/check-boundary-docker.ts`, `scripts/check-boundary-probe.ts`、既存Guard/process回帰：
  実保護テスト→Worker→ProtectedChecksとGuardまで検証。偽の戻り値だけのmockで代用していない。
  `package.json`は無課金Docker回帰commandだけ追加。依存・lockfile・engineは維持。
  `config/Dockerfile.worker`には製品実行時の最小mount/maskの説明を追加。

module pathはTree/safePathと実パス検査で候補内に制限し、絶対パス、traversal、URL、
symlink/hardlink、プロパティチェーンを拒否する。export名はASCIIのJavaScript識別子に限定する。
各呼出しは新しいsessionで、stateは
その呼出し中だけ保持し、終了後に破棄。checkをまたいで流用しない。非同期呼出し10秒、
要求/応答と製品の合計出力64 KiB、128観測/check、深さ32を上限とする。
null、boolean、有限数（負のゼロを除く）、文字列、密な配列、plain recordを扱い、
undefined/NaN/Infinity/bigint/非対応object等を明示的に拒否する。nullへの暗黙変換はしない。非enumerableな配列indexも値/descriptorを検査する。
null、[null]、空recordへ変換されるとassertを通ってしまうfixtureでも、未対応値はFAILになる。
不正schema、重複field/frame、不一致ID、欠落、切断、不正UTF-8、上限超過は成功にならない。

## 環境・コマンドと結果

開始時の作業ツリーはclean、基準commitは
`b7a7e835ed798bb89f41ff186f909656e98c3794`。変更前のコードはignored
`.factory/check-boundary/baseline/`へarchiveし、元の保護テストのまま測定した。
添付プローブは使用せず、小さなfixtureを今回作成した。raw logとarchiveは同directoryに保持。
変更前archiveには同じ`check-boundary-probe.ts`と`check-products.ts`だけを追加し、
保護テストや判定器は変更せず、指定Node/npmで`npm ci`と`npm run build`を実行した。

```sh
export PATH="$PWD/.local/node-v24.21.0-darwin-arm64/bin:$PATH"
# host measurement (run sequentially, without concurrent tests/builds)
node .factory/check-boundary/baseline/dist/scripts/check-boundary-probe.js
node dist/scripts/check-boundary-probe.js
# Docker measurement: run both commands again with the same pinned image
export PRODUCT_CHECK_IMAGE="$(docker image inspect software-factory-before:local --format '{{.Id}}')"
node .factory/check-boundary/baseline/dist/scripts/check-boundary-probe.js
node dist/scripts/check-boundary-probe.js
```

ホストはmacOS 27.0.1 arm64。全npm/build/testは`.node-version`/package.json指定の
Node 24.21.0 / npm 11.19.0（ignored `.local/`のbinary）で実行。
既定Node 26は検証に使用していない。Docker client 29.0.2、daemon 29.8.2、
Linux aarch64、コンテナもNode 24.21.0 / npm 11.19.0。
Dockerは実daemonに接続し、mockやFake結果を隔離済み証拠にしていない。

| 実行                                                               | Before                                                               | After                                   |
| ------------------------------------------------------------------ | -------------------------------------------------------------------- | --------------------------------------- |
| `npm ci`                                                           | PASS、132 packages                                                   | 同じ依存を使用、更新なし                |
| `npm run check`                                                    | PASS、25/25、exit 0                                                  | PASS、34/34、fail/skip 0、exit 0        |
| `docker build -f config/Dockerfile.worker ...`                     | PASS、archiveのimage                                                 | PASS、最終コードのimage                 |
| `PRODUCT_CHECK_IMAGE=<pinned image ID> npm run test:docker:checks` | NOT RUN、新しいsuiteは旧方式に存在しない                             | PASS、実Docker 6/6、fail/skip 0、exit 0 |
| `node dist/scripts/demo.js`                                        | PASS、Fake repair/refactor、署名、evolutionのfixture内adopt/rollback | PASS、同じ範囲。実運用への採用なし      |
| `git diff --check`                                                 | clean基準                                                            | PASS                                    |
| `npm run test:live`、有料binding/API、push/merge/deploy            | NOT RUN                                                              | NOT RUN、今回の対象外                   |

最終Docker回帰image ID：
`sha256:bfe7fbde41af52e161a3e420330f7bd89e8b8c199d028cba1c0e5b35232e8e4c`。
性能比較では環境差を避けるため、両方式とも変更前image
`sha256:801426a87f5b6a480fae554af82e8099add184c2dffa4fca76945265407f5a18`
を固定使用し、新方式の最小製品runtimeはその実測対象コードからreadonly mountした。
最終imageでも全Docker回帰を再実行済み。

最初のrestricted実行はローカルsocket等のEPERMで失敗した。同じコードを必要な
ローカル実行権限で再実行し、上記Before/Afterを得た。途中のDocker build失敗、
出力超過後の繰返しkill、Guard socket readinessの試験側raceを成功として数えていない。
修正・再build後の最終検証のみを採用した。期待versionの自動書換えで不一致を消していない。

## A〜JのBefore / After

PASS/FAILは要求する安全な判定が成立したかを表す。誤製品の`passed=false`は回帰PASS。
NOT RUNは今回その旧方式の組合せを実測していないもの。

| ケース                           | Before：今回の実測                                                                                                  | After：今回の実測                                                                                                                                                                                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A 正解と通常の誤実装             | PASS：repair/refactorとも正解true/exit 0、誤実装false/exit 2。host/Docker各3回                                      | PASS：同じ正解true、誤実装false、同じ受入条件。host/Docker各3回                                                                                                                                                                                                              |
| B assert.equal変更               | **FAIL：誤clampがtrue/exit 0**、host/Docker各3回                                                                    | PASS：全回false、Evaluator exit 2。Guardも該当PASS Receiptとsealを拒否                                                                                                                                                                                                       |
| C 別干渉・出力偽装               | **FAIL：誤refactor＋deepEqual変更がtrue/exit 0**。stdout PASS/JSON/TAP、test/Object.is干渉はfalse                   | PASS：equal/deepEqual/test/Object.is/出力偽装はfalse。判定/応答/logを分離                                                                                                                                                                                                    |
| D 未実行・skip/todo・exit/import | PASS：既存の空テスト/exit 0回帰、製品exit 0とimport例外はfalse。skip/todo専用はNOT RUN                              | PASS：空、skip/todo、Evaluator/製品早期exit、import/関数例外、caught errorでも合格しない。host/Docker                                                                                                                                                                        |
| E 応答異常・出力過多             | NOT RUN：外部呼出しprotocolなし                                                                                     | PASS：不正schema、余分/重複field/frame、空/別ID、非有限値、FD3偽判定、stdout/stderr過多、観測上限。host/Docker                                                                                                                                                               |
| F 無限待機・cancel・途中終了     | PASS：既存host descendant timeout/cancel回帰。新Product Worker停止試験はNOT RUN                                     | PASS：10秒timeout、pre-cancel/cancel、部分応答、Docker孤児process、実停止/除去。除去失敗＋cancelはuncertain、実際に残存することをinspectし、その後実daemonで除去確認                                                                                                         |
| G 物理的境界                     | **FAIL：旧Docker製品が実際に`/checks/repair.test.mjs`を読んでassert変更し偽PASS**。旧Guard秘密情報アクセスはNOT RUN | PASS：同じ旧攻撃fixtureはfalse。実在する保護テスト/Guard鍵/token/socket、host home/PID、Docker socket、Evaluator/helperへアクセス不可、候補の書込み不可。inspectで別PID/network none/nonroot/readonly/cap-drop/no-new-privileges/資源制限/最小2 mountと`/factory` maskを確認 |
| H 改変・旧Receipt                | PASS：既存candidate/署名/改変拒否。方法変更後のReceipt再利用はNOT RUN                                               | PASS：caller Tree変更から実行snapshotを保護、check改変・旧version/import/未宣言helper/linkを拒否。正当に署名・保存した旧方式version、異なるinput/environment、mandatory欠落のReceiptは新seal拒否。過去署名/artifactの独立検証は維持                                          |
| I 独立fixture                    | repair/refactorという別製品はPASS。新APIの汎用値/stateはNOT RUN                                                     | PASS：別module/export、非同期数値・日本語文字列・配列・業務`passed` record。毎回state初期化。未対応型/path/export chain拒否。host/Docker                                                                                                                                     |
| J 既存回帰・tsc・Fake/evolution  | 25/25、署名、統合tree、Fake/evolution PASS。独立tscはDocker正解PASS、host正解FAIL                                   | 34/34、署名、統合tree、Fake/evolution PASS。tsc正解PASS/型不正FAILをhost/Docker双方で確認                                                                                                                                                                                    |

旧hostのtsc正解FAILは、TypeScript 6でexplicit filesと呼出し元tsconfigが競合する
既存挙動。compilerを信頼側で指定する経路に`--ignoreConfig`を加え、独立した
explicit-file検査を維持した。acceptanceは削減せず、engineも緩めていない。

Guard結合回帰は実Evaluator/Product Workerを通る。攻撃のcheckはFAIL Receipt、
PASS Receiptなし、completed ResultBundle/sealなし。機能不一致は既存の失敗結果として
記録する。protocol/異常exit/出力超過/timeout/cancel/停止未確認はrunをthrowし、
その実行の証拠を発行しない。出力過多と証拠発行直前cancelでは、新規Receipt数が
変わらず、Guard operationがuncertainになることも実測した。
正しい候補の全mandatory証拠ではsealと署名検証が成立する。
結合Receiptのenvironmentは`fake-development-host`であり、Live Receipt検証済みとはしない。
GのGuardは実process/秘密file/socketを使う開発fixtureで、実運用の別UID deploymentとは区別する。
最終daemon照会で対象product/checkコンテナの残数は0。

## 実行時間・起動コスト

同じ入力fixture、同じ保護受入条件、同じNode、同じ固定Docker imageで、各3回の中央値。
実際のspawnを観測し、daemonのstart eventでコンテナ数を数えた。処理を差し替えていない。
10ms非同期process samplingを両方式で同じように含める。sampling完了待ちとevent照会は
計時の外。別のbuild/test/benchmarkを同時実行していない。
旧方式はEvaluatorも製品と同じコンテナ、新方式はEvaluatorがホストという配置変更自体を含む。
raw 120 samples、各終了コード、infra error、環境、対応付けは
[check-boundary-results.json](check-boundary-results.json)に保存した。

| fixture              | host Before→After (ms) | Docker Before→After (ms) |
| -------------------- | ---------------------- | ------------------------ |
| repair 正解          | 71→232                 | 163→747                  |
| repair 誤実装        | 69→108                 | 161→237                  |
| assert.equal変更     | 71→109                 | 159→243                  |
| PASS/JSON/TAP出力    | 69→107                 | 156→230                  |
| test/Object.is変更   | 70→123                 | 160→247                  |
| 製品exit 0           | 65→115                 | 156→237                  |
| import例外           | 64→102                 | 155→235                  |
| refactor 正解        | 71→228                 | 156→728                  |
| refactor 誤実装      | 69→106                 | 158→240                  |
| assert.deepEqual変更 | 71→152                 | 154→405                  |

正解repair/refactorはhostでdirect spawn 1→5、観測host process数2→6、コンテナ0。
Dockerはdirect spawn（CLIを含む）2→17、観測host process数2→18〜19、製品コンテナ1→4。
新方式の17はEvaluator 1＋4呼出し×create/start/rm/不在照会4で、Nodeテスト子processは
別にsamplingで観測する。コンテナ内processをhost数には加えない。samplingは短命processを
取り逃がしたりfork途中を余分に観測する可能性があり、厳密な総process数の証明ではない。
exact direct startsとdaemon container startsはrawに併記した。誤製品は最初の不一致で
停止し、呼出し数が少なくなる。ソースの構造検査は製品コンテナを起動しない。

製品コンテナは直列で同時最大1、各512 MiB/1 CPU/128 PID、private tmpfs 64 MiB。
使用量の実peak memory/CPUはNOT RUNで、これは制限値。毎回の起動・通信・確認費用を
受け入れてstateを廃棄する。全体checkの実測は旧25件約3.60秒、新34件約17.61秒だが、
新しい実10秒timeout回帰を含むため製品性能の比較には用いない。

## 移行と残存リスク

[READMEの再登録手順](../README.md#protected-test-migration-1010v1)に従い、operatorが
全保護テストをreviewして外部helperへ移行し、build済みruntimeに対するversionを
**新しいprofile**へ生成・登録する。期待versionを検証前に上書きしない。
新mission/grantで全checkをやり直す。旧operation IDの履歴取得・過去の署名検証は
新しい実行やsealへの証拠再利用を許可しない。互換性fallback、新DSL、汎用RPC、追加依存なし。
未対応値型と跨るstateのAPI制限は上記のとおり明示する。

今回の定義した境界と回帰では偽PASS 0、正解の誤FAIL 0、受入条件削減0、既存回帰の
新規失敗0。ただし任意プログラムの完全な正しさ、未観測入力のハードコードや過学習の
排除、OS/container escape耐性を証明しない。operatorはGuard/Evaluator/runtime/判定テストと
固定imageを改変から守る必要がある。同一UID hostは管理されたfixture以外に使わない。

全面的Live deployment（別UID/doctor/全起動条件/実provider）はNOT RUN。
有料API、Live有効化、実運用の自動採用、push/merge/deployは行っていない。
Builderの入力、attempt競合、resume、役割間連携、モデル/予算/自己改善の変更は対象外。

---

以下は修正前に存在した過去記録。credential、Docker inventory、Live command実行等の
記述は当時のものであり、今回の実測・承認には使用しない。

# Historical record — before the trust-boundary correction

This distinguishes implemented paths, executed checks and missing environmental
proof. **The aggregate `check` now passes; live validation remains BLOCKED.** No production operation,
remote push or merge was performed.

## Current checks

`npm run check` runs schema, type, lint, formatting and offline tests. Docker is
required for live Worker isolation only. The ordinary Linux and macOS CI matrix
continues to run the same check command.

### Live prerequisites still missing or unverified

- Neither `OPENAI_API_KEY` nor `CODEX_PROVIDER_API_KEY` is set in the current
  session. An `AZURE_OPENAI_API_KEY` is present, but the current Factory does not
  consume it. No secret values were printed or copied. Credential validity,
  account access, billing and actual model availability remain unverified.
- `FACTORY_CONFIG` is unset and `config/local.json` is absent. The deployment
  example has no registered ProjectProfiles, disabled/unverified models, no
  prices and a placeholder Worker image. Supply separate Guard/runtime settings
  with actual profiles, protected checks, evaluation cases and verified bindings.
- No Factory Worker image was present in the local Docker inventory. Build
  `config/Dockerfile.worker`, pin its actual digest and pass the isolation probe.
- The example `/srv/factory-runtime`, `/srv/factory-guard` and `/srv/factory-ipc`
  locations do not exist, and no account named for factory/guard/runtime was
  found. No configured separate-identity Guard deployment could be verified.
  Provision distinct nonroot identities, private Guard storage/policy and
  protected checks, narrowly shared IPC, and separate runtime/Guard/operator
  tokens. Only Guard should have Docker access. OS denial checks and `doctor`
  must pass from the runtime identity; Docker starting alone does not prove this.
- `FACTORY_PROBE_MAX_USD` is unset. The implemented binding probe requires an
  explicit cap of at least USD 0.40 and both provider credentials. This is a
  local authorization limit, not evidence of available API credit.
- `FACTORY_LIVE_MISSION` and `FACTORY_LIVE_BUDGET_USD` are unset. Supply a positive
  live-test cap covering the Mission budget and an operator-issued grant matching
  its revision digest, release, operations and scope, with sufficient budget and
  an unexpired lifetime. No valid live grant could be checked without that setup.

`npm run test:live` was executed and returned BLOCKED before any model call.
No paid binding probe, live Mission or OS privilege provisioning was performed.

## Executed on macOS arm64

| Check                                     | Result             | Evidence                                                                                                                                             |
| ----------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Official Node binary                      | PASS               | Node 24.21.0, npm 11.19.0; SHA-256 matched official SHASUMS256.txt                                                                                   |
| Normal `npm ci`                           | PASS               | 132 packages installed; 133 audited; no install-script suppression; npm reported 0 vulnerabilities at execution time                                 |
| `schema:generate` and `schema:check`      | PASS               | Canonical 2020-12 schema regenerates identical committed TypeScript                                                                                  |
| `typecheck`                               | PASS               | strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes, NodeNext                                                                               |
| `lint`                                    | PASS               | ESLint and typescript-eslint; no explicit any or ts-ignore escape                                                                                    |
| `format:check`                            | PASS               | Prettier                                                                                                                                             |
| `build`                                   | PASS               | Actual TypeScript compiler                                                                                                                           |
| `npm test`                                | PASS               | 25 tests, 25 passed, 0 skipped/failed; no external LLM requests                                                                                      |
| `test:integration`                        | PASS               | 20 tests, 20 passed; real SQLite/Git, separate processes, IPC and local SDK protocol fixtures                                                        |
| Installed Codex CLI                       | PASS               | Actual binary reported `codex-cli 0.162.0`, matching SDK 0.162.0; restricted shell printed an alias-creation warning but version execution succeeded |
| Two-product demo                          | PASS (fake agents) | Both signed results completed; real protected checks; candidate adopted then rolled back                                                             |
| CLI submit/grant/run/status/export/verify | PASS (fake agents) | Actual CLI processes, independent operator token, sealed bytes and Ed25519 verification                                                              |
| `git diff --check`                        | PASS               | No whitespace errors in the checked diff                                                                                                             |

The desktop sandbox initially denied local Unix socket creation (`EPERM`). The
same local integration tests were rerun with execution permission for their test
processes. No external LLM calls or credentials were used. Startup failure cleanup
was corrected rather than treating the sandbox failure as a successful test.

The official Node binary was downloaded into ignored `.local/` for this work;
the machine's default Node was 26.0.0 and was not replaced globally. All recorded
npm/build/test runs used the verified 24.21.0 executable.

## Automated coverage

- Strict schemas, unknown fields/coercion, malformed GPT JSON, refusal, incomplete
  output, duplicate YAML keys, aliases, tags and depth/size limits.
- DAG cycles, missing dependencies, stale parent plans, scope escape, oversized
  budget and dropped mandatory acceptance.
- Separate-process SIGKILL immediately before and after SQLite state/outbox commit;
  reopen confirms rollback or complete atomic persistence.
- Event/operation duplication, conflicting reuse, optimistic versions, reservation
  and settlement replay, exhausted money and unknown usage charged conservatively.
- Epoch/base/stop fencing, expired lease without confirmed stop, independent work
  continuing beside a waiting item, and immutable mission revisions.
- Guard termination after external effect and before result recording, restart to
  uncertain, and refusal to blindly replay.
- Actual child/descendant process termination on timeout and cancellation; mission
  cancellation blocks new Guard effects.
- Separate runtime/operator authentication, grant expiry, registered operation
  enforcement, scope/unsafe-path/link restrictions and forged receipts.
- Candidate mutation after checks, sealed byte mutation before export, signature
  verification, exact binary snapshots, and a bug that appears only after merge.
- Exit 0/printed PASS with no actual protected tests does not establish acceptance.
- Actual openai SDK over a local HTTP fixture for auth expiry/rate limits with one
  attempt and no implicit SDK retry; actual Codex SDK subprocess/stream, unknown
  event and AbortSignal mapping. These are adapter protocol tests, not real GPT.
- Secret redaction, configured secrets embedded in base64 source, and no credential
  inheritance into Codex Worker environment.
- Evaluator/suite tampering, arbitrary suite references, capability expansion,
  lineage trial reset or relaxed criteria, candidate rejection and hold.
- Future-only, project/task-scoped adoption, protected follow-up failure rollback,
  new-operation revocation and in-flight stop/reconciliation records.
- Concurrency limits while queued requests are cancelled.

## Demo observations

The two products are a TypeScript clamp repair and an unrelated normalization
refactoring. In the deterministic fake evaluation, both baseline and candidate
passed 2/2 protected cases. Baseline used two repair retries; the revised prompt
used zero. Both recorded zero operator interventions and zero model spend because
no model was called. The code changed the actual candidate RoleRecipe prompt,
issued a scoped canary and then revoked it. This proves the loop's mechanics,
**not a GPT quality, speed, cost or human-time improvement**.

A retained CLI proof is in ignored `.factory/cli-proof/` (`mission.json`,
`result.json`, exported `artifact/`, public verification key). It contains no
private signing key or provider credential. `node dist/scripts/demo.js` recreates
fresh example state and prints its result/config paths.

## Current environment validation status

| Check                                                    | Status and reason                                                                                                        |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `test:live`                                              | BLOCKED, exit 3: no live configuration, operator-granted live mission or explicit positive live-test budget was supplied |
| Aggregate `check`                                        | PASS, exit 0; schema, type, lint, formatting and 25 offline tests                                                        |
| Real Responses/Codex model availability                  | Not established; example bindings remain disabled                                                                        |
| Actual Docker worker/check isolation and intrusion probe | Not executed; driver and probe are implemented, live remains refused                                                     |
| Linux x64/arm64 execution                                | Earlier Linux arm64 container run passed 25 tests; Linux x64 not executed                                                |
| Human rescue time and real GPT performance               | Not measured; no improvement claim                                                                                       |

See architecture.md for the OS, Docker, acceptance-test and trusted-operator limits.
