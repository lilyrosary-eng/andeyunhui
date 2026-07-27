import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

interface ThinkingToggleProps {
  profileId: string | null;
  disabled?: boolean;
  /** 紧凑模式：仅图标 + 开关点，适合聊天输入栏 */
  compact?: boolean;
}

/**
 * 思考模式（Thinking）内联开关 —— 跨胶囊 / IDE / 攻防共享同一档案字段。
 * 状态直接写入后端 profile.thinking（ai_set_profile_thinking），故在任意聊天界面切换都会持久化并相互影响。
 */
export function ThinkingToggle({ profileId, disabled, compact }: ThinkingToggleProps) {
  const [thinking, setThinking] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!profileId) return;
    let cancelled = false;
    invoke<{ profiles: Array<{ id: string; thinking?: boolean | null }> }>('ai_get_profiles')
      .then((d) => {
        if (cancelled) return;
        const p = (d.profiles || []).find((x) => x.id === profileId);
        setThinking(p?.thinking === true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [profileId]);

  // 接收其它聊天界面切换「思考模式」的事件，保持胶囊 / IDE / 攻防 三处开关实时同步
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<{ profile_id: string; thinking: boolean }>('ai-thinking-changed', (e) => {
      if (e.payload.profile_id === profileId) setThinking(e.payload.thinking);
    })
      .then((u) => {
        unlisten = u;
      })
      .catch(() => {});
    return () => {
      if (unlisten) unlisten();
    };
  }, [profileId]);

  const toggle = async () => {
    if (!profileId || loading) return;
    const next = !thinking;
    setThinking(next);
    setLoading(true);
    try {
      await invoke('ai_set_profile_thinking', { profileId, thinking: next });
    } catch {
      setThinking(!next);
    } finally {
      setLoading(false);
    }
  };

  const on = thinking;
  const dot: React.CSSProperties = {
    width: 8,
    height: 8,
    borderRadius: 999,
    background: on ? '#E6C35C' : 'rgba(244,244,246,0.35)',
    boxShadow: on ? '0 0 6px rgba(230,195,92,0.8)' : 'none',
    transition: 'all .15s',
  };

  return (
    <button
      title={on ? '思考模式：开（先输出思维链再回答）' : '思考模式：关（点击开启）'}
      onClick={toggle}
      disabled={disabled || loading}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: compact ? '3px 8px' : '5px 10px',
        borderRadius: 8,
        border: '1px solid ' + (on ? 'rgba(230,195,92,0.55)' : 'rgba(255,255,255,0.14)'),
        background: on ? 'rgba(230,195,92,0.16)' : 'rgba(255,255,255,0.06)',
        color: on ? '#F3E3B0' : 'rgba(244,244,246,0.62)',
        fontSize: 11.5,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.4 : 1,
        userSelect: 'none',
        transition: 'all .15s',
      }}
    >
      <span style={dot} />
      {!compact && <span>{on ? '思考模式' : '思考'}</span>}
      {compact && <span style={{ fontSize: 10.5 }}>{on ? '思考·开' : '思考·关'}</span>}
    </button>
  );
}
