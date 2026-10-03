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
api/               Lambda（TypeScript）。今は公開の処理（api/src/publish）
tools/root-key     ルート鍵の CLI（オフラインで使う）
tools/provision    配備した提供元に署名鍵・鍵セットを登録して公開する（運用者の画面ができるまで）
conformance/       API-002 の準拠テスト（任意の提供元の URL に対して流せる）
infra/             AWS CDK
web/               SPA（予定）
validator/         機械審査の Lambda（予定。Kotlin、station-format）
```

## 使い方

```sh
npm ci
npx tsc -b            # 型の確認
npx vitest run        # テスト

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

- [TODO.md](docs/TODO.md): 進め方と次にやること
- [ADR-001](docs/adr/ADR-001-aws-architecture.md): AWS の構成
- [DM-001](docs/data-model.md): データモデル
- [API-001](docs/console-api.md): 管理 API（[OpenAPI](docs/api/console.openapi.yaml)）
- [DES-001](docs/design/DES-001-publisher.md): 公開の処理・ルート鍵の CLI・準拠テスト
- [配備の手順](docs/operations/deploy.md): 開発用は配備済み（https://d1vs7kc4zgmwrz.cloudfront.net）
