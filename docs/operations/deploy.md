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
| 運用者の画面 | https://d3gvjt5e1ced74.cloudfront.net（2026-10-04 配備） |
| ログイン | https://sanpo-channel-console-dev.auth.ap-northeast-1.amazoncognito.com（ユーザープール `ap-northeast-1_wfKw6aCwX`） |
| 運用者 | tofumiyoshi@gmail.com（`operator` グループ） |

開発用のルート鍵の秘密鍵と合言葉は、リポジトリの外（配備した端末のユーザーのホームの `.sanpo-channel-console/dev/`、アクセス権は本人のみ）にある。開発用の提供元はアプリに内蔵しない（ADR-001 A-2）。本番のルート鍵は T-5 の手順書に従い、オフラインの端末で作る。

### 手順

```sh
aws sso login --profile sanpo-dev
export AWS_PROFILE=sanpo-dev

# 1. 配備（CDK の bootstrap は済んでいる。版 25）。SPA を先にビルドする
npm run build -w web
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
- 運用者の画面ができたので、署名鍵と鍵セットの登録は画面（「署名鍵・鍵セット」）でもできる。`tools/provision` は最初の 1 回や、画面が使えないときに使う

### 運用者を足す

運用者は登録の画面からはなれない。管理者が作り、`operator` グループに入れる（ADR-001 A-4）。

```sh
aws cognito-idp admin-create-user --user-pool-id ap-northeast-1_wfKw6aCwX --username <メール>   --user-attributes Name=email,Value=<メール> Name=email_verified,Value=true --desired-delivery-mediums EMAIL
aws cognito-idp admin-add-user-to-group --user-pool-id ap-northeast-1_wfKw6aCwX --username <メール> --group-name operator
```

仮のパスワードがメールで届く。最初のログインでパスワードを変え、認証アプリで MFA（TOTP）を登録する。

### 手元で SPA を動かす

```sh
CONSOLE_URL=https://d3gvjt5e1ced74.cloudfront.net npm run dev -w web   # http://localhost:5173
```

開発用のユーザープールは `http://localhost:5173/callback` を許しているので、そのままログインできる（本番は許さない）。

## 本番用（prod）

未配備。本番用のアカウント、本番のルート鍵（T-5）、独自ドメイン（T-7）がそろってから。
