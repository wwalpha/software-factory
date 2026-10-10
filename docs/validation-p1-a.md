# P1-A: Attempt admission atomicity and persistence

2026-10-10 JST、現在の作業ツリーで実装・測定。対象はP1-Aのみ。
1010v1プローブや過去の検証結果を今回の実測として転記していない。

開発は元の`master`作業ツリーで直接行った。worktreeスキルの隔離・task usage lockを
使う開発手順は未実施。以下のPASSはコード・試験の結果であり、worktree helperの
`TESTED`や統合検証済みの状態を示さない。今回のコミットはユーザーの明示指示による。

## Root cause and change

`Runtime.run`のBuilder分岐は、メモリ上のAttempt数確認後に
`await store.list`を挟み、金額予約・Attempt/State保存・dispatch保存を
別々に実行していた。独立Builderが同じ残枠を確認でき、保存失敗時には
予約だけが残り得た。改訂時の`attempts: []`も消費数を隠していた。

`Runtime.admit`は既存の保存queue内で受付snapshotを作り、
`PersistencePort.commit`の最小の追加引数`AttemptAdmission`を渡す。
SQLite workerの既存`BEGIN IMMEDIATE` transaction内で以下を確定する。

- 保存済みMissionの予算と全revisionのBuilder Attempt数を確認。
- Attempt/Operation ID、MissionState参照、build要求の対応を確認。
- 既存reserve処理で金額を予約。
- State・Attempt・dispatch要求・受付を含む`guard.dispatch` outboxを保存。

失敗時はすべてrollbackする。メモリ上のAttempt参照はcommit確定後に反映。
実Runnerの区間は既存の2-slot Laneを維持する。SQLiteのtransactionと
version判定が永続保証を担い、保存queueはプロセス内のsnapshot競合だけを抑える。

保存応答だけを失った場合は、元のAttempt/Operation IDでAttempt・dispatch内容・
State参照を照合してからdispatchする。DB自体が読めない場合はdispatchしない。
再起動時は`reserved` Attemptの元の要求を読み、Guardにintentが存在しない場合に
同じIDを送信する。Guardに記録があれば既存の結果照合・停止確認・明示retry認可を使う。
不明usageは返却しない。Guardのintent commitがduplicateだった場合は新規Runnerを
起動せず、同じ要求の並行到着も防ぐ。完了済みの同一要求は既存結果を返す。

改訂時にもAttempt参照を維持し、旧DBで欠落した参照は保存済みAttemptから復元する。
旧revisionのdispatchを新revisionの作業として再実行・受理しない。
予算拒否は`budget: Attempt budget exhausted`等の理由を保存し、未実行作業を完了扱いにしない。
SQLite workerからFactoryErrorのcodeを保持して返し、予算拒否を単なるstore障害にしない。

## Changed files

| File                                          | Change                                                                                                  |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `src/application/runtime.ts`                  | Atomic admission, same-ID commit reconciliation/recovery, preserved consumed attempts and budget reason |
| `src/ports/store.ts`                          | Optional admission descriptor on existing commit                                                        |
| `src/adapters/sqlite.ts`                      | Forward admission/fault descriptor and preserve error code                                              |
| `src/adapters/sqlite-worker.ts`               | Transactional limit/count/reservation/state/dispatch/outbox, reused reserve implementation              |
| `src/guard/service.ts`                        | Duplicate intent commit cannot start another Runner                                                     |
| `tests/attempt-admission.integration.test.ts` | 17 regression cases for A–H and independent SQLite connections/revision                                 |
| `tests/attempt-helpers.ts`                    | Real Runtime/SQLite/Guard harness, deterministic barriers, instrumentation                              |
| `tests/fixtures/attempt-crash.ts`             | Dedicated child and temporary DB fault points/Runner-start record                                       |
| `docs/architecture.md`                        | Admission and recovery semantics                                                                        |
| `docs/validation-p1-a.md`                     | This result record                                                                                      |

## Environment and commands

macOS arm64、Node **24.21.0**、npm **11.19.0**。
`package.json`、`.node-version`、`.npmrc`の制約を維持。
以下のPATHを各コマンドに適用。

```sh
export PATH="$PWD/.local/node-v24.21.0-darwin-arm64/bin:$PATH"
npm ci
npm run check
node --test dist/tests/attempt-admission.integration.test.js
PRODUCT_CHECK_IMAGE=sha256:bfe7fbde41af52e161a3e420330f7bd89e8b8c199d028cba1c0e5b35232e8e4c npm run test:docker:checks
```

| Check                                    | Result                                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------------------------ |
| `npm ci`                                 | PASS、132 packages、engine/lockfile変更なし                                                |
| Current-source Before, A/C               | A FAIL: Attempt=2, Guard build sends=2, Runner starts=2 with maxAttempts=1. C PASS: peak=2 |
| `npm run check`                          | PASS、schema/type/lint/format/build、offline 65/65、fail/skip=0                            |
| Additional P1-A regression               | PASS、17/17、fail/skip=0                                                                   |
| P0 Docker regression, pinned image above | PASS、6/6、fail/skip=0、23.06s                                                             |
| Paid LLM / `test:live` / live readiness  | NOT RUN、禁止・対象外。Live readinessを承認していない                                      |

通常の制限環境での最初の`npm run check`はUnix socketの`listen EPERM`で
既存保護試験・IPC試験が実行を完遂できなかった。試験用socketを許可した
ローカル実行環境で全検証を完了した。初回Dockerコマンドも
`PRODUCT_CHECK_IMAGE`未指定で前提gateがBLOCKED。
記録済みimageが現在ローカルに実在することを`docker image inspect`で確認し、
指定して再実行した。これらの途中失敗をPASSに読み替えていない。

## Before/After and cost

最初のBeforeは修正前の作業ツリーで実行。
追加比較は修正前の対象5ソースをGitから専用一時directoryに取り出し、
同じテスト・計測helper、同じNode/npm/SQLiteで実行した。
比較元は`0587bd3dc3022ca5aa4138c8c692f6f3d3c933c0`の対象ソース。
作業ツリーを過去コードに戻していない。

barrierが両Builderの既存Attempt照会を完了させてから解放する。
sleepによる偶然の競合に依存しない。Cでは両Runner進入を待って解放する。
Runnerは外部テストダブルだが、Runtime・SQLite worker/DB・Guard/OperationRecordは実物。

| Same fixture                                                | Before           | After            |
| ----------------------------------------------------------- | ---------------- | ---------------- |
| maxAttempts=1, created/sends/new starts                     | 2 / 2 / 2 (FAIL) | 1 / 1 / 1 (PASS) |
| maxAttempts=1, admission time per accepted attempt          | 0.703 / 0.796ms  | 0.671ms          |
| maxAttempts=1, run duration                                 | 30.774ms         | 29.320ms         |
| maxAttempts=1, record writes / SQL mutations / transactions | 18 / 44 / 23     | 16 / 32 / 16     |
| maxAttempts=2, new starts / peak                            | 2 / 2            | 2 / 2            |
| maxAttempts=2, admission time                               | 0.645 / 0.718ms  | 0.527 / 0.765ms  |
| maxAttempts=2, overlapping execution interval               | 0.028ms          | 0.033ms          |
| maxAttempts=2, record writes / SQL mutations / transactions | 18 / 44 / 23     | 18 / 42 / 19     |

計測範囲はsubmit/grant後からrun終了まで、Runtime DBのみ。
受付時間はBuilderのAttempt照会開始からGuard build送信までの待ち時間を含む。
record writesは成功commitのrecords更新数。SQL mutationsはrecords・outbox・
reservation INSERT/UPDATEとackをhelperで数えた値で、物理ディスク/WAL page書込数ではない。
transactionsはcommit/reserve/settleの成功transaction数。拒否/rollbackした受付を除く。
時間は単回・小fixtureの実測で、性能改善や大規模DBの性能保証には使えない。
2枠比較では統合により受付1件あたりtransactionを3→1、SQL mutationを6→5に削減。
追加コストはtransaction内のMission/Attempt数照会と、dispatch前の保存済み要求照合。

## Regression evidence

| Case                    | Verified behavior                                                                                                       |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| A                       | maxAttempts=1で新規Attempt・Runner起動各1、未実行必須作業はwaiting、理由budget                                          |
| B                       | 消費済み枠をseedし、残枠0/1/2 × 直列/並列の6件、resume後も総数2を維持                                                   |
| C/H                     | 2件のRunner実行が重なりpeak=2。同じRuntimeへの同時run/resume相当呼出しをactive scheduler拒否                            |
| D                       | 同じ受付commitの再送はduplicate、変更payload拒否、予約1件。Guard送信4回（in-flight/完了/変更要求を含む）、新規Runner1回 |
| D, concurrent           | Guardの初回照会をbarrierで競合させ同一要求2回送信、新規Runner1回、もう一方uncertain                                     |
| E                       | 予約後のstate version失敗でtransaction全rollback、Attempt/build dispatch/新規Runner/予約/不明費用=0                     |
| F, lost reply           | 実commit後に応答例外を注入、同じ保存済みIDを照合し、受付・Runner各1                                                     |
| E/F, process kill       | 専用子プロセスがcommit前/後でSIGKILL。再open時の保存済みAttemptは0/1。Runtime再起動後のRunner各1、二重受付なし          |
| G, exception            | Guard intent後のRunner結果不明。resumeしても再送・新規受付なし、0.2 USDをunknownとして保持、waiting                     |
| G, process kill         | 実Runner効果後・Guard結果保存前に専用子だけSIGKILL。停止前起動1、再起動後0、Runtime費用0.2 USDをunknownとして保持       |
| Independent connections | 同じ受付を別SQLite worker接続から同時commitして1回だけ確定。別IDの競合受付はDBの上限判定で拒否                          |
| Revision                | 消費済みAttempt参照を改訂後も維持、新revisionでも追加枠を作らない                                                       |

実データ・開発者の既存プロセスを停止していない。
初期試験のbarrier待機が残った自分の試験parent/childだけは識別して終了した。

## Compatibility and limits

DB schemaはversion 1のまま。新しいtable/column、公開JSON Schema、生成型の変更・移行は不要。
`reserved`は既存Attempt enumの値。従来の`running` Attemptは従来の保守的な復旧経路を維持する。
既存のrecords/outbox digestは追加引数を省略すると従来と同じJSONとなり、重複照合を維持する。
過去に参照だけ失った消費済みAttemptは復元するが、過去の孤立reservationを推測で返却しない。

同一Mission schedulerの排他は既存Runtime Setとdaemon owner PID lockの契約を維持。
別Runtimeを無制限に同時schedulerとして使える設計にはしていない。
受付上限と予約の原子性は別SQLite接続でもtransactionで保護する。
未知の外部効果はGuardの既存照合・停止・operator認可に依存し、自動で新ID実行しない。

Attempt数照会はrecordsのBuilder AttemptをMission IDで抽出するため、大量の履歴での
transaction時間は未測定。汎用ロック、分散job基盤、P1-B/C/D、追加依存、Live設定、
自動採用、push/merge/deployは変更・実行していない。
P0のEvaluator隔離、署名付きEvidenceReceipt、seal拒否・改ざん検証はoffline/Docker回帰で維持。
