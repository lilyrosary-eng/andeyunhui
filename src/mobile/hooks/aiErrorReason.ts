// AI 流式对话错误降级原因推断（纯函数，从 useAiStream.ts 抽出以便单测）

/** 推断降级原因 */
export function guessReason(err: string): string {
  const low = err.toLowerCase();
  if (low.includes('timeout') || low.includes('timed out') || low.includes('超时')) {
    return '算力源响应超时，可能是电脑忙碌或网络波动。';
  }
  if (low.includes('connection refused') || low.includes('econnrefused') || low.includes('连接被拒绝')) {
    return '书房台式机没有响应，可能是电脑睡眠了，或者不在同一个 Wi-Fi。';
  }
  if (low.includes('dns') || low.includes('getaddrinfo') || low.includes('enotfound')) {
    return '无法解析算力源地址，请检查网络连接或电脑是否在线。';
  }
  if (low.includes('api key') || low.includes('unauthorized') || low.includes('401')) {
    return 'API Key 无效或未配置，请在设置中检查算力来源凭据。';
  }
  return '算力源暂时不可达，可以重试或改用云端继续对话。';
}
