# 開発用の環境での通しの確認

配備した開発用の環境（`SanpoChannelConsole-dev`）で、機械審査・試用チケット・審査・鍵の移し替えとメールを本物の AWS で確かめる台本です。テスト用のチャンネルと申請を作り、確かめたあとで消します（操作の記録と、`archive/`・`samples/`・`trial/` のファイルは残り、期限で消えます）。

```sh
export AWS_PROFILE=sanpo-dev
npx tsx tools/e2e/machine-review.ts   # 署名したパッケージが「審査待ち」に、改ざんしたものが「機械の確認で不合格」になる
npx tsx tools/e2e/test-ticket.ts      # 管理 API の Lambda を直接呼んで試用チケットを発行し、署名と trial/ のパッケージを確かめる
npx tsx tools/e2e/review.ts           # 申請 → 機械審査 → 運用者の審査と承認 → リストに載る → 準拠テスト（V-07 まで）→ 後片付け
npx tsx tools/e2e/transfer.ts         # 鍵 A の版 1 を承認 → 鍵 B への移し替えを承認 → 鍵 B の版 2 を承認 → リストに publisherChange（V-16）→ メールの記録 → 後片付け
```

本番の環境では使いません。
