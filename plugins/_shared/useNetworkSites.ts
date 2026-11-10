// 网络拓展的 React 订阅 hook（**只给插件用**，宿主设置页直接用 registry 的函数）。
//
// 放在单独文件而不是 networkSites.ts：那个文件被宿主 import，
// 而这里需要 React（插件里由构建期外部化到 window.__HOST_REACT__）。
import React from 'react';
import {
  allSites,
  onNetworkSitesChange,
  type NetworkSite,
  type NetworkSiteModule,
} from './networkSites';

/**
 * 订阅某模块的「内置 + 自定义」站点列表。
 * 用户在「设置 → 茑萝 → 网络拓展」增删后，抽屉/侧栏会立即刷新，无需重启。
 */
export function useNetworkSites(module: NetworkSiteModule): NetworkSite[] {
  const [list, setList] = React.useState<NetworkSite[]>(() => allSites(module));
  React.useEffect(() => {
    const sync = () => setList(allSites(module));
    sync();
    return onNetworkSitesChange(sync);
  }, [module]);
  return list;
}

export default useNetworkSites;
