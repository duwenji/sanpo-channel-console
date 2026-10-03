# sanpo-channel-console

SanpoGuide の第三者のチャンネルを審査して公開する **チャンネル管理システム**。

- 配信元: チャンネルの申請・更新、審査状況の確認、試用チケットの発行、鍵の移し替えの申し出
- 運用者: 審査（機械で確かめた結果と、AI に話させた見本）、承認・差し戻し・取り下げ、鍵の移し替えの承認
- 自動: 承認済みチャンネル・リストを作り、署名して公開する

アプリとの境界は、SanpoGuide の [API-002（承認済みチャンネル・リスト）](https://github.com/duwenji/SanpoGuide/blob/main/docs/channel-list-api.md) だけ。

## 構成（予定）

AWS（ap-northeast-1）。API Gateway・Lambda・DynamoDB・Cognito・KMS、公開は S3 と CloudFront。詳細は [ADR-001](docs/adr/ADR-001-aws-architecture.md)（2026-10-03 承認）。

```
web/           SPA（配信元・運用者の画面）
api/           Lambda（TypeScript）
validator/     機械審査の Lambda（Kotlin、SanpoGuide の station-format を使う）
infra/         AWS CDK
tools/root-key ルート鍵の CLI（オフラインで使う）
conformance/   API-002 の準拠テスト（任意の提供元の URL に対して流せる）
```

## 文書

- [TODO.md](docs/TODO.md): 進め方と次にやること
- [ADR-001](docs/adr/ADR-001-aws-architecture.md): AWS の構成
