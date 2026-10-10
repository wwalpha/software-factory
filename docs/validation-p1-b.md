# P1-B: 計画内の非Builder実行記録とresume — 2026-10-10

現在のcleanな作業ツリー `d5b67e53a7f996d28fcfe292fc6ab58f65f546f1` を起点に、
`task/p1b-role-resume` で実装・検証した。過去の1010v1プローブを今回の実測として
転記していない。P0・P1-A適用済みのコードを維持し、P1-Cには進んでいない。

## 根本原因と保存契約

修正前は計画内の非Builderの失敗を `state.work[id] = 'waiting'` にするだけで、
成功したRoleReportも保存しなかった。recoverが主にBuilder Attemptを調べるため、
一時失敗を安全に再開する根拠も、成功済み結果を再利用する根拠もなかった。

新しいRuntime所有の内部保存型は `src/ports/role-execution.ts`。
既存recordsテーブルの `role-execution` kindを使う。

- Mission ID/revision、plan revision、WorkItem ID/roleから安定した記録IDを作る。
  入力digest、snapshot digest、実行状態、失敗code、retryable、Waiting、
  最終RoleReportを保持する。
- 各provider呼び出しには別のUUID、入力/snapshot digest、状態、RoleReport、
  Usage、失敗codeを保存する。このUUIDが金額予約・精算IDでもある。
  再試行や既存のbounded-read followupには新しい予約を使う。
- 呼び出し前に実行記録と$0.10予約とoutboxを同じSQLite transactionで保存する。
  呼び出し後は応答とUsageと精算を同じtransactionで保存する。
  最終RoleReportとWorkItem completedも同じtransactionで確定する。
- 完了書込まで進まなかった保存済み最終応答は、再起動時に再利用する。
  独立Builderがsnapshotを更新していても保存済み最終応答は再送しない。
  部分的なread応答は同じ入力digestの場合に再利用し、未完了のfollowupだけを行う。
- 未保存の応答があり得る呼び出しはuncertain。unknown usageは予約額を消費し、
  $0で返却しない。commit応答喪失は保存済み内容の一致を照合する。
- 外部データのRoleReport schema検査、secret拒否、read回数・サイズ・scope検査は維持。
  モデルの出力から実行状態やretryableを採用しない。

既存commitに予約/精算を含められる任意引数を追加し、既存reserve/settleの検査を再利用した。
Builder Admissionのcount、予約、Attempt/dispatch/state/outbox契約は変更していない。
新しいSQLテーブル・DDL migration・依存は不要。
公開JSON Schemaと生成型は変更せず、schema:checkを実行した。

## 再開判断

| 保存済み事実                                           | 動作・再開条件                                                         |
| ------------------------------------------------------ | ---------------------------------------------------------------------- |
| completedとRoleReport、または保存済み最終応答          | 再利用。providerを呼び直さない                                         |
| rate-limited                                           | 明示的resumeで最大1回の再試行                                          |
| auth-expired（SDKの401/403を含む）、binding            | 設定・認証を修正後、明示的resumeで既存provider検査を通す               |
| grant、revoked                                         | 各provider送信前にGuardの既存authorizeを再実行。無効なら送信しない     |
| budget                                                 | 既存Mission金額・経過時間上限を再検査。予約できなければ送信しない      |
| approval                                               | retryable=falseのwaiting。人間のrevisionと対応するoperator grantが必要 |
| refused、incomplete、不正出力/schema、scope/read違反   | failedと理由を保存。resumeだけでは再実行しない                         |
| 不明例外、未分類code、保存前停止、cancel中の不明な応答 | uncertain。無条件再送・成功認定なし                                    |
| cancelled Mission                                      | run/resume/recoverで再開しない                                         |

CLIのresumeは専用Runtime.resumeへ渡す。通常のrunやdaemonの自動recoverでは、
既知の再試行可能な失敗をpendingに戻さない。独立した正常タスクは続行でき、
一つのroleの恒久停止をMission全体の承認条件と取り違えない。

Guardの新しいread-only `authorizeRole` は既存snapshot権限のauthorizeを使い、
caller、Mission revision/digest、grant期限、取消、release失効を再確認する。
新しい効果の権限や承認を発行するAPIではない。provider側の認証・権限は外部サービスが
検証するため、明示的resumeでは認証の再確認リクエストが発生し得る。
認証成功や課金額を事前に保証するものではない。

結果不明・承認待ち・恒久失敗は、operatorが根拠を確認して既存の
`factory revise` → 新revisionのgrant → resume経路を使う。
`authorize-retry` は既存Builder operation用で、role IDに適用できるとは説明していない。
期限切れgrantの同revision更新APIも追加していない。
cancel解除APIは追加せず、新しいMissionでの開始は別操作とする。

同一resume内で失敗したWorkItemを再びpendingにしない。既存の最大2ラウンドの
read protocolは維持し、同じ失敗ラウンドをループ再試行しない。
非BuilderはAttemptを作らず、maxAttemptsを消費しない。

## 旧stateと移行

既存SQLite v1をそのまま開く。新たに受理するplanには任意の
`MissionState.roleJournalVersion = 1` を記録する。この版のpendingかつ記録なしは、
呼び出し前transactionが成立していないため安全に開始できる。

旧stateでもreadyかつstartedAt=nullなら未開始を確認でき、記録方式を更新できる。
実行済みの可能性がある旧pending/running/waiting/completedで記録がない場合は、
workをwaitingにして、履歴不足の理由・operator・人間のrevision/grant経路を示す。
成功や未実行を捏造せず、一括pending化もしない。
既に完了・配送済みのMission、取消済みMissionの履歴は書き換えず、
過去のRoleReportを生成して埋めない。

導入時はRuntimeを停止し、DBを保全したうえでRuntime/Guardを同じ版に更新する。
旧DBへの一括書換え操作は不要。旧版Runtimeにはこの記録方式の保護がないため、
進行中DBを旧版で再開する運用は検証していない。

## 環境・コマンド・結果

macOS **27.0.1 arm64**、Node **24.21.0**、npm **11.19.0**。
package.json/.node-version/.npmrcの指定を維持。
primaryの既存ローカルNodeをPATHに設定し、worktree helperのusage lock内で実行した。

```sh
export PATH="/Users/macmini/Documents/projects/software-factory/.local/node-v24.21.0-darwin-arm64/bin:$PATH"
npm ci
npm run check
node --test dist/tests/role-resume.integration.test.js dist/tests/persistence.integration.test.js

node dist/tests/role-metrics.js d5b67e53a7f996d28fcfe292fc6ab58f65f546f1 transient
node dist/tests/role-metrics.js current transient
node dist/tests/role-metrics.js d5b67e53a7f996d28fcfe292fc6ab58f65f546f1 success
node dist/tests/role-metrics.js current success
```

| 検証                                          | 結果                                                                         |
| --------------------------------------------- | ---------------------------------------------------------------------------- |
| npm ci                                        | PASS。132 packages、lockfile/依存/engine変更なし                             |
| 最初のBefore最小再現                          | **FAIL**。初回waiting、resume後もwaiting、対象role呼出し1回のまま            |
| npm run check                                 | **PASS、108/108**。schema/type/lint/format/buildと全offline回帰、fail/skip=0 |
| role-resume + persistence追加検証             | **PASS、45/45**。role回帰42件、persistence 3件（うち新規1件）、fail/skip=0   |
| Before/After計測probe                         | PASS。修正前不具合と修正後挙動をそれぞれassert                               |
| git diff --check                              | PASS                                                                         |
| Docker / 有料API / test:live / Live readiness | NOT RUN。今回のP1-B対象外・有料API禁止。Docker入力は変更なし                 |
| push / merge / deploy / 自動採用 / P1-C       | NOT RUN。要求どおり実行しない                                                |

Runtime、SQLite worker/DB、Guard、Git、保護チェックは実装を使用。
外部モデル境界はFakePlanner/FakeRunnerおよびSDK error値で制御した。
永続化障害は実SQLite transactionのversion不一致と別プロセスのSIGKILLで注入した。
成功したfake/offline結果を実providerやDocker隔離の証明とは扱わない。
開発途中の金額assert 2件は0.1+0.02と0.12の浮動小数点差で失敗し、
既存の金額計算を変更せず期待値を同じ加算で表現して解消した。

## A–Jの確認

| ケース                   | 実測                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------- |
| A 一度の一時失敗         | waiting→明示resume→completed。対象role計2回                                                       |
| B Runtime/SQLite再作成   | Explorerとtest-designer、異なるIDで同じ結果                                                       |
| C 保存済み成功結果       | 完了Missionと、独立タスク待ちのMissionの両方で再呼出し0                                           |
| D 開始後・応答保存前停止 | uncertain、再呼出し0、unknownとして$0.10保持                                                      |
| E 条件付き停止           | SDK 401/403/429、binding、期限切れgrant、release失効、金額/時間上限、承認、cancel、恒久失敗を確認 |
| F 同じ一時失敗継続       | 初回1回、各resumeにつき追加1回。4回で$0.40 unknown、Attempt=0                                     |
| G 独立タスク             | 成功済みreviewerは1回のまま。別roleの恒久停止理由もBuilder完了後に維持                            |
| H 保存途中失敗           | transaction途中のversion conflictで全rollback。SIGKILLの保存前後もcompleted/resultを照合          |
| I 旧state                | 未開始readyは実行可。判断不能な4状態は履歴不足で停止                                              |
| J P1-A                   | 非Builder失敗→retry後もBuilder Attempt=1/maxAttempts=1。既存P1-A 17件を全体checkで維持            |

別プロセス停止点の結果（Before/Afterはprovider呼出し数）：

| 停止点                               | 停止前 | 再起動後 | 結果・料金                        |
| ------------------------------------ | -----: | -------: | --------------------------------- |
| 呼出し記録/予約transactionのcommit前 |      0 |        1 | completed、実測$0.02              |
| 同commit後・送信前                   |      0 |        0 | uncertain、予約$0.10をunknown消費 |
| provider進入後                       |      1 |        0 | uncertain、$0.10 unknown          |
| 応答/精算transactionのcommit前       |      1 |        0 | uncertain、$0.10 unknown          |
| 同commit後                           |      1 |        0 | 保存応答からcompleted、実測$0.02  |
| 完了transactionのcommit前            |      1 |        0 | 保存応答からcompleted、実測$0.02  |
| 同commit後                           |      1 |        0 | completedを再利用、実測$0.02      |

この回帰範囲では、条件成立済みの再試行不能、成功済み作業の不要再呼出し、
不適切な無条件再実行、新たなcompleted/result欠落、既存回帰の新規失敗はそれぞれ0。
正当なbudget/uncertain停止を再開不能の不具合に数えていない。

## Before/After・書込・保存量

最初のBeforeテストは変更前ソースで実行。追加の比較probeは基準commitからRuntimeだけを
同じdist内の一時moduleへtranspileし、同じfixtureと現在のSQLite実装で測定した。
ソースの巻戻しや旧ZIPの使用はない。保存量はruntime.dbのrecords.valueと
outbox.payloadのUTF-8 JSON bytes合計。DB file/WAL全体のbytesではない。

record書込は同じrecordの再書込みを含む回数。DB行更新はrecord/outbox/予約/精算/ackの
論理更新数で、物理ディスクI/O回数ではない。カウンタはsubmit/grant後から累積、
保存量はその時点のDB全体。Guard DBは比較対象外。

| 同一fixture/時点         | 対象role回数 Before→After | 全report回数 | record書込 | DB行更新 | transaction | 保存JSON bytes |
| ------------------------ | ------------------------- | ------------ | ---------- | -------- | ----------- | -------------- |
| 一時失敗・初回waiting    | 1→1                       | 3→3          | 8→10       | 24→28    | 16→16       | 6,610→8,022    |
| 一時失敗・resume後       | 1→2                       | 3→5          | 11→28      | 30→68    | 19→35       | 6,766→17,665   |
| 初回成功・completed      | 1→1                       | 4→4          | 18→22      | 47→54    | 28→29       | 15,354→16,840  |
| 成功後のresumeによる増分 | 0→0                       | 0→0          | 0→0        | 0→0      | 0→0         | 0→0            |

一時失敗のresume後はBeforeがwaiting、Afterがcompletedなので、
差分には実際に進行できたBuilder・最終検証・配送も含まれる。
純粋な保存コスト比較は初回成功行：provider回数と料金$0.02は同じ、
record書込+4、DB行更新+7、transaction+1、JSON +1,486 bytes。

一時失敗時はunknown $0.10を保持し、再試行成功$0.02を追加して合計$0.12。
SQLite/JavaScriptの表示値は0.12000000000000001。
read followup再試行の回帰でも、初回成功応答を再利用し、
成功2回$0.04 + 失敗unknown $0.10を記録した。

## 変更ファイルと残る境界

| ファイル                                                                       | 内容                                                     |
| ------------------------------------------------------------------------------ | -------------------------------------------------------- |
| src/application/runtime.ts                                                     | 計画内role記録、保存結果再利用、分類resume、完了との整合 |
| src/ports/role-execution.ts                                                    | Runtime所有の永続化型                                    |
| src/ports/store.ts、src/adapters/sqlite.ts、sqlite-worker.ts                   | 既存commitでの原子的な予約・精算                         |
| src/guard/service.ts、src/cli/factoryd.ts                                      | read-only再認可、明示resumeの受付                        |
| src/adapters/fake.ts                                                           | report戻り値を既存RoleReport/Usage型で明記               |
| tests/role-resume.integration.test.ts、role-helpers.ts、fixtures/role-crash.ts | 実Runtime/SQLite、条件・障害・再起動の回帰               |
| tests/persistence.integration.test.ts、role-metrics.ts                         | 原子的会計の回帰、再実行可能な比較probe                  |
| README.md、docs/architecture.md、docs/validation-p1-b.md                       | 操作・保存契約・今回の記録                               |

外部LLMのexactly-onceは保証しない。送信前の記録直後に停止しても、
実際の送信有無を証明できない場合は保守的にunknownとして予約額を保持する。
保存先が回復するまで結果を公開できない場合もある。
未知の履歴を自動で救済する機能や、新しい承認/記憶/ジョブ基盤は作っていない。

対象は計画内の非Builder WorkItem。計画前の調査や最終review等を別の永続ワークフローに
作り替えていない。保存結果をBuilder/次planのpromptへ渡すP1-C、
Docker入力、Builder Attempt枠、保護判定器・署名・取消の権限は拡張していない。
