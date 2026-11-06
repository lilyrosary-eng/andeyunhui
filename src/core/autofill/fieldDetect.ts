// 登录字段判据（纯函数，可单测）+ 少量 DOM 适配。
// 目的：找出「用户名 / 密码 / 动态码」三类字段，并确定填充作用域。
// 只处理应用自己的 DOM（插件与宿主同文档）；跨源 iframe 受同源策略限制，明确不做。

export type FieldRole = 'username' | 'password' | 'otp' | 'unknown';

export interface FieldDescriptor {
  type: string;
  autocomplete: string;
  name: string;
  id: string;
  placeholder: string;
  ariaLabel: string;
  className: string;
  /** 同一容器里是否还有 type=password 的输入框（决定要不要在弱特征字段上挂图标） */
  containerHasPassword: boolean;
}

export interface Classification {
  role: FieldRole;
  score: number;
}

const PASSWORD_RE = /(password|passwd|pwd|passphrase|密码|口令)/i;
const USERNAME_RE = /(username|user_name|userid|user-id|login|account|email|mail|账号|帐号|用户名|邮箱)/i;
const OTP_RE = /(one-time|otp|totp|2fa|mfa|verif(y|ication)[-_ ]?code|验证码|动态码)/i;

export function classifyField(d: FieldDescriptor): Classification {
  const type = d.type.toLowerCase();
  if (type === 'password') return { role: 'password', score: 100 };
  if (type === 'hidden' || type === 'submit' || type === 'button' || type === 'checkbox' || type === 'radio') {
    return { role: 'unknown', score: 0 };
  }

  const ac = d.autocomplete.toLowerCase();
  if (ac === 'current-password' || ac === 'new-password') return { role: 'password', score: 95 };
  if (ac === 'one-time-code') return { role: 'otp', score: 95 };
  if (ac === 'username' || ac === 'email') {
    // 没有密码兄弟字段时，普通邮箱框（如收件人）不挂登录图标
    return d.containerHasPassword ? { role: 'username', score: 90 } : { role: 'unknown', score: 20 };
  }

  const hay = `${d.name} ${d.id} ${d.placeholder} ${d.ariaLabel} ${d.className}`;
  if (OTP_RE.test(hay)) return { role: 'otp', score: 85 };
  if (PASSWORD_RE.test(hay)) return { role: 'password', score: 80 };
  if (USERNAME_RE.test(hay)) {
    return d.containerHasPassword ? { role: 'username', score: 75 } : { role: 'unknown', score: 15 };
  }
  return { role: 'unknown', score: 0 };
}

// ===================== DOM 适配 =====================

export function describeInput(el: HTMLInputElement): FieldDescriptor {
  const scope = resolveScope(el);
  return {
    type: el.type ?? 'text',
    autocomplete: el.getAttribute('autocomplete') ?? '',
    name: el.name ?? '',
    id: el.id ?? '',
    placeholder: el.getAttribute('placeholder') ?? '',
    ariaLabel: el.getAttribute('aria-label') ?? '',
    className: typeof el.className === 'string' ? el.className : '',
    containerHasPassword: scope.querySelectorAll('input[type="password"]').length > 0,
  };
}

export function isEditable(el: Element): el is HTMLInputElement {
  if (!(el instanceof HTMLInputElement)) return false;
  if (el.disabled || el.readOnly) return false;
  const type = (el.type || 'text').toLowerCase();
  return type !== 'hidden' && type !== 'submit' && type !== 'button' && type !== 'checkbox' && type !== 'radio';
}

export function isVisible(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  const style = window.getComputedStyle(el);
  return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0;
}

/**
 * 填充作用域：优先 <form>，否则向上找第一个含密码框的容器，最后退回 body。
 * 退回 body 只影响「找兄弟字段」，不会被用来从整页乱填。
 */
export function resolveScope(el: Element): HTMLElement {
  const form = el.closest('form');
  if (form) return form as HTMLElement;
  let node: HTMLElement | null = el.parentElement;
  while (node && node !== document.body) {
    if (node.querySelector('input[type="password"]')) return node;
    node = node.parentElement;
  }
  return document.body;
}

export interface LoginFields {
  username?: HTMLInputElement;
  password?: HTMLInputElement;
  otp?: HTMLInputElement;
}

/** 在作用域里找出最可能的用户名 / 密码 / 动态码字段。 */
export function findLoginFields(el: HTMLInputElement): LoginFields {
  const scope = resolveScope(el);
  const inputs = Array.from(scope.querySelectorAll('input')).filter(isEditable);
  const result: LoginFields = {};
  for (const input of inputs) {
    const { role, score } = classifyField(describeInput(input));
    if (role === 'password' && (!result.password || score > 90)) result.password = input;
    if (role === 'username' && !result.username) result.username = input;
    if (role === 'otp' && !result.otp) result.otp = input;
  }
  return result;
}

/**
 * 用原生 value setter 写值再派发 input/change。
 * React 受控输入框维护着自己的 value tracker，直接 `el.value = x` 会被判定为「没变」而
 * 不更新 state —— 这是自动填充最常见的假成功。必须绕过 tracker。
 */
export function setNativeValue(el: HTMLInputElement, value: string): void {
  const proto = Object.getPrototypeOf(el) as object;
  const desc =
    Object.getOwnPropertyDescriptor(proto, 'value') ??
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  if (desc?.set) desc.set.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

/** 表单上下文文字：用于给候选排序（标题/占位/附近标签）。 */
export function contextText(el: HTMLInputElement): string {
  const scope = resolveScope(el);
  const labels = Array.from(scope.querySelectorAll('label, [aria-label], h1, h2, h3, .title, [data-title]'))
    .slice(0, 40)
    .map((n) => `${n.textContent ?? ''} ${n.getAttribute('aria-label') ?? ''}`)
    .join(' ');
  return [document.title, labels, el.getAttribute('placeholder') ?? ''].join(' ').trim();
}
