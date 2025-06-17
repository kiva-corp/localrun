# localrun Tests

このプロジェクトでは、Mocha を使用してテストを行います。

## テストの実行

```bash
# すべてのテストを実行
npm test

# テストをwatchモードで実行
npm run test:watch

# ビルドしてからテスト
npm run build && npm test
```

## テストファイル

- `test/basic.test.ts` - 基本的な動作テスト
- `test/types.test.ts` - TypeScript 型定義のテスト
- `test/chunk-utils.test.ts` - MessageChunker クラスのテスト
- `test/tunnel.test.ts` - Tunnel クラスのテスト
- `test/index.test.ts` - メインモジュールのテスト
- `test/cli.test.ts` - CLI ツール（lr.ts）のテスト

## テスト環境

- TypeScript + ES Modules
- Mocha (テストフレームワーク)
- Chai (アサーションライブラリ)
- ts-node (TypeScript 実行環境)

## テスト対象

### MessageChunker

- メッセージの分割が必要か判定
- 大きなメッセージの分割
- UTF-8 文字の正しい処理
- チャンクの復元
- 順不同チャンクの処理
- メモリリーク防止のクリーンアップ

### Tunnel

- トンネル作成とオプション処理
- 統計情報の取得
- グレースフルシャットダウン
- エラーハンドリング
- イベント処理

### CLI

- コマンドライン引数の解析
- ヘルプとバージョン表示
- HTTPS 証明書検証
- 環境変数サポート
- シグナルハンドリング

### Types

- TypeScript 型定義の正確性
- インターフェース構造の検証

## 注意事項

テストの一部は外部サービスへの接続を試行するため、ネットワーク環境によっては失敗する場合があります。これは正常な動作です。
