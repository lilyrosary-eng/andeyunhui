/// <reference path="../../../global.d.ts" />
// 攻防模块 · 首次进入风险确认 + 免责声明
// 职责：用户首次进入攻防子模块时强制展示免责声明，须明确同意方可使用。
// 存储：localStorage 记录同意时间戳，后续进入不再弹窗（可通过"重新阅读"再次调起）。
// 约束：未同意前不渲染任何攻防功能，确保合规。
const React = window.__HOST_REACT__;
const { useState } = React;

const ACCEPTED_KEY = 'gongfang.disclaimer.accepted';

/** 是否已同意免责声明 */
export function isDisclaimerAccepted(): boolean {
  try {
    return !!localStorage.getItem(ACCEPTED_KEY);
  } catch {
    return false;
  }
}

/** 撤销同意（用于"重新阅读声明"） */
export function revokeDisclaimer(): void {
  try {
    localStorage.removeItem(ACCEPTED_KEY);
  } catch {
    // ignore
  }
}

// ============ 风险确认全屏弹窗 ============
export function RiskConfirm({ onAgree }: { onAgree: () => void }) {
  const [checked, setChecked] = useState(false);

  const handleAgree = () => {
    if (!checked) return;
    try {
      localStorage.setItem(ACCEPTED_KEY, String(Date.now()));
    } catch {
      // ignore
    }
    onAgree();
  };

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-[#f5f5f0] dark:bg-[#1c1917] p-6">
      <div className="w-full max-w-2xl bg-white dark:bg-[#252220] rounded-2xl shadow-2xl border border-black/5 dark:border-stone-700/60 overflow-hidden">
        {/* 标题栏 */}
        <div className="flex items-center gap-2.5 px-6 py-4 border-b border-black/5 dark:border-stone-700/60 bg-rose-500/5">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-rose-500">
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <span className="text-base font-semibold text-[var(--element-bg)]">攻防模块 · 免责声明与使用须知</span>
        </div>

        {/* 声明正文 */}
        <div className="px-6 py-5 space-y-3 text-sm text-neutral-600 dark:text-stone-300 max-h-[50vh] overflow-y-auto">
          <p className="text-[var(--element-bg)] font-medium">使用前请务必阅读以下条款：</p>

          <ol className="space-y-2 list-decimal list-inside text-[13px] leading-relaxed">
            <li><span className="text-[var(--element-bg)]">合法性承诺</span>：本模块仅可用于<span className="text-rose-500 font-medium">已获授权的安全测试、攻防演练、CTF 竞赛及自有资产的安全评估</span>。严禁用于任何未授权的攻击、入侵或破坏他人系统。</li>
            <li><span className="text-[var(--element-bg)]">用户责任</span>：使用者须确保具备合法授权（书面授权/演练授权/自有资产），并遵守所在地区法律法规。因违规使用产生的一切法律后果由使用者自行承担。</li>
            <li><span className="text-[var(--element-bg)]">功能定位</span>：本模块为<span className="text-amber-600 dark:text-amber-400 font-medium">防御性研究与教学</span>设计，旨在帮助理解攻击手法以提升防御能力，非为非法目的提供工具。</li>
            <li><span className="text-[var(--element-bg)]">审计留痕</span>：本模块所有操作将记录本地审计日志（动作/目标/状态，不含敏感明文），便于事后追溯。</li>
            <li><span className="text-[var(--element-bg)]">免责</span>：本软件作者与分发方不对任何因滥用本模块造成的损失负责。使用即视为已理解并接受全部条款。</li>
          </ol>

          <div className="mt-4 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-[12px] text-amber-700 dark:text-amber-400">
            <span className="font-medium">提示</span>：当前为骨架占位阶段，各框架功能将逐步开放。操作审计日志已启用，可在顶部状态栏查看。
          </div>
        </div>

        {/* 同意勾选 + 按钮 */}
        <div className="px-6 py-4 border-t border-black/5 dark:border-stone-700/60 bg-black/[0.02] dark:bg-white/[0.02]">
          <label className="flex items-center gap-2 mb-3 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
              className="w-4 h-4 rounded accent-rose-500"
            />
            <span className="text-[13px] text-neutral-600 dark:text-stone-300">
              我已阅读并理解上述全部条款，承诺仅用于合法授权用途
            </span>
          </label>
          <div className="flex justify-end gap-2">
            <button
              onClick={handleAgree}
              disabled={!checked}
              className={`btn-press px-5 py-2 rounded-lg text-sm font-medium transition-all ${
                checked
                  ? 'bg-rose-500 text-white hover:bg-rose-600'
                  : 'bg-neutral-300 dark:bg-stone-700 text-neutral-500 dark:text-stone-500 cursor-not-allowed'
              }`}
            >
              同意并进入
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
