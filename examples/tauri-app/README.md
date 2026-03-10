# tauri-plugin-configurate Example App

このサンプルは `tauri-plugin-configurate` の実運用に近い使い方をまとめたものです。

## 含まれる例

- JSON provider (`app.json`)
- Binary provider + encryption + keyring (`secret.bin`)
- SQLite provider + keyring (`example-configurate.db`)
- Batch APIs (`loadAll/saveAll`) と `unlock`

## 起動方法

```bash
pnpm install
pnpm tauri dev
```

## 画面で試せる操作

- `seed all`: JSON/Binary/SQLite を一括で作成/保存
- `loadAll().unlock()`: 3種を一括読込し、keyring項目を復元
- `saveAll().lock()`: 3種を一括保存し、秘密情報は keyring へ退避
- `sqlite save/load/delete`: SQLite 単体の挙動確認

## 主なファイル

- `src/App.svelte`: フロント操作 UI
- `src-tauri/src/lib.rs`: plugin 登録
- `src-tauri/capabilities/default.json`: required permissions
