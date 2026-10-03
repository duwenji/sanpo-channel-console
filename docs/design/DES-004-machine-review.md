# DES-004 機械審査と試用チケット（実装の順番 3b）

## 文書情報

| 項目 | 内容 |
|---|---|
| 文書ID | DES-004 |
| ドキュメント種別 | 機能設計書 |
| 対象システム/機能 | 機械審査の Lambda（Kotlin、station-format）、試用チケットの API と画面 |
| 関連Skill | feature-implementation-unified |
| 作成日 | 2026-10-04 |
| 作成者 | Claude（開発者との検討） |
| 承認者 | 開発者（方式は 2026-10-04 に決定。実装は PR でレビュー） |
| ステータス | 実装済・開発用に配備済（本物の AWS で通しの確認済み） |
| 版 | 1.0 |

## 目的・背景

[DES-003](DES-003-publisher-console.md)（3a）で配信元が上げたパッケージを、アプリと同じコード（SanpoGuide の station-format 1.1.0）で確かめ、合格なら運用者の審査待ちに入れる（ADR-001 A-11）。あわせて、機械審査に合格した申請を、配信元が審査の前に自分の端末で試せる試用チケットを出す（ADR-001 A-13、API-002）。

## 対応元ID（トレーサビリティ）

| 対応元ID | 内容 | 対応状況 |
|---|---|---|
| ADR-001 | A-11（機械審査）、A-13（試用チケット）、A-8（署名鍵で署名） | 実装 |
| API-001 | C-1（見本用のプロンプトを station-format で組み立てる）、試用チケットの操作、`Validation` | 実装 |
| DM-001 | 申請の `uploading` → `validating`/`awaiting_review`/`validation_failed`、`samples/`、TICKET、QUOTA の `tickets`、M-4 | 実装 |
| SanpoGuide API-002・API-003 | 試用チケットの形式、確認の手順 2〜10 とエラーコード | 実装 |

## 方針・決定事項

| No. | 判断 | 理由 |
|---|---|---|
| J-1 | 機械審査は Java 21 の Lambda（Kotlin）。S3 の `intake/` へのアップロードで起動し、パッケージとアイコンの両方がそろった時点で確かめる | アプリと同じ station-format の判定を使う（審査とアプリの判定をずらさない） |
| J-2 | 判定（`MachineReview`）と AWS の読み書き（`Handler`）を分ける。判定は単体テストで確かめる | AWS なしでテストできる |
| J-3 | station-format の確認（ZIP・署名・`channel.json`・スロット）に加えて、チャンネル ID の一致（`id_mismatch`）、申請したときの配信元のアカウントIDの一致（`publisher_mismatch`）、最後に承認した版より新しいこと（`version_not_newer`）、アイコン（PNG、256×256 以下、100KB 以下。`bad_icon`）を確かめる。パッケージとアイコンの問題は両方返す | 管理システムだけが知っていること |
| J-4 | 合格: 申請を `awaiting_review` にし、審査待ちの一覧（`QUEUE#REVIEW`）に入れ、版・SHA-256・大きさ・アイコンの SHA-256・結果を記録し、見本用のプロンプト（`ReviewSamples`）を記録用の S3 の `samples/{申請ID}/prompts.json` に置く | 3c の審査で使う |
| J-5 | 不合格: 申請を `validation_failed` にし、理由（エラーコードと詳細）を記録し、チャンネルを空け、ファイルを `archive/` に移す（90 日で消える） | DM-001 M-4 |
| J-6 | 両方のファイルの通知が同時に来ても、記録は `state = uploading` を条件にした 1 つのトランザクションなので、1 回しか記録されない | DM-001 M-11 |
| J-7 | 機械審査の操作の記録は、actor を `system`（`machine-review`）として残す | DV-10 |
| J-8 | 試用チケットは、機械審査に合格した申請（審査待ち・審査中・差し戻し・承認）だけ。パッケージを公開用の S3 の `trial/{SHA-256}.zip` に写し（7 日で消える。差し戻しは `archive/` から、承認済みは `pkg/` をそのまま使う）、1 日 10 枚まで | API-002、DM-001 M-2 |
| J-9 | 試用チケットは、ルート鍵で検証した今の鍵セットのうち、期間内で失効しておらず `active` の最新の署名鍵で署名する（公開の処理と同じ選び方）。KMS の署名は、鍵ポリシーで管理 API の Lambda にも、`ED25519_SHA_512`・`RAW` に限って許す | ADR-001 A-8。IAM 側では許さない |
| J-10 | QR コードには、署名済みの文書の JSON をそのまま入れる（約 750 文字）。画面で qrcode-generator で描く | API-002 |
| J-11 | 機械審査の Lambda は SanpoGuide の GitHub Packages から station-format を読み込む。CI は `GITHUB_TOKEN`（`packages: read`）、手元は SanpoGuide で `publishToMavenLocal` したものでもよい | ADR-001 T-4 |

## 検証結果

| 項目 | 結果 |
|---|---|
| 機械審査の単体テスト（Kotlin） | 5 件合格。正しいパッケージの合格と見本（そのチャンネルが話さない場面は除く）、チャンネル ID・配信元・版の不一致、改ざん・壊れた ZIP・不正な値、アイコンの不正、時刻と ID の形 |
| TypeScript のテスト | 86 件合格（試用チケット 3 件: 署名をアプリと同じ方法で検証、差し戻しは `archive/` から、1 日 10 枚、配信元だけ） |
| CDK | 11 件（Java の Lambda、`intake/` の通知、鍵ポリシーで 2 つの Lambda に署名を許し IAM では許さない） |
| 本物の AWS での通しの確認（`tools/e2e`） | 画面と同じ処理（WebCrypto）で署名したパッケージが、Java の Lambda 上の station-format（Kotlin）の検証に通り、2.7〜4.7 秒で審査待ちに。改ざんしたものは 2.1 秒で `bad_signature` で不合格になり、チャンネルが空いた。試用チケットは KMS で署名され、公開中の鍵セットで検証でき、`trial/` のパッケージを CloudFront から取得でき SHA-256 が一致した |
| 通しの確認で見つけた不具合 | `tools/provision` が署名鍵の記録に有効期間を書いていなかったため、試用チケットの署名で鍵が見つからなかった。署名鍵の選び方を「今の鍵セットから」に直し、`tools/provision` も有効期間を書くようにし、開発用のデータを補った |

## 未決事項・リスク

| No. | 内容 | 対応 |
|---|---|---|
| 1 | 機械審査の Lambda のコールドスタート（Java）は数秒 | 審査は非同期で、配信元の待ちは数十秒以内。問題になれば SnapStart |
| 2 | `appStage`（必要なアプリの段）は今は常に 1（素材・きっかけは station-format がまだ拒む） | 素材に対応するとき |
| 3 | 試用チケットをアプリで読み込む処理はアプリ側に未実装 | SanpoGuide の ADR-001 T-5 |
| 4 | ~~CI で SanpoGuide の GitHub Packages を読むための設定~~ → 不要だった。SanpoGuide は公開リポジトリで、`GITHUB_TOKEN`（`packages: read`）のまま読めた（PR #9 の CI で確認） | — |

## 関連ドキュメント・参照リンク

- [DES-003](DES-003-publisher-console.md)、[API-001](../console-api.md)、[DM-001](../data-model.md)、[通しの確認](../../tools/e2e/README.md)
- SanpoGuide [API-002](https://github.com/duwenji/SanpoGuide/blob/main/docs/channel-list-api.md)・[API-003](https://github.com/duwenji/SanpoGuide/blob/main/docs/channel-package-format.md)

## 変更履歴

| 日付 | 版 | 変更内容 | 変更者 |
|---|---|---|---|
| 2026-10-04 | 1.0 | 作成 | Claude |
