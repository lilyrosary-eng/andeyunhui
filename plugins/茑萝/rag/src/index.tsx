// 茑萝 · RAG 知识库子插件（共享后台服务的前端封装 + 设置页 UI）。
//
// 设计要点（用户敲定）：
// - manifest 设为 visible:false、parent:"茑萝"(niaoluo)、id:"rag"、kind:"module"，
//   不显示在主界面，像「录屏」插件一样后台被调用，UI 仅「设置中可见」。
// - 真正的语义检索由 Rust 后端 rag_query 提供；IDE(<search>/<rag>)、gongfang 等任意插件
//   通过 hostApi.invoke('rag_query', ...) 复用，无需本插件加载。
// - 本插件提供：嵌入抽象层(ApiEmbedder/OnnxEmbedder)、摄取管线、检索管线、Prompt 模板、
//   以及设置页 UI（知识库面板：摄取对话框 + 带引用对话）。
//
// visible:false 时 PluginHost 不会自动加载本脚本；用户在「拓展管理」中启用后，
// 下面的 register 调用会注册 settings 组件，设置页即可挂载。

const registry = (window as unknown as { __PLUGIN_REGISTRY__: any }).__PLUGIN_REGISTRY__;

import { KnowledgeBasePanel } from './components/KnowledgeBasePanel';
import { ingestDocument } from './ingest/ingest-pipeline';
import { retrieve } from './retrieve/retriever';
import { ApiEmbedder } from './embed/api-embedder';
import { OnnxEmbedder } from './embed/onnx-embedder';
import { RagPromptBuilder } from './prompt/rag-prompt';
import { ragStore } from './store/rag-store';

// 把库能力挂到 window，方便其他插件（或调试）复用（可选，不影响 rag_query 直连）。
(window as unknown as { __RAG_LIB__?: unknown }).__RAG_LIB__ = {
  ingestDocument,
  retrieve,
  ApiEmbedder,
  OnnxEmbedder,
  RagPromptBuilder,
  ragStore,
};

// 占位主组件（visible:false，不进导航栏）。
function RagPlaceholder(): null {
  return null;
}

registry.register({
  id: 'rag',
  name: 'RAG 知识库',
  iconName: 'BookOpen',
  kind: 'module',
  visible: false,
  component: RagPlaceholder,
  sidebar: undefined,
  settings: KnowledgeBasePanel,
  parent: 'niaoluo',
  codename: '茑萝',
  desc: '本地知识库检索增强（RAG）：文档摄取、语义检索、带引用对话',
});
