// AI 对话模块下的子模块注册表（桌面版）。
// 四个子模块分层：chat(基础对话) → work(AI 办公·成果物层) → workflow(AI 工作流·蓝图编排) → collab(AI 协作·多 harness)。
// 定义统一供「切换抽屉」与各子模块占位/主区复用，胶囊浮岛不接入，保持现状 ai 对话。
import type { ReactNode } from 'react';
import { MessageSquare, Briefcase, Network, Workflow } from 'lucide-react';

export type AISubmoduleId = 'chat' | 'work' | 'workflow' | 'collab';

/** 抽屉中每个子模块项的配色（对齐音乐模块 ModuleDrawer 的 accent 结构） */
export interface AISubmoduleAccent {
  text: string;
  textDark: string;
  bgSoft: string;
  bgSoftDark: string;
  bgActive: string;
  bgActiveDark: string;
  borderActive: string;
  borderActiveDark: string;
  check: string;
}

export interface AISubmoduleDef {
  id: AISubmoduleId;
  name: string;
  desc: string;
  icon: ReactNode;
  accent: AISubmoduleAccent;
}

export const AI_SUBMODULES: AISubmoduleDef[] = [
  {
    id: 'chat',
    name: 'AI 对话',
    desc: '多会话连续对话，附思考 / 联网 / 文件导入',
    icon: <MessageSquare size={20} />,
    accent: {
      text: 'text-sky-600', textDark: 'dark:text-sky-400',
      bgSoft: 'bg-sky-500/10', bgSoftDark: 'dark:bg-sky-500/10',
      bgActive: 'bg-sky-50', bgActiveDark: 'dark:bg-sky-900/30',
      borderActive: 'border-sky-500/50', borderActiveDark: 'dark:border-sky-500/40',
      check: 'bg-sky-500',
    },
  },
  {
    id: 'work',
    name: 'AI 办公',
    desc: '聊完落地产出物：文档 / 表格 / 总结 → 存入笔记',
    icon: <Briefcase size={20} />,
    accent: {
      text: 'text-emerald-600', textDark: 'dark:text-emerald-400',
      bgSoft: 'bg-emerald-500/10', bgSoftDark: 'dark:bg-emerald-500/10',
      bgActive: 'bg-emerald-50', bgActiveDark: 'dark:bg-emerald-900/30',
      borderActive: 'border-emerald-500/50', borderActiveDark: 'dark:border-emerald-500/40',
      check: 'bg-emerald-500',
    },
  },
  {
    id: 'workflow',
    name: 'AI 工作流',
    desc: '对话驱动蓝图节点，逐步执行、专业可控（专业版）',
    icon: <Workflow size={20} />,
    accent: {
      text: 'text-violet-600', textDark: 'dark:text-violet-400',
      bgSoft: 'bg-violet-500/10', bgSoftDark: 'dark:bg-violet-500/10',
      bgActive: 'bg-violet-50', bgActiveDark: 'dark:bg-violet-900/30',
      borderActive: 'border-violet-500/50', borderActiveDark: 'dark:border-violet-500/40',
      check: 'bg-violet-500',
    },
  },
  {
    id: 'collab',
    name: 'AI 协作',
    desc: '多 harness agent 房间：任务分派、结果回传、统一管理',
    icon: <Network size={20} />,
    accent: {
      text: 'text-indigo-600', textDark: 'dark:text-indigo-400',
      bgSoft: 'bg-indigo-500/10', bgSoftDark: 'dark:bg-indigo-500/10',
      bgActive: 'bg-indigo-50', bgActiveDark: 'dark:bg-indigo-900/30',
      borderActive: 'border-indigo-500/50', borderActiveDark: 'dark:border-indigo-500/40',
      check: 'bg-indigo-500',
    },
  },
];

export const SUBMODULE_STORAGE_KEY = 'andeyunhui.aichat.submodule';

export function submoduleById(id: string | null | undefined): AISubmoduleDef {
  return AI_SUBMODULES.find((s) => s.id === id) ?? AI_SUBMODULES[0];
}