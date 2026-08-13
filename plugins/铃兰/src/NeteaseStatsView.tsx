import React from "react";
import {
  getUserAccount,
  getUserPlaylists,
  getListenNow,
  getTopList,
  isLikedPlaylist,
  type NeteaseProfile,
  type NeteasePlaylistItem,
  type NeteaseTrack,
} from "./neteaseApi";

const { useState, useEffect } = React;

interface NeteaseStatsViewProps {
  onClose: () => void;
}

interface ListenNowTrack {
  id: number;
  name: string;
  artists: { name: string }[];
}

export default function NeteaseStatsView({ onClose }: NeteaseStatsViewProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState<NeteaseProfile | null>(null);
  const [likedCount, setLikedCount] = useState<number | null>(null);
  const [createdCount, setCreatedCount] = useState<number | null>(null);
  const [subscribedCount, setSubscribedCount] = useState<number | null>(null);
  const [totalPlayCount, setTotalPlayCount] = useState<number | null>(null);
  const [recent, setRecent] = useState<ListenNowTrack[]>([]);
  const [topSongs, setTopSongs] = useState<{ name: string; artist: string }[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [acc, listenNow, topList] = await Promise.all([
          getUserAccount(),
          getListenNow(30),
          getTopList(0, 30),
        ]);

        if (cancelled) return;

        setProfile(acc);

        // 歌单统计：用账户 uid 拉取「我自己的收藏歌单」
        let pls: NeteasePlaylistItem[] = [];
        try {
          if (acc?.userId) pls = await getUserPlaylists(acc.userId, 100);
        } catch {
          pls = [];
        }
        if (cancelled) return;

        const liked = pls.find((p) => isLikedPlaylist(p));
        setLikedCount(liked?.trackCount ?? null);
        setCreatedCount(pls.filter((p) => !p.subscribed && !isLikedPlaylist(p)).length);
        setSubscribedCount(pls.filter((p) => p.subscribed).length);
        setTotalPlayCount(pls.reduce((s, p) => s + (p.playCount || 0), 0));

        setRecent(
          (listenNow || [])
            .slice(0, 20)
            .map((t: NeteaseTrack) => ({
              id: t.id,
              name: t.name || "未知歌曲",
              artists: t.artists || [],
            }))
        );

        // 榜单 Top（默认云音乐飙升榜 id=0；取前若干作为"热门歌曲"展示）
        const songs = ((topList?.tracks) || []).slice(0, 20).map((t: NeteaseTrack) => ({
          name: t.name || "未知歌曲",
          artist: (t.artists || []).map((a) => a.name).join("/") || "未知歌手",
        }));
        setTopSongs(songs);
      } catch (e: any) {
        if (!cancelled) setError(String(e?.message || e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const fmt = (n: number | null) =>
    n == null ? "—" : n.toLocaleString("zh-CN");

  return (
    <div className="flex flex-col h-full bg-[#f5f5f0] dark:bg-[#1c1917]">
      <div className="flex items-center gap-3 px-5 py-4 border-b border-neutral-200/50 dark:border-stone-700/50">
        <button
          onClick={onClose}
          className="px-2 py-1 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 text-neutral-500 dark:text-stone-400 text-base"
          aria-label="返回"
        >
          ←
        </button>
        <h2 className="text-lg font-semibold text-neutral-800 dark:text-stone-100">
          网易云统计
        </h2>
        {profile && (
          <span className="ml-auto text-sm text-neutral-500 dark:text-stone-400 truncate">
            {profile.nickname}
            {profile.vipType > 0 ? " · VIP" : ""}
          </span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-5">
        {loading ? (
          <div className="text-neutral-400 dark:text-stone-500 text-sm py-10 text-center">
            加载中…
          </div>
        ) : error ? (
          <div className="text-red-500 text-sm py-10 text-center">
            读取失败：{error}
            <div className="text-neutral-400 dark:text-stone-500 text-xs mt-2">
              请确认已登录网易云，且接口未被风控拦截
            </div>
          </div>
        ) : (
          <div className="space-y-6 max-w-3xl">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <StatCard value={fmt(likedCount)} label="我喜欢的音乐" />
              <StatCard value={fmt(createdCount)} label="自建歌单" />
              <StatCard value={fmt(subscribedCount)} label="收藏歌单" />
              <StatCard value={fmt(totalPlayCount)} label="歌单总播放" />
            </div>

            <Section title="最近播放">
              {recent.length === 0 ? (
                <Empty />
              ) : (
                <div className="space-y-1">
                  {recent.map((t) => (
                    <Row
                      key={t.id}
                      title={t.name}
                      sub={(t.artists || []).map((a) => a.name).join("/") || "未知歌手"}
                    />
                  ))}
                </div>
              )}
            </Section>

            <Section title="热门榜单（云音乐飙升榜）">
              {topSongs.length === 0 ? (
                <Empty />
              ) : (
                <div className="space-y-1">
                  {topSongs.map((t, i) => (
                    <Row key={i} index={i + 1} title={t.name} sub={t.artist} />
                  ))}
                </div>
              )}
            </Section>

            <p className="text-xs text-neutral-400 dark:text-stone-500 leading-relaxed">
              数据直接来自网易云接口，依赖登录状态与接口稳定性，不落本地库。
              「我喜欢的音乐」数量与歌单统计基于你的账户歌单；听歌记录接口受限，此处以「最近播放」与「榜单」替代呈现。
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-2xl bg-black/5 dark:bg-white/5 px-4 py-4">
      <div className="text-2xl font-semibold text-neutral-800 dark:text-stone-100 tabular-nums">
        {value}
      </div>
      <div className="text-xs text-neutral-500 dark:text-stone-400 mt-1">{label}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-sm font-medium text-neutral-700 dark:text-stone-200 mb-3">
        {title}
      </div>
      {children}
    </div>
  );
}

function Row({
  title,
  sub,
  index,
}: {
  title: string;
  sub: string;
  index?: number;
}) {
  return (
    <div className="flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-black/5 dark:hover:bg-white/5">
      {index != null && (
        <div className="w-5 text-right text-xs text-neutral-400 dark:text-stone-500 tabular-nums">
          {index}
        </div>
      )}
      <div className="flex-1 min-w-0">
        <div className="text-sm text-neutral-800 dark:text-stone-100 truncate">{title}</div>
        <div className="text-xs text-neutral-500 dark:text-stone-400 truncate">{sub}</div>
      </div>
    </div>
  );
}

function Empty() {
  return (
    <div className="text-neutral-400 dark:text-stone-500 text-sm py-6 text-center">
      暂无数据
    </div>
  );
}
