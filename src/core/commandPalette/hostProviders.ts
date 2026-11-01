// 宿主内置模块的命令面板 provider
//
// 插件模块通过沙箱 API 自行注册；笔记/中转站等宿主内置模块在这里接入。
// 与业务模块一致：搜索结果只声明「目标」，执行交给统一导航契约。
import { api } from '@/lib/api';
import { makeScorer } from '@/lib/fuzzy';
import { registerCommandProvider } from '@/core/commandPalette/registry';
import type { PaletteProviderResult } from '@/core/commandPalette/registry';

const TRANSFER_TTL_MS = 10_000;
let transferFiles: Awaited<ReturnType<typeof api.listDropzoneFiles>> = [];
let transferFetchedAt = 0;
let transferPromise: Promise<void> | null = null;

async function ensureTransferSnapshot(force = false): Promise<void> {
  if (!force && transferFetchedAt > 0 && Date.now() - transferFetchedAt < TRANSFER_TTL_MS) return;
  if (transferPromise) return transferPromise;
  transferPromise = (async () => {
    try {
      transferFiles = await api.listDropzoneFiles();
      transferFetchedAt = Date.now();
    } catch (err) {
      console.warn('[command-palette] 中转站索引读取失败:', err);
    }
  })().finally(() => { transferPromise = null; });
  return transferPromise;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

let cleanup: (() => void) | null = null;

/** 幂等注册宿主内置 provider；返回注销函数（测试/热重载用）。 */
export function initHostCommandProviders(): () => void {
  if (cleanup) return cleanup;
  const unregister = registerCommandProvider({
    id: 'host:transfer',
    label: '中转站',
    moduleId: 'transfer',
    priority: 40,
    refresh: () => ensureTransferSnapshot(),
    search: async (query) => {
      const q = query.trim().toLowerCase();
      if (!q) return [];
      await ensureTransferSnapshot();
      const out: PaletteProviderResult[] = [];
      // 按分取最好的 40 条，而不是遍历顺序里前 40 个命中；文件名命中压过「名+扩展名」命中。
      const score = makeScorer(query);
      const ranked = transferFiles
        .map((file) => {
          const titleScore = score(file.originalName);
          const hayScore = score(`${file.originalName} ${file.extension ?? ''}`.toLowerCase());
          return { file, titleHit: titleScore > 150, s: Math.max(titleScore, hayScore * 0.6) };
        })
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, 40);
      for (const { file, titleHit } of ranked) {
        out.push({
          id: file.storedPath,
          title: file.originalName,
          subtitle: [file.extension?.toUpperCase(), formatSize(file.size)].filter(Boolean).join(' · '),
          path: ['文件'],
          iconName: 'Inbox',
          rank: titleHit ? 8 : 0,
          navigate: { module: 'transfer', tabs: ['文件'], entity: file.storedPath, props: { storedPath: file.storedPath } },
          run: () => { window.dispatchEvent(new CustomEvent('andy:transfer-focus', { detail: { storedPath: file.storedPath } })); },
        });
      }
      return out;
    },
  });
  cleanup = () => {
    unregister();
    cleanup = null;
  };
  return cleanup;
}
