// 登录字段判据单测：只看纯函数，不依赖 DOM。
import { describe, expect, it } from 'vitest';
import { classifyField, type FieldDescriptor } from './fieldDetect';

const base: FieldDescriptor = {
  type: 'text',
  autocomplete: '',
  name: '',
  id: '',
  placeholder: '',
  ariaLabel: '',
  className: '',
  containerHasPassword: false,
};

const d = (patch: Partial<FieldDescriptor>): FieldDescriptor => ({ ...base, ...patch });

describe('classifyField', () => {
  it('type=password 最高优先', () => {
    expect(classifyField(d({ type: 'password' })).role).toBe('password');
    expect(classifyField(d({ type: 'password' })).score).toBe(100);
  });

  it('autocomplete 语义优先于弱文本特征', () => {
    expect(classifyField(d({ autocomplete: 'current-password' })).role).toBe('password');
    expect(classifyField(d({ autocomplete: 'one-time-code' })).role).toBe('otp');
    expect(classifyField(d({ autocomplete: 'username', containerHasPassword: true })).role).toBe('username');
  });

  it('没有密码兄弟字段的邮箱框不当作登录账号', () => {
    expect(classifyField(d({ autocomplete: 'email' })).role).toBe('unknown');
    expect(classifyField(d({ autocomplete: 'email', containerHasPassword: true })).role).toBe('username');
  });

  it('中英文 name/id/placeholder 启发式', () => {
    expect(classifyField(d({ placeholder: '请输入密码' })).role).toBe('password');
    expect(classifyField(d({ name: 'login_account', containerHasPassword: true })).role).toBe('username');
    expect(classifyField(d({ ariaLabel: '动态验证码' })).role).toBe('otp');
  });

  it('非输入型控件与无关文本框返回 unknown', () => {
    expect(classifyField(d({ type: 'hidden' })).role).toBe('unknown');
    expect(classifyField(d({ type: 'checkbox' })).role).toBe('unknown');
    expect(classifyField(d({ placeholder: '搜索' })).role).toBe('unknown');
  });
});
