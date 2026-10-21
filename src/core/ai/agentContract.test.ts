/**
 * Agent 提示词 / 工具组装契约（静态评测，2026-10-21）
 *
 * 为什么在 TS 侧做静态断言，而不是 Rust 单测：
 *   本机 `cargo test --lib` 的测试进程起不来（STATUS_ENTRYPOINT_NOT_FOUND，
 *   未改动的旧测试同样失败，属既有环境问题），Rust 侧断言暂时跑不了。
 *   但"提示词里的工程约束有没有被删掉""工具 schema 有没有绕开统一组装"这类问题
 *   是可以从源码文本上判定的 —— 用 vitest 先兜住，等 Rust 测试环境修好再下沉。
 *
 * 定位：**绊线**，不是完备验证。断言只钉"关键事实还在"，不钉具体措辞，
 * 避免改一句注释就红一片。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), 'utf-8');

describe('agent 组装（ai_agent.rs）', () => {
  const src = read('src-tauri/src/services/ai_service/ai_agent.rs');

  it('工具列表统一走 tool_schemas_for_api*（各自 map 会导致某个 schema 缺 type ⇒ 整批 400）', () => {
    expect(src).toContain('tool_schemas_for_api()');
    expect(src).toContain('tool_schemas_for_api_without');
    // 不允许出现"自己遍历注册表拼 schema"的旁路
    expect(src).not.toMatch(/registered_tools\(\)\s*\.\s*iter\(\)\s*\.\s*map\([^)]*function_schema/);
  });

  it('联网开关只过滤 web_search，其余工具常开', () => {
    expect(src).toMatch(/tool_schemas_for_api_without\(&\["web_search"\]\)/);
  });

  it('工程硬约束还在（这些是"模型乱改代码"的唯一防线）', () => {
    const required = [
      'git status', // 动手前看清状态
      '写入即落盘', // 写完必须自己验证，没有"审阅后落盘"
      '快照', // 每轮快照 / 可回滚
      '提交', // 每个可验证点提交一次
    ];
    for (const k of required) {
      expect(src, `提示词缺少关键约束：${k}`).toContain(k);
    }
  });

  it('请求前有 token 估算（后端截断是兜底，不是唯一防线）', () => {
    expect(src).toContain('estimate_tokens');
  });
});

describe('工具层契约（ai_tools.rs）', () => {
  const src = read('src-tauri/src/services/ai_service/ai_tools.rs');

  it('存在 normalize_tool_schema：补齐每个工具的 type=function', () => {
    expect(src).toContain('fn normalize_tool_schema');
    expect(src).toContain('"type": "function"');
  });

  it('tool_schemas_for_api_without 真的跳过被排除的工具（不是发出去再拒绝）', () => {
    expect(src).toMatch(/exclude\.contains\(&name\.as_str\(\)\)/);
    expect(src).toMatch(/continue;/);
  });
});

describe('工具实现契约（fs_shell.rs）', () => {
  const src = read('src-tauri/src/services/ai_service/ai_tools/fs_shell.rs');

  it('写文件是"写入即落盘 + 落盘前快照"，不是只暂存等审阅', () => {
    expect(src).toContain('checkpoint::capture');
    expect(src).not.toMatch(/等用户审阅确认后落盘/);
  });

  it('run_command 描述里写明执行环境（避免模型反复用 bash 语法撞墙）', () => {
    expect(src).toContain('【执行环境】');
  });
});
