# sanpo-channel-console

SanpoGuide の第三者のチャンネルを審査して公開する **チャンネル管理システム**。

- 配信元: チャンネルの申請・更新、審査状況の確認、試用チケットの発行、鍵の移し替えの申し出
- 運用者: 審査（機械で確かめた結果と、AI に話させた見本）、承認・差し戻し・取り下げ、鍵の移し替えの承認
- 自動: 承認済みチャンネル・リストを作り、署名して公開する

アプリとの境界は、SanpoGuide の [API-002（承認済みチャンネル・リスト）](https://github.com/duwenji/SanpoGuide/blob/main/docs/channel-list-api.md) だけ。

## 構成

AWS（ap-northeast-1）。API Gateway・Lambda・DynamoDB・Cognito・KMS、公開は S3 と CloudFront。詳細は [ADR-001](docs/adr/ADR-001-aws-architecture.md)。npm workspaces のモノレポ（Node.js 22 以上）。

```
packages/protocol  API-002 の文書の作成と検証（共通）
packages/api-types 管理 API の型（docs/api/console.openapi.yaml から生成）
api/               Lambda（TypeScript）。公開の処理（api/src/publish）と管理 API（api/src/console）
tools/root-key     ルート鍵の CLI（オフラインで使う）
tools/provision    配備した提供元に署名鍵・鍵セットを登録して公開する（運用者の画面ができるまで）
conformance/       API-002 の準拠テスト（任意の提供元の URL に対して流せる）
infra/             AWS CDK
web/               運用者・配信元の画面（React + Vite）
validator/         機械審査の Lambda（Kotlin、Gradle、station-format）
tools/e2e          開発用の環境での通しの確認
```

## 使い方

```sh
npm ci
npx tsc -b            # 型の確認
npx vitest run        # テスト（管理 API のテストは Docker で DynamoDB Local を起動する）
npm run build -w web  # 画面をビルド（cdk synth の前に要る）

# 手元で公開して、準拠テストをかける（AWS は不要。鍵は使い捨て）
npm run publish:local -w api            # ../.local/site に書き出し、提供元ID を表示
npm run serve -w conformance            # http://127.0.0.1:8787 で配る
npm run check -w conformance -- http://127.0.0.1:8787 --allow-local-http --provider <提供元ID>

# 任意の提供元に準拠テストをかける
npm run check -w conformance -- https://channels.example.com --provider sc1…

# ルート鍵（オフラインの端末で。Git の作業ツリーの外に）
ROOT_KEY_PASSPHRASE=… npm run root-key -w tools/root-key -- generate --out <フォルダ>
ROOT_KEY_PASSPHRASE=… npm run root-key -w tools/root-key -- sign-keyset --root-key <pem> --in keyset-input.json --out keyset.json

# CloudFormation のテンプレートを作る（配備はまだしない）
cd infra && npx cdk synth -c env=dev -c rootPublicKey=<base64url>
```

## 文書

- **[利用ガイド](docs/guide/README.md)**: 運用者・配信元・開発・保守をする人ごとの使い方（まずここから）

- [TODO.md](docs/TODO.md): 進め方と次にやること
- [ADR-001](docs/adr/ADR-001-aws-architecture.md): AWS の構成
- [DM-001](docs/data-model.md): データモデル
- [API-001](docs/console-api.md): 管理 API（[OpenAPI](docs/api/console.openapi.yaml)）
- [DES-001](docs/design/DES-001-publisher.md): 公開の処理・ルート鍵の CLI・準拠テスト
- [DES-002](docs/design/DES-002-operator-console.md): 運用者の画面
- [DES-003](docs/design/DES-003-publisher-console.md): 配信元の API と画面（3a）
- [DES-004](docs/design/DES-004-machine-review.md): 機械審査と試用チケット（3b）
- [DES-005](docs/design/DES-005-review.md): 運用者の審査（3c）
- [DES-006](docs/design/DES-006-transfer-notify.md): 鍵の移し替えと配信元へのメール（3d）
- [費用](docs/operations/cost.md): 開発用は約 1.5 USD/月
- [配備の手順](docs/operations/deploy.md): 開発用は配備済み（リスト https://d1vs7kc4zgmwrz.cloudfront.net、画面 https://d3gvjt5e1ced74.cloudfront.net）
