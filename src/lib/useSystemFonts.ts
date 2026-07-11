import { useState, useEffect } from 'react';
import { detectSystemFonts, type FontInfo } from '@/lib/fonts';
import { logger } from '@/lib/logger';

/**
 * 系统字体检测 Hook
 * 在组件挂载时异步检测用户系统中的所有字体
 */
export function useSystemFonts() {
  const [fonts, setFonts] = useState<FontInfo[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    detectSystemFonts().then((result) => {
      if (!cancelled) {
        setFonts(result);
        setLoading(false);
      }
    }).catch((err) => {
      if (!cancelled) {
        logger.log('[useSystemFonts] 检测失败:', err);
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, []);

  return { fonts, loading };
}