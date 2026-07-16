// Univer 外部依赖入口：打包为 IIFE，挂载到 window.__EXT_UNIVER__
// react / react-dom / react-dom/client 由 build-external-deps.mjs 外部化到宿主全局
// （__HOST_REACT__ / __HOST_REACT_DOM__），与插件沙箱共享同一 React 实例。
//
// Univer 是全栈办公套件引擎（Apache-2.0），支持表格 / 文档 / 演示文稿。
// 当前打包表格全量专业预设（核心 + 筛选 + 查找替换 + 排序 + 条件格式 + 数据验证
// + 批注 + 笔记 + 表格 + 绘图 + 超链接），达到 WPS 级专业表格能力。
import { createUniver, LocaleType, mergeLocales } from '@univerjs/presets';

// ===== 核心 =====
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core';
import coreZhCN from '@univerjs/preset-sheets-core/locales/zh-CN';
import coreCss from '@univerjs/preset-sheets-core/lib/index.css';

// ===== 专业预设 =====
import { UniverSheetsFilterPreset } from '@univerjs/preset-sheets-filter';
import filterZhCN from '@univerjs/preset-sheets-filter/locales/zh-CN';
import filterCss from '@univerjs/preset-sheets-filter/lib/index.css';

import { UniverSheetsFindReplacePreset } from '@univerjs/preset-sheets-find-replace';
import findReplaceZhCN from '@univerjs/preset-sheets-find-replace/locales/zh-CN';
import findReplaceCss from '@univerjs/preset-sheets-find-replace/lib/index.css';

import { UniverSheetsSortPreset } from '@univerjs/preset-sheets-sort';
import sortZhCN from '@univerjs/preset-sheets-sort/locales/zh-CN';
import sortCss from '@univerjs/preset-sheets-sort/lib/index.css';

import { UniverSheetsConditionalFormattingPreset } from '@univerjs/preset-sheets-conditional-formatting';
import cfZhCN from '@univerjs/preset-sheets-conditional-formatting/locales/zh-CN';
import cfCss from '@univerjs/preset-sheets-conditional-formatting/lib/index.css';

import { UniverSheetsDataValidationPreset } from '@univerjs/preset-sheets-data-validation';
import dvZhCN from '@univerjs/preset-sheets-data-validation/locales/zh-CN';
import dvCss from '@univerjs/preset-sheets-data-validation/lib/index.css';

import { UniverSheetsThreadCommentPreset } from '@univerjs/preset-sheets-thread-comment';
import tcZhCN from '@univerjs/preset-sheets-thread-comment/locales/zh-CN';
import tcCss from '@univerjs/preset-sheets-thread-comment/lib/index.css';

import { UniverSheetsNotePreset } from '@univerjs/preset-sheets-note';
import noteZhCN from '@univerjs/preset-sheets-note/locales/zh-CN';
import noteCss from '@univerjs/preset-sheets-note/lib/index.css';

import { UniverSheetsTablePreset } from '@univerjs/preset-sheets-table';
import tableZhCN from '@univerjs/preset-sheets-table/locales/zh-CN';
import tableCss from '@univerjs/preset-sheets-table/lib/index.css';

import { UniverSheetsDrawingPreset } from '@univerjs/preset-sheets-drawing';
import drawingZhCN from '@univerjs/preset-sheets-drawing/locales/zh-CN';
import drawingCss from '@univerjs/preset-sheets-drawing/lib/index.css';

import { UniverSheetsHyperLinkPreset } from '@univerjs/preset-sheets-hyper-link';
import hyperLinkZhCN from '@univerjs/preset-sheets-hyper-link/locales/zh-CN';
import hyperLinkCss from '@univerjs/preset-sheets-hyper-link/lib/index.css';

// ===== 合并所有 CSS 并注入 <style>（仅注入一次） =====
const allCss = [
  coreCss, filterCss, findReplaceCss, sortCss, cfCss,
  dvCss, tcCss, noteCss, tableCss, drawingCss, hyperLinkCss,
].join('\n');
if (allCss && typeof document !== 'undefined') {
  // 移除旧样式（热更新场景）
  const old = document.querySelector('style[data-univer]');
  if (old) old.remove();
  const style = document.createElement('style');
  style.setAttribute('data-univer', 'sheets-full');
  style.textContent = allCss;
  document.head.appendChild(style);
}

// ===== 预合并所有中文 locale（减少运行时开销） =====
const mergedZhCN = mergeLocales(
  coreZhCN, filterZhCN, findReplaceZhCN, sortZhCN, cfZhCN,
  dvZhCN, tcZhCN, noteZhCN, tableZhCN, drawingZhCN, hyperLinkZhCN,
);

window.__EXT_UNIVER__ = {
  createUniver,
  LocaleType,
  mergeLocales,
  // 核心预设
  UniverSheetsCorePreset,
  // 专业预设
  UniverSheetsFilterPreset,
  UniverSheetsFindReplacePreset,
  UniverSheetsSortPreset,
  UniverSheetsConditionalFormattingPreset,
  UniverSheetsDataValidationPreset,
  UniverSheetsThreadCommentPreset,
  UniverSheetsNotePreset,
  UniverSheetsTablePreset,
  UniverSheetsDrawingPreset,
  UniverSheetsHyperLinkPreset,
  // 预合并的中文 locale
  sheetsZhCN: mergedZhCN,
};
