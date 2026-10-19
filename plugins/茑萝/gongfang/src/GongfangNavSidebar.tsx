/// <reference path="../../../global.d.ts" />
// 茑萝 · 攻防 · 功能块侧栏（2026-10-20 重做）
//
// ## 为什么只有五个功能块
// 上一版这里放的是「内核状态 + 事件流 + 指标曲线 + 目标工作区」—— 但这四样主区域
// （信息台 / 左侧目标工作区）本来就有，等于同一份数据在屏幕上出现两遍，还各自跑一套轮询。
// 现在侧栏只做**导航**：网络爬虫 / 逆向工程 / 渗透测试 / 自动化测试 / API 网关。
// 主区域顶部那排重复的 Tab 同时删掉，入口只剩这一处。
//
// ## 数据从哪来
// 选中项与 features（各框架是否随内核编译）都来自 navStore，由主区域轮询后写入，
// 侧栏只读、不再自己拉 gongfang_status —— 少一套 5 秒轮询，也不会出现两处状态不一致。
import { FRAMEWORK_TABS, setNav, useNav } from './navStore';

export function GongfangNavSidebar() {
  const { tab, features, featureWarn } = useNav();

  return (
    <div className="flex flex-col gap-1 px-2 pt-2">
      <div className="px-3 pb-1 flex items-center gap-2">
        <span className="text-[11px] font-medium tracking-wide text-neutral-400 dark:text-stone-500">功能块</span>
        <span className="flex-1" />
        {featureWarn && (
          <span className="text-[10px] text-amber-600 dark:text-amber-400" title="gongfang_status 拉取失败，无法确认各框架编译能力">
            状态不可用
          </span>
        )}
      </div>

      {FRAMEWORK_TABS.map((f) => {
        // features 还没取到时（null）不拦截：宁可点进去看到后端报错，也不要一开始就置灰
        const enabled = features ? features[f.key] !== false : true;
        const active = tab === f.key;
        return (
          <button
            key={f.key}
            disabled={!enabled}
            onClick={() => setNav({ tab: f.key })}
            title={enabled ? `切换到「${f.label}」（快捷键 ${FRAMEWORK_TABS.indexOf(f) + 1}）` : '该框架未随当前内核编译，需用 --features 重新构建'}
            className={`w-full text-left px-3 py-2.5 rounded-xl transition-colors flex items-center gap-2.5 ${
              !enabled
                ? 'cursor-not-allowed opacity-50 text-neutral-400 dark:text-stone-500'
                : active
                  ? 'bg-[var(--element-bg)]/10 text-[var(--element-color-raw)]'
                  : 'hover:bg-black/5 dark:hover:bg-white/5 text-neutral-600 dark:text-stone-400'
            }`}
          >
            <span className={active ? 'text-[var(--element-color-raw)]' : 'text-neutral-400 dark:text-stone-500'}>{f.icon}</span>
            <span className="text-sm font-medium flex-1">{f.label}</span>
            {features !== null && (
              <span
                className={`text-[10px] px-1.5 py-0.5 rounded ${
                  enabled
                    ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                    : 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                }`}
              >
                {enabled ? '就绪' : '未编译'}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
