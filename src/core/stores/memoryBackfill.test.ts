// extractTurns 的判据：配对规则来自**真实会话文件里观察到的事件形状**（10-30 那个会话就是
// 用户提问 + 工具调用（助手正文为空）+ 工具失败），不是理想化的 user/assistant 交替。
// 尤其要守住：工具轮不能把待配对的提问丢掉，但也不能写出「助手：」为空的半条记录。
import { describe, expect, it } from 'vitest';

import { extractTurns } from './memoryBackfill';

type Ev = Record<string, { seq?: number; content?: string } | undefined>;

describe('extractTurns', () => {
  it('普通一问一答配成一轮，seq 用助手消息的序号', () => {
    const ev: Ev[] = [{ User: { seq: 0, content: '帮我看看这段代码' } }, { Assistant: { seq: 1, content: '第三行的越界。' } }];
    expect(extractTurns(ev)).toEqual([{ user: '帮我看看这段代码', asst: '第三行的越界。', seq: 1 }]);
  });

  it('助手先走工具（正文为空）再给正文：仍与最早那条提问配对', () => {
    const ev: Ev[] = [
      { User: { seq: 0, content: '这是什么' } },
      { Assistant: { seq: 1, content: '' } }, // 只有 tool_calls
      { Tool: { seq: 2, content: 'ComfyUI 不可达' } },
      { Assistant: { seq: 3, content: '这是一张动漫风格的角色图。' } },
    ];
    expect(extractTurns(ev)).toEqual([
      { user: '这是什么', asst: '这是一张动漫风格的角色图。', seq: 3 },
    ]);
  });

  it('整场都没有助手正文（纯工具失败）→ 不产出记录，避免写进半条噪声', () => {
    const ev: Ev[] = [
      { User: { seq: 0, content: '这是什么' } },
      { Assistant: { seq: 1, content: '' } },
      { Tool: { seq: 2, content: '失败' } },
    ];
    expect(extractTurns(ev)).toEqual([]);
  });

  it('用户连发两条（改口/追加）合并成一轮，两条都保留', () => {
    const ev: Ev[] = [
      { User: { seq: 0, content: '第一问' } },
      { User: { seq: 1, content: '补充：还有第二问' } },
      { Assistant: { seq: 2, content: '一起答' } },
    ];
    const [turn] = extractTurns(ev);
    expect(turn.user).toBe('第一问\n补充：还有第二问');
    expect(turn.asst).toBe('一起答');
  });

  it('多轮按顺序产出，且配对后重新起算（不会把上一轮的提问重复挂上）', () => {
    const ev: Ev[] = [
      { User: { seq: 0, content: 'A' } },
      { Assistant: { seq: 1, content: 'a' } },
      { User: { seq: 2, content: 'B' } },
      { Assistant: { seq: 3, content: 'b' } },
    ];
    expect(extractTurns(ev)).toEqual([
      { user: 'A', asst: 'a', seq: 1 },
      { user: 'B', asst: 'b', seq: 3 },
    ]);
  });

  it('空/空白正文与缺少字段的事件不报错也不产出', () => {
    expect(extractTurns([])).toEqual([]);
    expect(
      extractTurns([
        { User: { seq: 0, content: '   ' } },
        { Assistant: { seq: 1, content: '有效回答' } },
        {},
        undefined,
      ] as Ev[]),
    ).toEqual([]);
  });
});
