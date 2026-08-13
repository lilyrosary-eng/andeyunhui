import React from 'react';

export interface NeteaseTempItem {
  id: string;       // 来源标识（如歌单 id / 搜索关键词 / 每日推荐），用于去重
  name: string;     // 显示名（=当前播放列表名称）
  payload: any;     // 回传给 index 的选中参数
}

interface NeteaseSidebarProps {
  likedPlaylistId: number | null;
  tempPlaylists: NeteaseTempItem[];        // 最多 3 个，索引 0 = 临时1（当前播放）
  userPlaylists: { id: number; name: string; coverImgUrl: string; trackCount: number }[];
  activePlaylistId: number | null;          // 当前查看的歌单 id（高亮用）
  activeTempId: string | null;              // 当前临时列表 id（高亮用）
  onSelectLiked: () => void;
  onSelectTemp: (item: NeteaseTempItem) => void;
  onSelectUserPlaylist: (id: number, name: string) => void;
}

function Row({ active, onClick, children }: { active?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={
        'w-full text-left px-3 py-1.5 rounded-lg text-sm truncate transition-colors ' +
        (active
          ? 'bg-rose-500/15 text-rose-600 dark:text-rose-300 font-medium'
          : 'text-neutral-700 dark:text-stone-200 hover:bg-black/5 dark:hover:bg-white/10')
      }
    >
      {children}
    </button>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-1 mt-4 mb-1 text-[11px] font-semibold uppercase tracking-wider text-neutral-400 dark:text-stone-500">
      {children}
    </div>
  );
}

export default function NeteaseSidebar(props: NeteaseSidebarProps) {
  const {
    likedPlaylistId,
    tempPlaylists,
    userPlaylists,
    activePlaylistId,
    activeTempId,
    onSelectLiked,
    onSelectTemp,
    onSelectUserPlaylist,
  } = props;

  return (
    <div className="w-[260px] h-full flex-shrink-0 bg-white/60 dark:bg-stone-800/60 backdrop-blur-md border-r border-white/80 dark:border-stone-700/50 p-4 overflow-y-auto">
      <div className="flex items-center gap-2 mb-4 px-1">
        <span className="text-rose-500">♪</span>
        <span className="font-bold text-lg text-neutral-800 dark:text-stone-100">网易云音乐</span>
      </div>

      <SectionTitle>我的收藏</SectionTitle>
      <Row active={activePlaylistId === likedPlaylistId} onClick={onSelectLiked}>
        ❤ 我喜欢的音乐
      </Row>

      <SectionTitle>临时播放列表</SectionTitle>
      {tempPlaylists.length === 0 && (
        <div className="px-3 py-1.5 text-sm text-neutral-400 dark:text-stone-500">
          暂无临时播放列表
        </div>
      )}
      {tempPlaylists.map((t, i) => (
        <Row key={t.id} active={activeTempId === t.id} onClick={() => onSelectTemp(t)}>
          {`临时${i + 1}：${t.name}`}
        </Row>
      ))}

      <SectionTitle>用户自己的收藏歌单</SectionTitle>
      {userPlaylists.length === 0 && (
        <div className="px-3 py-1.5 text-sm text-neutral-400 dark:text-stone-500">
          暂无收藏歌单
        </div>
      )}
      {userPlaylists.map((p) => (
        <Row
          key={`u-${p.id}`}
          active={activePlaylistId === p.id}
          onClick={() => onSelectUserPlaylist(p.id, p.name)}
        >
          {p.name}
        </Row>
      ))}
    </div>
  );
}
