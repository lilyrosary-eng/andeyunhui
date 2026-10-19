// 茑萝 · RAG 知识库子插件（共享后台服务的前端封装 + 主面板 UI）。
//
// 设计要点：
// - manifest：id:"rag"、parent:"niaoluo"、kind:"module"、visible:true（随启动加载，用户可在
//   「全局设置 → 茑萝 → 显示 RAG 知识库模块」里把它从侧栏隐藏，见 HostSidebar 的 ragVisible）。
// - 真正的语义检索由 Rust 后端 rag_query 提供；IDE(<search>/<rag>)、gongfang 等任意插件
//   通过 hostApi.invoke('rag_query', ...) 复用，无需本插件加载。
// - 本插件提供：嵌入抽象层(ApiEmbedder)、摄取管线、检索管线、Prompt 模板，
//   以及主面板 UI（知识库面板：摄取对话框 + 带引用对话）。
//
// ⚠️ 本地 ONNX 嵌入（OnnxEmbedder + embed.worker）已于 2026-10-19 **删除**：
// 它的 tokenizer 是占位实现（按空白分词、把**下标**当 token id），即使把 model.onnx
// 放进 external-deps 也只会产出无意义向量 —— 是个"看起来能用、实际是噪声"的陷阱。
// 要用本地嵌入只能走「LM Studio / Ollama 的 /v1/embeddings」，效果与真 tokenizer 等价且零维护。
//
// ⚠️ 历史缺陷（2026-10-18 修复）：此前 `component` 是一个 `return null` 的占位组件，
// 真正的 UI 挂在 `settings` 字段上——而宿主**从未消费过 PluginDef.settings**（全仓无读取点），
// 于是「茑萝 → RAG 知识库」点进去永远是一片空白。现在 component 直接指向真实面板。
// `settings` 仍然保留：将来宿主若实现「模块设置页」，可零改动复用同一个组件。

const registry = (window as unknown as { __PLUGIN_REGISTRY__: any }).__PLUGIN_REGISTRY__;

import { KnowledgeBasePanel } from './components/KnowledgeBasePanel';
import { RagSidebar } from './components/RagSidebar';
import { ingestDocument } from './ingest/ingest-pipeline';
import { retrieve } from './retrieve/retriever';
import { ApiEmbedder } from './embed/api-embedder';
import { RagPromptBuilder } from './prompt/rag-prompt';
import { ragStore } from './store/rag-store';

// 把库能力挂到 window，方便其他插件（或调试）复用（可选，不影响 rag_query 直连）。
(window as unknown as { __RAG_LIB__?: unknown }).__RAG_LIB__ = {
  ingestDocument,
  retrieve,
  ApiEmbedder,
  RagPromptBuilder,
  ragStore,
};

/** 主模块外壳：与 ModuleSettingsPanel 一致的表面色 / 内缩 / 滚动容器。
 *  宿主外层（App.tsx）只提供 h-full w-full overflow-hidden，内边距与背景由模块自己负责。 */
function RagModule() {
  return (
    <div className="h-full w-full overflow-y-auto main-panel-bg p-6 fade-in immersive-safe-top">
      <div className="max-w-3xl mx-auto min-h-full">
        <KnowledgeBasePanel />
      </div>
    </div>
  );
}

registry.register({
  id: 'rag',
  name: 'RAG 知识库',
  iconName: 'BookOpen',
  kind: 'module',
  visible: false, // 不进一级导航栏；只作为「茑萝」子模块（parent）出现
  component: RagModule,
  sidebar: RagSidebar,
  settings: KnowledgeBasePanel,
  parent: 'niaoluo',
  codename: '茑萝',
  desc: '本地知识库检索增强（RAG）：文档摄取、语义检索、带引用对话',
});
