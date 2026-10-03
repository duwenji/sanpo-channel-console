# DES-001 公開の処理・ルート鍵の CLI・準拠テスト（実装の順番 1）

## 文書情報

| 項目 | 内容 |
|---|---|
| 文書ID | DES-001 |
| ドキュメント種別 | 機能設計書 |
| 対象システム/機能 | チャンネル管理システムの土台: 公開の処理（Lambda）、ルート鍵の CLI、API-002 の準拠テスト、AWS CDK |
| 関連Skill | feature-implementation-unified |
| 作成日 | 2026-10-03 |
| 作成者 | Claude（開発者との検討） |
| 承認者 | 開発者（方式は 2026-10-03 に決定。実装は PR でレビュー） |
| ステータス | 実装済（PR レビュー待ち） |
| 版 | 1.0 |

## 目的・背景

[ADR-001](../adr/ADR-001-aws-architecture.md) T-6 の 1 番目。承認済みチャンネル・リスト（SanpoGuide の API-002）を作って署名し、公開するところまでを作る。これで、配信元・運用者の画面がなくても、組み込みの提供元として署名済みのリストを出せる。

## 対応元ID（トレーサビリティ）

| 対応元ID | 内容 | 対応状況 |
|---|---|---|
| ADR-001 | A-6〜A-10、A-16、A-17、T-6 ① | 実装 |
| DM-001 | PUBLICATION・KEYSET・SIGNKEY・CHANNEL（LISTED）・REVOKE（REVOKED）、M-9、M-11、M-13 | 公開の処理が読み書きする |
| SanpoGuide API-002 | P-1〜P-3、P-6〜P-9、確認観点 V-01〜V-09・V-15・V-16 | 実装と準拠テスト |

## 方針・決定事項

### 決定事項（2026-10-03、開発者の回答）

| No. | 論点 | 決定 |
|---|---|---|
| I-1 | 範囲 | AWS には配備しない。単体テスト、`cdk synth`、手元での通しの確認（公開 → 手元の HTTP サーバー → 準拠テスト）まで |
| I-2 | パッケージの管理 | npm workspaces |
| I-3 | 準拠テスト | TypeScript（vitest）。アプリ（Kotlin + Tink）とは別の実装で確かめる |

### 構成

| 場所 | 中身 |
|---|---|
| `packages/protocol` | API-002 の文書の作成と検証（署名付き文書、要約への署名、提供元ID・アカウントID、エラーコード）。公開の処理・CLI・準拠テストが共通に使う。`./testing` はテスト用の提供元 |
| `api/src/publish` | 公開の処理。DB・S3・CloudFront・KMS は差し替え口（`ports.ts`）の後ろにあり、AWS の実装（`aws.ts`）と手元の実装（`local.ts`）がある |
| `tools/root-key` | オフラインの端末で使うルート鍵の CLI（`generate`・`sign-keyset`・`verify-keyset`） |
| `conformance` | 任意の提供元の URL に対する準拠テスト（ライブラリと CLI） |
| `infra` | CDK: DynamoDB（DM-001）、S3（公開用・記録用）、CloudFront（OAC）、KMS（Ed25519）、公開の Lambda、毎日の作り直し、警報 |

### 実装上の判断

| No. | 判断 | 理由 |
|---|---|---|
| J-1 | 公開の処理は、書き出す前に、作ったリストと検出の文書を自分で検証する（アプリと同じ検証） | KMS の鍵が鍵セットの鍵と違う、鍵セットが固定したルート鍵の署名でない、などの誤りを公開しない |
| J-2 | 固定したルート鍵（設定）からつながらない鍵セットでは公開しない | ADR-001 A-9 |
| J-3 | `seq` は `HEAD` の条件付き更新と履歴の追加を 1 つのトランザクションで行い、食い違えば何も公開せずに 1 回だけ作り直す。Lambda の同時実行は 1 | DM-001 M-11、ADR-001 A-10 |
| J-4 | KMS の鍵ポリシーで、公開の Lambda だけに、`ED25519_SHA_512`・`RAW` に限って `kms:Sign` を許す。IAM 側では許さない | ADR-001 A-8。条件のない許可を作らない |
| J-5 | ルート鍵の秘密鍵は合言葉（16 文字以上）で暗号化した PKCS#8 で保存する。Git の作業ツリーの中には作らない | 写しが出回っても使えないようにする。誤ってコミットしないようにする |
| J-6 | 準拠テストは取得の大きさの上限で打ち切り、リダイレクトを追わない。`http://localhost`・`127.0.0.1` は `--allow-local-http` のときだけ許す | API-002 の `too_large`、アプリのデバッグビルドと同じ |
| J-7 | 一覧の有効期限は 14 日、毎日 03:00（日本時間）に作り直す。成功が 2 日ないと警報 | 期限切れの前に必ず気づく |

## 検証結果

| 項目 | 結果 |
|---|---|
| 単体テスト | 45 件すべて合格（protocol 16、公開の処理 11、ルート鍵 5、準拠テストの通し 8、CDK 5） |
| 型の確認 | `tsc -b`（TypeScript 7.0）で誤りなし |
| `cdk synth` | dev・prod とも成功。公開の Lambda は 13.4KB（AWS SDK は実行環境のもの） |
| 手元での通し | `publish:local` → `serve` → `check` で V-01〜V-09・V-15・V-16 がすべて合格。要約は 251 バイト。HTTP は `--allow-local-http` なしでは V-09 で不合格 |
| 準拠テストの異常系 | 提供元IDの不一致（V-01）、本体の差し替え（V-03）、期限切れ（V-04）、`seq` の巻き戻し（V-05）、パッケージの差し替え（V-07）、2MB 超え（V-08）、HTTP（V-09）を、それぞれその項目だけで不合格にする |

## 未決事項・リスク

| No. | 内容 | 対応 |
|---|---|---|
| 1 | ~~AWS への配備は未実施~~ → 2026-10-03 に開発用に配備した（[配備の手順](../operations/deploy.md)）。`tools/provision` で署名鍵と鍵セットを登録して公開し、CloudFront の URL で準拠テストに合格（V-07 はチャンネルがないため対象外） | — |
| 2 | ~~Lambda の実行環境の AWS SDK が、KMS の `ED25519_SHA_512` を受け付けるか~~ → 受け付けた（実行環境の SDK のままで署名・自己検証とも成功） | — |
| 3 | `npm audit` が `aws-cdk-lib` に同梱の `brace-expansion` を 1 件報告（high）。`cdk synth` のときだけ使い、Lambda には入らない | aws-cdk-lib の更新を待つ |
| 4 | 本番・開発のルート鍵はまだない（T-5） | 手順書を作ってから、オフラインの端末で作る |
| 5 | 独自ドメイン（T-7）がないので、CloudFront の既定の証明書（TLS の最低の版を指定できない） | T-7 で証明書と TLS 1.2 以上を設定する |

## 関連ドキュメント・参照リンク

- [ADR-001](../adr/ADR-001-aws-architecture.md)、[DM-001](../data-model.md)、[API-001](../console-api.md)
- SanpoGuide [API-002](https://github.com/duwenji/SanpoGuide/blob/main/docs/channel-list-api.md)
- 検討の記録: [skill-logs/feature_implementation_2026-10-03.md](../skill-logs/feature_implementation_2026-10-03.md)

## 変更履歴

| 日付 | 版 | 変更内容 | 変更者 |
|---|---|---|---|
| 2026-10-03 | 1.0 | 作成 | Claude |
| 2026-10-03 | 1.1 | 開発用への配備の結果を記録。`tools/provision` を追加 | Claude |
