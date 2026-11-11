/// <reference path="../../../global.d.ts" />
// 茑萝 · 凌霄（下载中心）子插件入口。
//
// 注册要点：
// - manifest.visible = true：随启动加载，保证子插件在父模块打开前就完成注册；
// - registry.visible = false：不进顶部图标栏，只出现在「茑萝」侧栏（命令面板仍可检索）；
// - parent = 'niaoluo'：归入茑萝，命令面板按子模块展示「凌霄 · 下载中心」。

import { HomeportModule } from './HomeportModule';
import { dl, formatBytes, STATUS_LABEL } from './api';

window.__PLUGIN_REGISTRY__.register({
  id: 'homeport',
  name: '下载中心',
  displayName: '凌霄',
  displayTooltip: '凌霄 · 多引擎下载中心',
  iconName: 'Download',
  kind: 'module',
  visible: false,
  parent: 'niaoluo',
  category: '传输',
  desc: '多引擎下载：HTTP / HLS / BT / 磁力 / ed2k，分片续传、限速、代理、镜像与 SHA-256 校验',
  component: HomeportModule,
});

// 命令面板：把已有任务也纳入检索（文件名 / 保存路径 / 状态）。
try {
  window.__HOST_API__?.registerCommandProvider?.({
    id: 'homeport',
    label: '凌霄',
    moduleId: 'homeport',
    priority: 12,
    search: async (query) => {
      const q = query.trim();
      if (!q) return [];
      const scorer = window.__HOST_API__.makeScorer?.(q);
      const tasks = await dl.list(null, 120);
      return tasks
        .map((task) => {
          const haystack = `${task.filename} ${task.savePath} ${STATUS_LABEL[task.status]}`;
          const score = scorer
            ? scorer(haystack)
            : haystack.toLowerCase().includes(q.toLowerCase())
              ? 1
              : -1;
          return { task, score };
        })
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 12)
        .map(({ task }) => ({
          id: `homeport:${task.id}`,
          title: task.filename,
          subtitle: `${STATUS_LABEL[task.status]} · ${formatBytes(task.downloadedBytes)}${
            task.totalBytes > 0 ? ` / ${formatBytes(task.totalBytes)}` : ''
          }`,
          path: ['凌霄', '下载中心'],
          iconName: 'Download',
          rank: 10,
          navigate: { module: 'homeport' },
        }));
    },
  });
} catch (error) {
  console.warn('[homeport] 命令面板注册失败', error);
}
