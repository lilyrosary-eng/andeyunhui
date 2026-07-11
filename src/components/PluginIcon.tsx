import { type ReactNode, type SVGProps } from 'react';
import { getIcon } from '@/lib/iconRegistry';

interface PluginIconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: string;
  size?: number;
  className?: string;
  /** 图标未找到时的回退内容 */
  fallback?: ReactNode;
}

/**
 * 插件图标渲染组件。
 *
 * 封装为模块级组件，避免在渲染期动态获取组件引用再以 JSX 渲染，
 * 否则会触发 react-hooks/static-components 规则（被判定为"渲染期创建组件"，
 * 导致子树 state 在每次渲染时被重置）。
 */
export function PluginIcon({ name, size, className, fallback = null, ...rest }: PluginIconProps) {
  const IconComp = getIcon(name);
  if (!IconComp) return <>{fallback}</>;
  return <IconComp size={size} className={className} {...rest} />;
}
