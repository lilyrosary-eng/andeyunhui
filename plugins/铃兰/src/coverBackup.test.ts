import { describe, expect, it } from 'vitest';
import { coverBackupLabel } from './coverBackup';

describe('封面留底文件名的解读', () => {
  it('按写侧命名（路径哈希_10位秒_内容哈希.扩展名）换成可读日期', () => {
    const label = coverBackupLabel('D:\\data\\cover_backups\\a1b2c3_1700000000_deadbeef.jpg');
    expect(label).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(label.startsWith('2023-11-15')).toBe(true);
  });

  it('正斜杠路径一样能取到文件名', () => {
    expect(coverBackupLabel('/app/cover_backups/aa_1700000001_bb.png')).toMatch(/^2023-11-15 /);
  });

  it('认不出时间戳就退回原文件名，不猜（毫秒级 13 位也不算秒时间戳）', () => {
    expect(coverBackupLabel('whatever.jpg')).toBe('whatever.jpg');
    // 13 位毫秒：正则只认前后都是下划线的恰好 10 位，所以不该被当成秒
    expect(coverBackupLabel('aa_1700000000000_bb.jpg')).toBe('aa_1700000000000_bb.jpg');
    expect(coverBackupLabel('')).toBe('');
  });

  it('异常输入不抛（路径可能来自后端字符串）', () => {
    expect(() => coverBackupLabel(undefined as unknown as string)).not.toThrow();
    expect(() => coverBackupLabel('a_99999999999999999999_b.jpg')).not.toThrow();
  });
});
