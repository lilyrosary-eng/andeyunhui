/* ============================================================================
 * SMTC 实时探针 —— 粘贴到主窗口 DevTools Console (F12) 运行
 * ----------------------------------------------------------------------------
 * 用途：绕过 Rust 终端噪声与可能被吞的日志，直接从【运行中的进程】读取
 *       系统媒体会话 / 任务栏 AUMID 的源头数据，定位"未知应用 / com."问题。
 * 环境：需要 window.__HOST_API__（主窗口已注入，含 invoke / listen）。
 *       在插件浮窗的 DevTools 里跑不到主窗口的 __HOST_API__，请用主窗口的。
 * ==========================================================================*/
(async () => {
  const api = window.__HOST_API__;
  if (!api || typeof api.invoke !== 'function') {
    console.error('[SMTC探针] 未找到 window.__HOST_API__.invoke —— 请确认在主窗口(非插件浮窗)的 DevTools 中运行。');
    return;
  }
  const log = (...a) => console.log('%c[SMTC探针]', 'color:#0a8f3c;font-weight:bold', ...a);
  const warn = (...a) => console.warn('%c[SMTC探针]', 'color:#c47f00;font-weight:bold', ...a);

  async function status() {
    try { return await api.invoke('smtc_status'); }
    catch (e) { warn('smtc_status 调用失败:', e); return null; }
  }

  // 1) 立即打印一次完整快照
  const s0 = await status();
  if (s0) {
    log('当前状态完整快照:');
    console.log(JSON.stringify(s0, null, 2));
    log('—— 关键字段解读 ——');
    log('窗口AUMID属性已写入(window_aumid_set):', s0.window_aumid_set);
    log('顶层窗口AUMID属性读回(actual_top_aumid):', s0.actual_top_aumid);
    log('进程级AUMID回读(process_aumid):', s0.process_aumid, '（空=SetCurrentProcessExplicitAppUserModelID 未生效）');
    log('注册表DisplayName(reg_displayname):', s0.reg_displayname);
    log('SMTC会话已创建(session_created):', s0.session_created);
    log('当前激活模块(active_module):', s0.active_module);
    log('会话实际 IsEnabled(is_enabled):', s0.is_enabled, '（false=任务栏不会出现媒体控件）');
    log('会话实际 PlaybackStatus(playback_status):', s0.playback_status, '（Playing/Paused 才会出现卡片）');
    log('播放状态(last_status_playing):', s0.last_status_playing);
    log('上次音乐标题:', s0.last_music_title, '| 上次视频标题:', s0.last_video_title);

    if (!s0.process_aumid) {
      warn('【结论·关键】进程级 AUMID 未生效！窗口不会继承 AUMID，媒体卡片按进程 AUMID 解析必然落到「未知应用」。这是「未知应用」的真因。');
    } else if (!s0.session_created) {
      warn('【结论】SMTC 会话未创建 → init() 在 setup() 阶段未拿到主窗口 HWND 而提前返回。');
    } else if (!s0.window_aumid_set) {
      warn('【结论】窗口 AUMID 属性未写入 → set_window_aumid 失败。');
    } else if (!s0.reg_displayname) {
      warn('【结论】注册表 DisplayName 为空 → ensure_app_identity 注册表写入未生效（或被旧二进制运行）。');
    } else if (s0.is_enabled === false || s0.playback_status === 'Stopped' || !s0.playback_status) {
      warn('【结论·关键】会话被禁用/处于 Stopped，任务栏不会显示任何媒体卡片。这说明前台从未成功推送 smtc_update（smtc_update 未送达 Rust，或你还没真正播放）。请在音乐模块播放一首，看浏览器控制台是否出现绿字「[SMTC] push OK」；若出现红字「[SMTC] push FAIL」即推送失败，把报错贴出。');
    } else if (s0.is_enabled === true && (s0.playback_status === 'Playing' || s0.playback_status === 'Paused')) {
      log('【结论】会话已启用且处于 ' + s0.playback_status + '，任务栏理应显示「岸灯鸢花」媒体卡片。若仍空白 → 属 Windows 任务栏/Shell 显示缓存，重启 explorer（任务管理器结束 Windows 资源管理器后重新运行）即可。');
    } else {
      log('【结论】窗口/进程 AUMID 与注册表 DisplayName 均齐全，状态见上。');
    }
  }

  // 2) 实时订阅系统媒体键（Rust emit 的 smtc-control 事件）
  let unlisten = null;
  if (typeof api.listen === 'function') {
    try {
      unlisten = await api.listen('smtc-control', (e) => {
        log('收到系统媒体键:', e && e.payload);
      });
      log('已订阅 smtc-control（在任务栏/键盘按播放·上一首·下一首即在此实时打印）。');
    } catch (err) { warn('订阅 smtc-control 失败:', err); }
  } else {
    warn('window.__HOST_API__.listen 不可用，跳过实时媒体键订阅（仅轮询状态）。');
  }

  // 3) 轮询：仅在状态变化时打印，便于观察标题/模块/播放状态变化
  let last = '';
  const timer = setInterval(async () => {
    const s = await status();
    if (!s) return;
    const key = JSON.stringify(s);
    if (key !== last) {
      last = key;
      log('状态变化:', s);
    }
  }, 1500);

  log('探针运行中。手动查看: SMTC_NOW() ；停止: SMTC_STOP()');
  window.SMTC_NOW = status;
  window.SMTC_STOP = () => {
    clearInterval(timer);
    if (unlisten) { try { unlisten(); } catch (_) {} }
    log('已停止。');
  };
})();
