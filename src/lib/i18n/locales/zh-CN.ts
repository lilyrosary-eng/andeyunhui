// 简体中文（源语言，所有 key 的基准）
export const zhCN: Record<string, string> = {
  // 通用
  'common.loading': '加载中...',
  'common.confirm': '确定',
  'common.cancel': '取消',
  'common.open': '打开',
  'common.close': '关闭',
  'common.delete': '删除',
  'common.restore': '恢复',

  // 标题栏
  'titlebar.minimize': '最小化',
  'titlebar.maximize': '最大化',
  'titlebar.close': '关闭',

  // 主导航
  'nav.notes': '安得云荟',
  'nav.extensions': '茑萝',
  'nav.transfer': '中转站',
  'nav.settings': '设置',

  // 侧边栏
  'sidebar.niaoluo': '茑萝',
  'sidebar.searchExt': '搜索拓展...',
  'sidebar.noExtInstalled': '暂无已安装的拓展',
  'sidebar.noExtMatch': '未找到匹配的拓展',
  'sidebar.backToList': '返回拓展列表',
  'sidebar.manageExtSettings': '管理拓展设置',
  'sidebar.moduleSettings': '模块设置',
  'sidebar.back': '返回',

  // 设置 - 标签页
  'settings.tab.general': '常规',
  'settings.tab.themes': '主题',
  'settings.tab.extensions': '茑萝',
  'settings.tab.transfer': '中转',
  'settings.tab.model': '模型',
  'settings.tab.blacklist': '黑名单',
  'settings.tab.about': '关于',

  // 设置 - 常规 - 缩放
  'settings.general.zoom.title': '缩放',
  'settings.general.zoom.level': 'UI 缩放级别',

  // 设置 - 常规 - 语言
  'settings.general.language.title': '语言',
  'settings.general.language.label': '界面语言',
  'settings.general.language.desc': '选择应用界面显示的语言，切换后立即生效',

  // 设置 - 常规 - 快捷键
  'settings.general.shortcuts.title': '快捷键配置',
  'settings.general.shortcuts.resetDefault': '恢复默认',
  'settings.general.shortcuts.pressKey': '请按键...',
  'settings.general.shortcuts.editTip': '点击修改快捷键',

  // 快捷键项
  'shortcut.bold': '加粗',
  'shortcut.italic': '斜体',
  'shortcut.link': '链接',
  'shortcut.screenshot': '全局截图',
  'shortcut.recorder': '全局录屏',
  'shortcut.clipboard': '剪贴板浮窗',
  'shortcut.dropzone': '中转站浮窗',

  // 设置 - 常规 - 通用
  'settings.general.common.title': '通用',
  'settings.general.tray.title': '最小化回托盘',
  'settings.general.tray.desc': '关闭窗口时隐藏到系统托盘，而非退出程序',
  'settings.general.autosave.title': '自动保存',
  'settings.general.autosave.desc': '检测到更改后自动备份原文件并保存到中转站',
  'settings.general.autosave.interval': '保存间隔（秒）',

  // 设置 - 主题
  'settings.themes.appearance': '外观',
  'settings.theme.system': '跟随系统',
  'settings.theme.light': '浅色',
  'settings.theme.dark': '深色',
  'settings.themes.nativeConfig': '原生主题配置',
  'settings.themes.themeColor': '主题配色',
  'settings.themes.elementColor': '元素配色',
  'settings.themes.followSystem': '跟随系统',
  'settings.themes.cn': '中',
  'settings.themes.packConfig': '主题包配置',
  'settings.themes.selectPack': '选择主题包',
  'settings.themes.reverseColor': '反转元素配色',
  'settings.themes.customBg': '自定义背景图',
  'settings.themes.selectImage': '选择图片',
  'settings.themes.display': '显示设置',
  'settings.themes.bodyFont': '正文字体',
  'settings.themes.searchFont': '搜索字体...',
  'settings.themes.systemDefault': '系统默认',
  'settings.themes.detectingFonts': '正在检测系统字体...',
  'settings.themes.noFont': '无匹配字体',
  'settings.themes.panelOpacity': '面板透明度',

  // 配色名
  'color.default': '默认',
  'color.green': '经典绿',
  'color.blue': '经典蓝',
  'color.purple': '紫色',
  'color.orange': '橙色',

  // 设置 - 中转
  'settings.transfer.archiveTitle': '存档（笔记 / 文件 / 图片）',
  'settings.transfer.archiveDesc': '任何内容变动都会在此留下快照，可随时恢复',
  'settings.transfer.noArchive': '暂无存档',
  'settings.transfer.noArchiveDesc': '编辑或导入内容后会自动生成快照',
  'settings.transfer.snapshotCount': '共 {count} 个快照',
  'settings.transfer.clearArchive': '清空存档',
  'settings.transfer.confirmClear': '确定清空所有存档快照？此操作不可恢复。',
  'settings.transfer.restore': '恢复',
  'settings.transfer.delete': '删除',
  'settings.transfer.restored': '已恢复：{name}',
  'settings.transfer.restoreFailed': '恢复失败：{err}',
  'settings.transfer.confirmDelete': '确定删除存档「{name}」？',

  // 存档类型
  'kind.note': '笔记',
  'kind.image': '图片',
  'kind.file': '文件',

  // 设置 - 关于
  'settings.about.title': '关于软件',
  'settings.about.version': '版本: {v}',
  'settings.about.author': '作者: Rosary · 感谢你的使用',
  'settings.about.previewBoot': '预览加载界面',
  'settings.about.previewDesc': '选择主题即可全屏预览加载动画',
  'settings.about.githubRelease': '前往 GitHub 发布页',
  'settings.about.checkUpdate': '检查更新',
  'settings.about.officialRelease': '前往安得云荟发布页',
  'settings.about.open': '打开',
  'settings.about.dataBackup': '数据备份',
  'settings.about.exportBackup': '导出备份',
  'settings.about.backupName': '备份',
  'settings.about.exportSuccess': '备份导出成功！',
  'settings.about.exportFailed': '导出失败，请重试',
  'settings.about.errorLog': '报错日志',
  'settings.about.errorLogDesc': '打开日志文件夹，可直接提交 log 文件给开发者排查问题',
  'settings.about.openFolder': '打开文件夹',
};
