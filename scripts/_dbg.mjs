import fs from 'node:fs';
const f = 'c:/Users/Rosary/Desktop/andeyunhui/plugins/_shared/icons.ts';
const s = fs.readFileSync(f, 'utf8');
const line = s.split('\n').find((l) => l.includes('__HOST_REACT__'));
console.log('LINE:', JSON.stringify(line));
console.log('CODES:', [...line].map((c) => c.charCodeAt(0)).join(','));
const re = /const React = window\.__HOST_REACT__(?: as any)?;\r?\n/;
console.log('TEST:', re.test(s));
console.log('MATCH:', JSON.stringify(s.match(re)));
// try a looser regex
const re2 = /const\s+React\s*=\s*window\.__HOST_REACT__.*\n/;
console.log('TEST2:', re2.test(s), 'MATCH2:', JSON.stringify(s.match(re2)));
