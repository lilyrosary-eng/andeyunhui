// MiniSearch 外部依赖入口：打包为 IIFE，挂载到 window.__EXT_MINISEARCH__
// 供 IDE 子插件做项目级全文检索（RAG 主题 9），减少 agent <read> 次数。
// 构建脚本（scripts/build-external-deps.mjs）会将本入口打成
// external-deps/茑萝/ide/minisearch/index.js，由 IDE 运行时 read_external_dep_file + new Function 加载。
// MiniSearch：MIT 协议，纯 JS 倒排索引 + 模糊匹配 + 前缀搜索，~10KB gzip。
import MiniSearch from 'minisearch';

window.__EXT_MINISEARCH__ = { MiniSearch };
