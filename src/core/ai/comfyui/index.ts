/**
 * ComfyUI 工作流移植层（源自 dsh-comfyui，MIT，见同目录 LICENSE-dsh-comfyui）。
 * 三个纯函数模块：graph（链接归一化/虚拟节点消解）、convert（UI 图→API 工作流）、
 * params（参数快照/应用）。均不依赖 ComfyUI 在线、不依赖 Tauri，可单测、可在 WebView 前端跑。
 */
export { normalizeLink, normalizeLinks, resolveVirtualLinks, isVirtualNodeType, SET_NODE, GET_NODE } from './graph'
export type { GraphLink } from './graph'
export { convertGraphToApi, flattenDynamicCombos } from './convert'
export type { ApiWorkflow, ConvertResult } from './convert'
export {
  analyzeWorkflowParameters,
  applyWorkflowParameters,
  refreshParameterMetadata,
  numberSpecOf,
  inputOptions,
  comboChildInfo,
  uploadKindOf,
} from './params'
export type { Workflow, WorkflowParameter } from './params'
export { detectWorkflow } from './format'
