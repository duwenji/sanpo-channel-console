# 配備の手順

ADR-001 の構成を AWS に配備し、承認済みチャンネル・リストを出せる状態にする手順。運用者の画面ができるまでは、署名鍵と鍵セットの登録を `tools/provision` で行う。

## 開発用（dev）

| 項目 | 値 |
|---|---|
| AWS アカウント | 140023390410（SSO プロファイル `sanpo-dev`） |
| リージョン | ap-northeast-1 |
| スタック | `SanpoChannelConsole-dev` |
| 提供元ID | `sc1363urrzsrhjuxasgz5pnxkcf5mcieqhv` |
| ルート鍵の公開鍵 | `YMe_dQimd3AaMZs5izjDlXjnAKdq7Vi9nfagFVjECEI` |
| 公開 URL | https://d1vs7kc4zgmwrz.cloudfront.net |
| 初回の配備 | 2026-10-03（準拠テスト合格。チャンネルはまだない） |

開発用のルート鍵の秘密鍵と合言葉は、リポジトリの外（配備した端末のユーザーのホームの `.sanpo-channel-console/dev/`、アクセス権は本人のみ）にある。開発用の提供元はアプリに内蔵しない（ADR-001 A-2）。本番のルート鍵は T-5 の手順書に従い、オフラインの端末で作る。

### 手順

```sh
aws sso login --profile sanpo-dev
export AWS_PROFILE=sanpo-dev

# 1. 配備（CDK の bootstrap は済んでいる。版 25）
cd infra
npx cdk diff   -c env=dev -c rootPublicKey=YMe_dQimd3AaMZs5izjDlXjnAKdq7Vi9nfagFVjECEI
npx cdk deploy -c env=dev -c rootPublicKey=YMe_dQimd3AaMZs5izjDlXjnAKdq7Vi9nfagFVjECEI
cd ..

# 2. 署名鍵と鍵セットを登録し、1 回公開する（済んでいる手順は飛ばす）
npm run provision -w tools/provision -- --env dev --root-key ~/.sanpo-channel-console/dev

# 3. 準拠テスト
npm run check -w conformance -- https://d1vs7kc4zgmwrz.cloudfront.net --provider sc1363urrzsrhjuxasgz5pnxkcf5mcieqhv
```

- `tools/provision` は、スタックの出力から KMS の署名鍵を読み、KMS から公開鍵を取り出して `SIGNKEY` に登録する。鍵セットに載っていない鍵があれば、ルート鍵で新しい鍵セット（`seq` + 1、署名鍵の有効期間 180 日）に署名して `KEYSET` に登録する。最後に公開の Lambda を 1 回呼ぶ
- 以後は、毎日 03:00（日本時間）に EventBridge Scheduler が作り直す

## 本番用（prod）

未配備。本番用のアカウント、本番のルート鍵（T-5）、独自ドメイン（T-7）がそろってから。
