import { describe, it, expect } from 'vitest';
import { parsePlanSnapshot, parsePlanApproval } from './planTypes';

describe('parsePlanSnapshot', () => {
  it('解析合法计划快照', () => {
    const plan = parsePlanSnapshot({
      title: '重构认证',
      next_id: 3,
      todos: [
        { id: '1', content: '梳理现有流程', done: true },
        { id: '2', content: '补测试', done: false },
      ],
    });
    expect(plan?.title).toBe('重构认证');
    expect(plan?.todos).toHaveLength(2);
    expect(plan?.todos[0].done).toBe(true);
  });

  it('空计划不展示（create_plan 后尚未 add_todo）', () => {
    expect(parsePlanSnapshot({ title: '计划', todos: [] })).toBeNull();
  });

  it('丢弃缺 id 或 content 的脏条目', () => {
    const plan = parsePlanSnapshot({
      title: '',
      todos: [
        { id: '', content: '无 id', done: false },
        { id: '2', content: '', done: false },
        { id: '3', content: '正常', done: false },
      ],
    });
    expect(plan?.todos).toHaveLength(1);
    expect(plan?.todos[0].id).toBe('3');
  });

  it('非对象 / 缺 todos 返回 null', () => {
    expect(parsePlanSnapshot(null)).toBeNull();
    expect(parsePlanSnapshot('bad')).toBeNull();
    expect(parsePlanSnapshot({ title: 'x' })).toBeNull();
  });
});

describe('parsePlanApproval', () => {
  // 血案防护：确认闸门若把「空计划」当 null，前端就不渲染确认按钮，
  // 后端只能一路等到 300s 超时才继续 —— 必须允许空计划。
  it('空计划也要返回快照（否则确认按钮无处可点）', () => {
    const plan = parsePlanApproval({ title: '登录改造', todos: [] });
    expect(plan).not.toBeNull();
    expect(plan?.title).toBe('登录改造');
    expect(plan?.todos).toHaveLength(0);
  });

  it('缺 todos 字段按空列表处理，而不是 null', () => {
    expect(parsePlanApproval({ title: '只有标题' })?.todos).toEqual([]);
  });

  it('照常解析待办并丢弃脏条目', () => {
    const plan = parsePlanApproval({
      title: '发布',
      todos: [
        { id: '1', content: '打包', done: true },
        { id: '', content: '脏数据', done: false },
      ],
    });
    expect(plan?.todos).toHaveLength(1);
    expect(plan?.todos[0].done).toBe(true);
  });

  it('非对象返回 null', () => {
    expect(parsePlanApproval(null)).toBeNull();
    expect(parsePlanApproval('bad')).toBeNull();
  });
});
