import { useState, useEffect, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import {
  Terminal,
  Send,
  Trash2,
  ChevronUp,
  ChevronDown,
} from 'lucide-react';

// ========== 类型 ==========
type OutputKind = 'in' | 'out' | 'err' | 'sys';

interface OutputLine {
  kind: OutputKind;
  text: string;
  time: string;
}

interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

interface LogFileInfo {
  name: string;
  path: string;
  size: number;
  modified: string;
}

// ========== 开发者控制台：开发调试工具，不设命令白名单/黑名单限制 ==========
const COMMAND_NAMES = [
  'help', 'clear', 'echo', 'pwd', 'ls',
  'logs', 'log', 'backup', 'install', 'refresh', 'reload', 'http',
];

// ========== 帮助文本 ==========
const HELP_TEXT = `开发者控制台 · 热指令列表
==============================
:help                          显示此帮助
:clear                         清屏
:echo <text>                  原样回显文本
:pwd                          显示当前应用数据目录（基于日志路径推导）
:ls <path>                    列出指定目录内容
:logs                         列出会话日志文件
:log <name>                  读取指定日志内容（如 :log session_20250101_120000.log）
:backup                       导出数据备份（弹出保存对话框）
:install                      安装 .mufurong / .mujin 文件（弹出文件选择）
:refresh                      刷新插件列表（重新扫描 user_plugins / user_external_deps）
:reload <plugin_id>          热重载插件
:http <METHOD> <url> [body]  HTTP 联网（METHOD = GET/POST/PUT/DELETE）

说明：
- 历史记录通过 ↑/↓ 切换，Ctrl+L 清屏，Tab 自动补全命令名`;

// ========== 组件 ==========
export function DevConsole() {
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem('dev_console_history');
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  });
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [outputs, setOutputs] = useState<OutputLine[]>([
    {
      kind: 'sys',
      text: '开发者控制台已就绪 · 输入 :help 查看可用指令',
      time: nowStr(),
    },
  ]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // 持久化历史
  useEffect(() => {
    localStorage.setItem('dev_console_history', JSON.stringify(history.slice(-50)));
  }, [history]);

  // 自动滚动到底部
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [outputs]);

  const pushOutput = useCallback((kind: OutputKind, text: string) => {
    setOutputs(prev => [...prev, { kind, text, time: nowStr() }]);
  }, []);

  function nowStr(): string {
    const d = new Date();
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  // ========== 命令执行器 ==========
  const execute = useCallback(async (raw: string) => {
    const cmd = raw.trim();
    if (!cmd) return;

    // 加入历史
    setHistory(prev => [...prev, cmd].slice(-50));
    setHistoryIdx(-1);
    pushOutput('in', cmd);

    // 非 `:` 开头视为非法命令
    if (!cmd.startsWith(':')) {
      pushOutput('err', `✗ 未知指令：${cmd}（所有指令需以 : 开头，输入 :help 查看）`);
      return;
    }

    // 解析命令名与参数
    const parts = cmd.slice(1).split(/\s+/);
    const name = parts[0].toLowerCase();
    const args = parts.slice(1);

    try {
      switch (name) {
        case 'help':
          pushOutput('out', HELP_TEXT);
          break;

        case 'clear':
          setOutputs([]);
          break;

        case 'echo':
          pushOutput('out', args.join(' '));
          break;

        case 'pwd': {
          // 通过当前日志路径推导 app_data 目录
          const logPath = await invoke<string | null>('get_current_log_path');
          if (!logPath) {
            pushOutput('err', '无法获取应用数据目录（日志未初始化）');
          } else {
            // logPath = app_data/logs/session_xxx.log → 推导 app_data
            const match = /[\\/]logs[\\/]/.exec(logPath);
            const appData = match ? logPath.slice(0, match.index) : logPath;
            pushOutput('out', `应用数据目录: ${appData}\n日志路径: ${logPath}`);
          }
          break;
        }

        case 'ls': {
          if (!args[0]) {
            pushOutput('err', '用法: :ls <path>（路径不能为空）');
            break;
          }
          const entries = await invoke<DirEntry[]>('list_directory', { path: args[0] });
          if (entries.length === 0) {
            pushOutput('out', '(空目录)');
          } else {
            const lines = entries.map(
              e => `${e.is_dir ? '[DIR] ' : '      '}${e.name}`
            );
            pushOutput('out', lines.join('\n'));
          }
          break;
        }

        case 'logs': {
          const files = await invoke<LogFileInfo[]>('get_log_files');
          if (files.length === 0) {
            pushOutput('out', '(无会话日志)');
          } else {
            const lines = files.map(
              f => `${f.name}  ${(f.size / 1024).toFixed(1)}KB  ${f.modified}`
            );
            pushOutput('out', `会话日志（最新在前）：\n${lines.join('\n')}`);
          }
          break;
        }

        case 'log': {
          if (!args[0]) {
            pushOutput('err', '用法: :log <日志文件名>（如 session_20250101_120000.log）');
            break;
          }
          // 日志文件位于 app_data/logs/<name>，从当前日志路径推导
          const currentLog = await invoke<string | null>('get_current_log_path');
          if (!currentLog) {
            pushOutput('err', '无法获取日志目录');
            break;
          }
          const logDir = currentLog.replace(/[^\\/]+\.log$/i, '');
          const logPath = logDir + args[0];
          const content = await invoke<string>('read_text_file', { path: logPath });
          // 截断超长日志
          pushOutput('out', content.length > 8000 ? content.slice(0, 8000) + '\n... (已截断，仅显示前 8000 字符)' : content);
          break;
        }

        case 'backup': {
          const { save } = await import('@tauri-apps/plugin-dialog');
          const path = await save({
            defaultPath: 'notes_backup.zip',
            filters: [{ name: '备份', extensions: ['zip'] }],
          });
          if (path) {
            await invoke('export_backup', { path });
            pushOutput('out', `✓ 已导出备份到: ${path}`);
          } else {
            pushOutput('sys', '(用户取消保存)');
          }
          break;
        }

        case 'install': {
          const filePath = await openDialog({
            multiple: false,
            filters: [
              {
                name: '插件/依赖包',
                extensions: ['mufurong', 'mujin'],
              },
            ],
          });
          if (!filePath || typeof filePath !== 'string') {
            pushOutput('sys', '(用户取消选择)');
            break;
          }
          await installPackage(filePath);
          break;
        }

        case 'refresh': {
          await invoke('refresh_plugins');
          pushOutput('out', '✓ 已刷新插件列表（含 .mufurong / .mujin 自动解压）');
          break;
        }

        case 'reload': {
          const pluginId = args[0];
          if (!pluginId) {
            pushOutput('err', '用法: :reload <plugin_id>');
            break;
          }
          await invoke('reload_plugin', { pluginId });
          pushOutput('out', `✓ 已派发热重载事件: ${pluginId}`);
          break;
        }

        case 'http': {
          const method = (args[0] || 'GET').toUpperCase();
          const url = args[1];
          if (!url) {
            pushOutput('err', '用法: :http <METHOD> <url> [body]');
            break;
          }
          const body = args.slice(2).join(' ') || null;
          pushOutput('sys', `→ ${method} ${url}${body ? ` (body: ${body.length} chars)` : ''}`);
          const resp = await invoke<string>('dev_console_http', {
            method,
            url,
            body,
            headers: null,
          });
          pushOutput('out', resp);
          break;
        }

        default:
          pushOutput('err', `命令未实现: :${name}`);
      }
    } catch (e: unknown) {
      pushOutput('err', `执行失败: ${String(e)}`);
    }
  }, [pushOutput]);

  // ========== 安装 .mufurong / .mujin ==========
  async function installPackage(filePath: string) {
    const lower = filePath.toLowerCase();
    const fileName = filePath.split(/[\\/]/).pop() || '';
    if (lower.endsWith('.mufurong')) {
      pushOutput('sys', `→ 安装插件: ${fileName}`);
      const bytes = await readBytesViaRust(filePath);
      // 写到 user_plugins/<fileName>，extract_mufurong_plugins 会自动扫描并解压
      await invoke('install_user_plugin_file', { targetSubpath: fileName, data: bytes });
      await invoke('refresh_plugins');
      pushOutput('out', `✓ 已安装插件 ${fileName}（位于 user_plugins/ 根，建议按需移动到母文件夹如 niaoluo/）`);
    } else if (lower.endsWith('.mujin')) {
      pushOutput('sys', `→ 安装依赖: ${fileName}`);
      const bytes = await readBytesViaRust(filePath);
      // 写到 user_external_deps/ 根目录，用户可后续移动到母文件夹
      await invoke('install_dep_file', { targetSubpath: fileName, data: bytes });
      await invoke('refresh_plugins');
      pushOutput('out', `✓ 已安装依赖 ${fileName}（位于 user_external_deps/ 根，建议按需移动到母文件夹如 niaoluo/ide/）`);
    } else {
      pushOutput('err', '不支持的文件类型（仅 .mufurong / .mujin）');
    }
  }

  // 通过 read_file_base64 读取二进制（返回格式为 "data:<mime>;base64,<b64>"）
  async function readBytesViaRust(filePath: string): Promise<number[]> {
    const dataUrl = await invoke<string>('read_file_base64', { filePath });
    // 去掉 data URL 前缀
    const base64 = dataUrl.includes(',') ? dataUrl.split(',').slice(1).join(',') : dataUrl;
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return Array.from(bytes);
  }

  // ========== 键盘事件 ==========
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void execute(input);
      setInput('');
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (history.length === 0) return;
      const newIdx = historyIdx === -1 ? history.length - 1 : Math.max(0, historyIdx - 1);
      setHistoryIdx(newIdx);
      setInput(history[newIdx]);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (history.length === 0 || historyIdx === -1) return;
      const newIdx = historyIdx + 1;
      if (newIdx >= history.length) {
        setHistoryIdx(-1);
        setInput('');
      } else {
        setHistoryIdx(newIdx);
        setInput(history[newIdx]);
      }
    } else if (e.key === 'l' && e.ctrlKey) {
      e.preventDefault();
      setOutputs([]);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const prefix = input.slice(1);
      const matches = COMMAND_NAMES.filter(c => c.startsWith(prefix));
      if (matches.length === 1) {
        setInput(':' + matches[0] + ' ');
      } else if (matches.length > 1) {
        pushOutput('sys', `补全候选: ${matches.map(m => ':' + m).join('  ')}`);
      }
    }
  };

  // ========== 清空历史 ==========
  const clearHistory = () => {
    setHistory([]);
    setHistoryIdx(-1);
    localStorage.removeItem('dev_console_history');
    pushOutput('sys', '已清空命令历史');
  };

  // ========== 颜色映射 ==========
  const colorClass = (kind: OutputKind): string => {
    switch (kind) {
      case 'in':  return 'text-neutral-500 dark:text-stone-400';
      case 'out': return 'text-neutral-700 dark:text-stone-200';
      case 'err': return 'text-red-500 dark:text-red-400';
      case 'sys': return 'text-amber-600 dark:text-amber-400';
    }
  };

  const prefixIcon = (kind: OutputKind): string => {
    switch (kind) {
      case 'in':  return '❯';
      default: return '';
    }
  };

  return (
    <section className="bg-white dark:bg-stone-800/70 backdrop-blur rounded-xl border border-white/80 dark:border-stone-700/50 overflow-hidden">
      {/* 标题栏 */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-200/50 dark:border-stone-700/50">
        <div className="flex items-center gap-2">
          <Terminal size={16} className="text-neutral-400 dark:text-stone-500" />
          <h2 className="text-sm font-semibold text-neutral-800 dark:text-stone-100">开发者控制台</h2>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={clearHistory}
            title="清空历史"
            className="p-1.5 rounded-lg text-neutral-400 dark:text-stone-500 hover:text-[var(--element-bg)] hover:bg-[var(--element-muted)] transition-colors"
          >
            <ChevronUp size={14} />
          </button>
          <button
            onClick={() => setOutputs([])}
            title="清屏"
            className="p-1.5 rounded-lg text-neutral-400 dark:text-stone-500 hover:text-[var(--element-bg)] hover:bg-[var(--element-muted)] transition-colors"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {/* 输出区 */}
      <div
        ref={scrollRef}
        className="h-72 overflow-y-auto p-3 font-mono text-xs leading-relaxed bg-neutral-50/50 dark:bg-stone-900/40 text-neutral-700 dark:text-stone-300"
        onClick={() => inputRef.current?.focus()}
      >
        {outputs.map((line, i) => (
          <div key={i} className="flex gap-2">
            <span className="text-neutral-400 dark:text-stone-600 select-none flex-shrink-0">{line.time}</span>
            <span className="text-neutral-400 dark:text-stone-600 select-none flex-shrink-0">{prefixIcon(line.kind)}</span>
            <pre className={`whitespace-pre-wrap break-all ${colorClass(line.kind)}`}>{line.text}</pre>
          </div>
        ))}
      </div>

      {/* 输入栏 */}
      <div className="flex items-center gap-2 px-3 py-2 border-t border-neutral-200/50 dark:border-stone-700/50 bg-white dark:bg-stone-800/70">
        <ChevronDown size={14} className="text-neutral-400 dark:text-stone-500 flex-shrink-0" />
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="输入指令（:help 查看）  ·  ↑↓ 历史  ·  Ctrl+L 清屏  ·  Tab 补全"
          className="flex-1 bg-transparent border-none outline-none text-xs font-mono text-neutral-700 dark:text-stone-200 placeholder-neutral-400 dark:placeholder-stone-500"
          autoComplete="off"
          spellCheck={false}
        />
        <button
          onClick={() => { void execute(input); setInput(''); }}
          disabled={!input.trim()}
          className="p-1.5 rounded-lg text-neutral-400 dark:text-stone-500 hover:text-[var(--element-bg)] hover:bg-[var(--element-muted)] transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          title="执行"
        >
          <Send size={14} />
        </button>
      </div>
    </section>
  );
}

export default DevConsole;
