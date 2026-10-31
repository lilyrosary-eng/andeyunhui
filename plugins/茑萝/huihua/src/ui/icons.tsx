import type { ReactNode } from 'react';

function I({
  children,
  size = 14,
  className,
}: {
  children: ReactNode;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const IconUndo = (p: { size?: number; className?: string }) => (
  <I {...p}><path d="M9 14 4 9l5-5" /><path d="M4 9h10a6 6 0 0 1 0 12h-3" /></I>
);
export const IconRedo = (p: { size?: number; className?: string }) => (
  <I {...p}><path d="m15 14 5-5-5-5" /><path d="M20 9H10a6 6 0 0 0 0 12h3" /></I>
);
export const IconPlus = (p: { size?: number; className?: string }) => (
  <I {...p}><path d="M12 5v14" /><path d="M5 12h14" /></I>
);
export const IconEye = (p: { size?: number; className?: string }) => (
  <I {...p}><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" /><circle cx="12" cy="12" r="2.6" /></I>
);
export const IconEyeOff = (p: { size?: number; className?: string }) => (
  <I {...p}><path d="M3 3l18 18" /><path d="M10.6 6.2A9.9 9.9 0 0 1 12 6c6.5 0 10 6 10 6a17 17 0 0 1-3.2 3.7" /><path d="M6.2 6.4C3.6 8.2 2 12 2 12s3.5 6 10 6c1.6 0 3-.3 4.2-.9" /></I>
);
export const IconCopy = (p: { size?: number; className?: string }) => (
  <I {...p}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h9" /></I>
);
export const IconMerge = (p: { size?: number; className?: string }) => (
  <I {...p}><path d="M12 3v9" /><path d="m8 9 4 4 4-4" /><path d="M4 20h16" /></I>
);
export const IconTrash = (p: { size?: number; className?: string }) => (
  <I {...p}><path d="M4 7h16" /><path d="M9 7V5h6v2" /><path d="M6 7l1 13h10l1-13" /></I>
);
export const IconUp = (p: { size?: number; className?: string }) => (
  <I {...p}><path d="m6 14 6-6 6 6" /></I>
);
export const IconDown = (p: { size?: number; className?: string }) => (
  <I {...p}><path d="m6 10 6 6 6-6" /></I>
);
export const IconFit = (p: { size?: number; className?: string }) => (
  <I {...p}><path d="M8 3H5a2 2 0 0 0-2 2v3" /><path d="M16 3h3a2 2 0 0 1 2 2v3" /><path d="M8 21H5a2 2 0 0 1-2-2v-3" /><path d="M16 21h3a2 2 0 0 0 2-2v-3" /></I>
);
export const IconZoomIn = (p: { size?: number; className?: string }) => (
  <I {...p}><circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 5 5" /><path d="M10.5 7.5v6" /><path d="M7.5 10.5h6" /></I>
);
export const IconZoomOut = (p: { size?: number; className?: string }) => (
  <I {...p}><circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 5 5" /><path d="M7.5 10.5h6" /></I>
);
export const IconPanelRight = (p: { size?: number; className?: string }) => (
  <I {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></I>
);
export const IconDownload = (p: { size?: number; className?: string }) => (
  <I {...p}><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" /></I>
);
export const IconSave = (p: { size?: number; className?: string }) => (
  <I {...p}><path d="M5 3h11l3 3v15H5z" /><path d="M8 3v6h7V3" /><path d="M8 21v-6h8v6" /></I>
);
export const IconFolderOpen = (p: { size?: number; className?: string }) => (
  <I {...p}><path d="M3 7h6l2 2h9v10H3z" /><path d="M3 7V5h6l2 2" /></I>
);
export const IconImage = (p: { size?: number; className?: string }) => (
  <I {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="8.5" cy="9.5" r="1.5" /><path d="m21 16-5-5-6 6-3-3-4 4" /></I>
);
export const IconSwap = (p: { size?: number; className?: string }) => (
  <I {...p}><path d="M7 4 3 8l4 4" /><path d="M3 8h13" /><path d="m17 20 4-4-4-4" /><path d="M21 16H8" /></I>
);
export const IconClose = (p: { size?: number; className?: string }) => (
  <I {...p}><path d="M6 6l12 12" /><path d="M18 6 6 18" /></I>
);
export const IconChevron = (p: { size?: number; className?: string }) => (
  <I {...p}><path d="m6 9 6 6 6-6" /></I>
);
export const IconLayers = (p: { size?: number; className?: string }) => (
  <I {...p}><path d="m12 3 9 5-9 5-9-5 9-5Z" /><path d="m3 13 9 5 9-5" /><path d="m3 18 9 5 9-5" /></I>
);
export const IconNavigator = (p: { size?: number; className?: string }) => (
  <I {...p}><circle cx="12" cy="12" r="8" /><path d="m15.5 8.5-2 5-5 2 2-5 5-2Z" /></I>
);
export const IconBrush = (p: { size?: number; className?: string }) => (
  <I {...p}><path d="m14 4 6 6-8 8H6v-6l8-8Z" /><path d="m13 5 6 6" /></I>
);
export const IconEraser = (p: { size?: number; className?: string }) => (
  <I {...p}><path d="m7 20-3-3a2 2 0 0 1 0-3L13 5a2 2 0 0 1 3 0l5 5a2 2 0 0 1 0 3l-6 7H7Z" /><path d="m10 9 6 6" /></I>
);
export const IconPalette = (p: { size?: number; className?: string }) => (
  <I {...p}><path d="M12 3a9 9 0 1 0 0 18c1.7 0 2-1.2 1.2-2.2-.9-1.1 0-2.8 1.5-2.8H17a4 4 0 0 0 4-4c0-5-4-9-9-9Z" /><circle cx="7.5" cy="10" r="1" /><circle cx="11" cy="7" r="1" /><circle cx="15.5" cy="8.5" r="1" /></I>
);
