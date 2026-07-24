import { readFileSync, writeFileSync } from 'fs';
const p = 'c:/Users/Rosary/Desktop/andeyunhui/index.html';
let s = readFileSync(p, 'utf8');
const oldLine = "        // 兜底（双保险）：窗口 load 即收尾；若 8s 内仍未主动完成（如启动异常），强制结束，绝不卡在加载层\n";
const newLine = "        // 主窗口门控：load 事件仅标记「底层已加载」，真正收尾由主窗口 finishBoot 置 gate 后触发；8s 硬超时仍是最后兜底\n";
if (!s.includes(oldLine)) { console.error('COMMENT NOT FOUND'); process.exit(2); }
s = s.replace(oldLine, newLine);
writeFileSync(p, s);
console.log('OK comment fixed');
