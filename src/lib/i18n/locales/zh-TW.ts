// 繁體中文
export const zhTW: Record<string, string> = {
  // 通用
  'common.loading': '載入中...',
  'common.confirm': '確定',
  'common.cancel': '取消',
  'common.open': '開啟',
  'common.close': '關閉',
  'common.delete': '刪除',
  'common.restore': '還原',

  // 標題列
  'titlebar.minimize': '最小化',
  'titlebar.maximize': '最大化',
  'titlebar.close': '關閉',

  // 主導覽
  'nav.notes': '安得雲薈',
  'nav.extensions': '茑蘿',
  'nav.transfer': '中轉站',
  'nav.settings': '設定',

  // 側邊欄
  'sidebar.niaoluo': '茑蘿',
  'sidebar.searchExt': '搜尋擴充...',
  'sidebar.noExtInstalled': '尚無已安裝的擴充',
  'sidebar.noExtMatch': '找不到符合的擴充',
  'sidebar.backToList': '返回擴充列表',
  'sidebar.manageExtSettings': '管理擴充設定',
  'sidebar.moduleSettings': '模組設定',
  'sidebar.back': '返回',

  // 設定 - 分頁
  'settings.tab.general': '一般',
  'settings.tab.themes': '主題',
  'settings.tab.extensions': '茑蘿',
  'settings.tab.transfer': '中轉',
  'settings.tab.model': '模型',
  'settings.tab.blacklist': '黑名單',
  'settings.tab.about': '關於',

  // 設定 - 一般 - 縮放
  'settings.general.zoom.title': '縮放',
  'settings.general.zoom.level': 'UI 縮放等級',

  // 設定 - 一般 - 語言
  'settings.general.language.title': '語言',
  'settings.general.language.label': '介面語言',
  'settings.general.language.desc': '選擇應用程式介面顯示的語言，切換後立即生效',

  // 設定 - 一般 - 快捷鍵
  'settings.general.shortcuts.title': '快捷鍵設定',
  'settings.general.shortcuts.resetDefault': '還原預設',
  'settings.general.shortcuts.pressKey': '請按鍵...',
  'settings.general.shortcuts.editTip': '點擊修改快捷鍵',

  // 快捷鍵項目
  'shortcut.bold': '粗體',
  'shortcut.italic': '斜體',
  'shortcut.link': '連結',
  'shortcut.screenshot': '全域截圖',
  'shortcut.recorder': '全域錄影',
  'shortcut.clipboard': '剪貼簿浮動視窗',
  'shortcut.dropzone': '中轉站浮動視窗',

  // 設定 - 一般 - 通用
  'settings.general.common.title': '通用',
  'settings.general.tray.title': '最小化至系統匣',
  'settings.general.tray.desc': '關閉視窗時隱藏至系統匣，而非結束程式',
  'settings.general.autosave.title': '自動儲存',
  'settings.general.autosave.desc': '偵測到變更後自動備份原檔案並儲存至中轉站',
  'settings.general.autosave.interval': '儲存間隔（秒）',

  // 設定 - 主題
  'settings.themes.appearance': '外觀',
  'settings.theme.system': '跟隨系統',
  'settings.theme.light': '淺色',
  'settings.theme.dark': '深色',
  'settings.themes.nativeConfig': '原生主題設定',
  'settings.themes.themeColor': '主題配色',
  'settings.themes.elementColor': '元素配色',
  'settings.themes.followSystem': '跟隨系統',
  'settings.themes.cn': '中',
  'settings.themes.packConfig': '主題包設定',
  'settings.themes.selectPack': '選擇主題包',
  'settings.themes.reverseColor': '反轉元素配色',
  'settings.themes.customBg': '自訂背景圖',
  'settings.themes.selectImage': '選擇圖片',
  'settings.themes.display': '顯示設定',
  'settings.themes.bodyFont': '內文字型',
  'settings.themes.searchFont': '搜尋字型...',
  'settings.themes.systemDefault': '系統預設',
  'settings.themes.detectingFonts': '正在偵測系統字型...',
  'settings.themes.noFont': '無相符字型',
  'settings.themes.panelOpacity': '面板透明度',

  // 配色名稱
  'color.default': '預設',
  'color.green': '經典綠',
  'color.blue': '經典藍',
  'color.purple': '紫色',
  'color.orange': '橙色',

  // 設定 - 中轉
  'settings.transfer.archiveTitle': '存檔（筆記 / 檔案 / 圖片）',
  'settings.transfer.archiveDesc': '任何內容變動都會在此留下快照，可隨時還原',
  'settings.transfer.noArchive': '尚無存檔',
  'settings.transfer.noArchiveDesc': '編輯或匯入內容後會自動產生快照',
  'settings.transfer.snapshotCount': '共 {count} 個快照',
  'settings.transfer.clearArchive': '清空存檔',
  'settings.transfer.confirmClear': '確定清空所有存檔快照？此操作無法復原。',
  'settings.transfer.restore': '還原',
  'settings.transfer.delete': '刪除',
  'settings.transfer.restored': '已還原：{name}',
  'settings.transfer.restoreFailed': '還原失敗：{err}',
  'settings.transfer.confirmDelete': '確定刪除存檔「{name}」？',

  // 存檔類型
  'kind.note': '筆記',
  'kind.image': '圖片',
  'kind.file': '檔案',

  // 設定 - 關於
  'settings.about.title': '關於軟體',
  'settings.about.version': '版本: {v}',
  'settings.about.author': '作者: Rosary · 感謝你的使用',
  'settings.about.previewBoot': '預覽載入畫面',
  'settings.about.previewDesc': '選擇主題即可全螢幕預覽載入動畫',
  'settings.about.githubRelease': '前往 GitHub 發布頁',
  'settings.about.checkUpdate': '檢查更新',
  'settings.about.officialRelease': '前往安得雲薈發布頁',
  'settings.about.open': '開啟',
  'settings.about.dataBackup': '資料備份',
  'settings.about.exportBackup': '匯出備份',
  'settings.about.backupName': '備份',
  'settings.about.exportSuccess': '備份匯出成功！',
  'settings.about.exportFailed': '匯出失敗，請重試',
  'settings.about.errorLog': '錯誤紀錄',
  'settings.about.errorLogDesc': '開啟紀錄資料夾，可直接提交 log 檔案給開發者排查問題',
  'settings.about.openFolder': '開啟資料夾',
};
