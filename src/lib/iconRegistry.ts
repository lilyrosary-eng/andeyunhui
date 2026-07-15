import {
  Music2, Image, Video, BookOpen, Briefcase, FileText, Toolbox,
  Images, FileType, Film, AudioLines, Regex, Diff, Braces, Binary, Link, Table, Hash, KeyRound, Network, Cpu, Variable, Clipboard,
  Repeat, Type, ChartColumn, SlidersHorizontal, Paintbrush, Code, FolderOpen, Bot, Sparkles,
  // 播放器图标
  Play, Pause, SkipBack, SkipForward, Volume2, VolumeX, List, ListMusic, Shuffle, Repeat1, Music, Mic2, Lock, Unlock,
  Maximize, Minimize, ArrowLeft, ChevronLeft, ChevronRight, Search, Plus, Check, MoreHorizontal, File, RefreshCw,
  type LucideIcon,
} from 'lucide-react';

// 插件图标名 → lucide 组件映射表（新增插件时在此追加）
const iconMap: Record<string, LucideIcon> = {
  // 既有模块图标（模块注册 iconName 用）
  Music2,
  Image,
  Video,
  BookOpen,
  Briefcase,
  FileText,
  Toolbox,
  // 专业模块「薄荷」分类大标题图标
  Repeat,
  Type,
  ChartColumn,
  SlidersHorizontal,
  // 专业模块「薄荷」子功能图标（供插件通过 __HOST_UI__.Icon 按名渲染）
  Images,
  FileType,
  Film,
  AudioLines,
  Regex,
  Diff,
  Braces,
  Binary,
  Link,
  Table,
  Hash,
  KeyRound,
  Network,
  Cpu,
  Variable,
  Clipboard,
  // 茑萝子模块
  Paintbrush,
  Code,
  FolderOpen,
  Bot,
  Sparkles,
  // 播放器通用图标
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  List,
  ListMusic,
  Shuffle,
  Repeat1,
  Music,
  Mic2,
  Lock,
  Unlock,
  Maximize,
  Minimize,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Search,
  Plus,
  Check,
  MoreHorizontal,
  File,
  RefreshCw,
};

/** 根据插件声明的 iconName 获取对应的 lucide 图标组件，找不到返回 null */
export function getIcon(name: string): LucideIcon | null {
  return iconMap[name] || null;
}