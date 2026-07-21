// 日本語
export const jaJP: Record<string, string> = {
  // 共通
  'common.loading': '読み込み中...',
  'common.confirm': 'OK',
  'common.cancel': 'キャンセル',
  'common.open': '開く',
  'common.close': '閉じる',
  'common.delete': '削除',
  'common.restore': '復元',

  // タイトルバー
  'titlebar.minimize': '最小化',
  'titlebar.maximize': '最大化',
  'titlebar.close': '閉じる',

  // メインナビゲーション
  'nav.notes': 'Andeyunhui',
  'nav.extensions': '拡張機能',
  'nav.transfer': 'トランスファー',
  'nav.settings': '設定',

  // サイドバー
  'sidebar.niaoluo': '拡張機能',
  'sidebar.searchExt': '拡張機能を検索...',
  'sidebar.noExtInstalled': 'インストール済みの拡張機能はありません',
  'sidebar.noExtMatch': '一致する拡張機能が見つかりません',
  'sidebar.backToList': '拡張機能一覧に戻る',
  'sidebar.manageExtSettings': '拡張機能の設定を管理',
  'sidebar.moduleSettings': 'モジュール設定',
  'sidebar.back': '戻る',

  // 設定 - タブ
  'settings.tab.general': '一般',
  'settings.tab.themes': 'テーマ',
  'settings.tab.extensions': '拡張機能',
  'settings.tab.transfer': 'トランスファー',
  'settings.tab.model': 'モデル',
  'settings.tab.blacklist': 'ブラックリスト',
  'settings.tab.about': '情報',

  // 設定 - 一般 - ズーム
  'settings.general.zoom.title': 'ズーム',
  'settings.general.zoom.level': 'UI ズームレベル',

  // 設定 - 一般 - 言語
  'settings.general.language.title': '言語',
  'settings.general.language.label': '表示言語',
  'settings.general.language.desc': 'アプリの表示言語を選択します。切り替えると即座に反映されます',

  // 設定 - 一般 - ショートカット
  'settings.general.shortcuts.title': 'ショートカットキー',
  'settings.general.shortcuts.resetDefault': 'デフォルトに戻す',
  'settings.general.shortcuts.pressKey': 'キーを押してください...',
  'settings.general.shortcuts.editTip': 'クリックしてショートカットを変更',

  // ショートカット項目
  'shortcut.bold': '太字',
  'shortcut.italic': '斜体',
  'shortcut.link': 'リンク',
  'shortcut.screenshot': 'グローバルスクリーンショット',
  'shortcut.recorder': 'グローバル画面録画',
  'shortcut.clipboard': 'クリップボードウィジェット',
  'shortcut.dropzone': 'トランスファーウィジェット',

  // 設定 - 一般 - 通用
  'settings.general.common.title': '一般',
  'settings.general.tray.title': 'トレイに最小化',
  'settings.general.tray.desc': 'ウィンドウを閉じたときに終了せずシステムトレイに隠す',
  'settings.general.autosave.title': '自動保存',
  'settings.general.autosave.desc': '変更を検出すると元のファイルを自動でバックアップしトランスファーに保存',
  'settings.general.autosave.interval': '保存間隔（秒）',

  // 設定 - テーマ
  'settings.themes.appearance': '外観',
  'settings.theme.system': 'システムに従う',
  'settings.theme.light': 'ライト',
  'settings.theme.dark': 'ダーク',
  'settings.themes.nativeConfig': 'ネイティブテーマ',
  'settings.themes.themeColor': 'テーマカラー',
  'settings.themes.elementColor': '要素カラー',
  'settings.themes.followSystem': 'システムに従う',
  'settings.themes.cn': '中',
  'settings.themes.packConfig': 'テーマパック',
  'settings.themes.selectPack': 'テーマパックを選択',
  'settings.themes.reverseColor': '要素カラーを反転',
  'settings.themes.customBg': 'カスタム背景',
  'settings.themes.selectImage': '画像を選択',
  'settings.themes.display': '表示設定',
  'settings.themes.bodyFont': '本文フォント',
  'settings.themes.searchFont': 'フォントを検索...',
  'settings.themes.systemDefault': 'システムデフォルト',
  'settings.themes.detectingFonts': 'システムフォントを検出中...',
  'settings.themes.noFont': '一致するフォントなし',
  'settings.themes.panelOpacity': 'パネルの不透明度',

  // カラー名
  'color.default': 'デフォルト',
  'color.green': 'クラシックグリーン',
  'color.blue': 'クラシックブルー',
  'color.purple': 'パープル',
  'color.orange': 'オレンジ',

  // 設定 - トランスファー
  'settings.transfer.archiveTitle': 'アーカイブ（ノート / ファイル / 画像）',
  'settings.transfer.archiveDesc': 'あらゆる変更のスナップショットがここに残り、いつでも復元できます',
  'settings.transfer.noArchive': 'アーカイブはありません',
  'settings.transfer.noArchiveDesc': 'コンテンツを編集またはインポートすると自動でスナップショットが生成されます',
  'settings.transfer.snapshotCount': '合計 {count} 件のスナップショット',
  'settings.transfer.clearArchive': 'アーカイブを消去',
  'settings.transfer.confirmClear': 'すべてのアーカイブスナップショットを消去しますか？この操作は元に戻せません。',
  'settings.transfer.restore': '復元',
  'settings.transfer.delete': '削除',
  'settings.transfer.restored': '復元しました：{name}',
  'settings.transfer.restoreFailed': '復元に失敗しました：{err}',
  'settings.transfer.confirmDelete': 'アーカイブ「{name}」を削除しますか？',

  // アーカイブ種別
  'kind.note': 'ノート',
  'kind.image': '画像',
  'kind.file': 'ファイル',

  // 設定 - 情報
  'settings.about.title': 'ソフトウェア情報',
  'settings.about.version': 'バージョン: {v}',
  'settings.about.author': '作者: Rosary · ご利用ありがとうございます',
  'settings.about.previewBoot': '起動画面をプレビュー',
  'settings.about.previewDesc': 'テーマを選択すると起動アニメーションを全画面でプレビューできます',
  'settings.about.githubRelease': 'GitHub のリリースページへ',
  'settings.about.checkUpdate': '更新を確認',
  'settings.about.officialRelease': 'Andeyunhui のリリースページへ',
  'settings.about.open': '開く',
  'settings.about.dataBackup': 'データバックアップ',
  'settings.about.exportBackup': 'バックアップをエクスポート',
  'settings.about.backupName': 'バックアップ',
  'settings.about.exportSuccess': 'バックアップのエクスポートに成功しました！',
  'settings.about.exportFailed': 'エクスポートに失敗しました。もう一度お試しください',
  'settings.about.errorLog': 'エラーログ',
  'settings.about.errorLogDesc': 'ログフォルダを開きます。log ファイルを開発者に提出して問題を調査できます',
  'settings.about.openFolder': 'フォルダを開く',
};
