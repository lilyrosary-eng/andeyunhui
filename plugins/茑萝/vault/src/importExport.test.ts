// 导入导出字段适配单测：真实导出的脏数据形态（BOM/CRLF/引号内换行/字段内逗号）与四种格式识别。
import { describe, expect, it } from 'vitest';
import { parseCsv, parseImport, toBitwardenCsv, toChromeCsv, totpSecretOf } from './importExport';

describe('parseCsv', () => {
  it('处理 CRLF、引号内逗号与换行、双引号转义', () => {
    const text = '\uFEFFname,url,username,password,note\r\n' +
      '"GitHub","https://github.com","me","p@ss,word","多行\r\n备注 ""引号"""\r\n';
    const rows = parseCsv(text);
    expect(rows).toHaveLength(2);
    expect(rows[1][0]).toBe('GitHub');
    expect(rows[1][3]).toBe('p@ss,word');
    expect(rows[1][4]).toBe('多行\r\n备注 "引号"');
  });
});

describe('parseImport', () => {
  it('识别 Bitwarden 并映射 TOTP/收藏', () => {
    const csv = [
      'folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp',
      '工作,1,login,GitHub,备注,,0,https://github.com,me,secret,otpauth://totp/GitHub?secret=JBSWY3DPEHPK3PXP',
      ',0,note,普通笔记,内容,,0,,,,',
    ].join('\n');
    const parsed = parseImport(csv);
    expect(parsed.format).toBe('bitwarden');
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0].title).toBe('GitHub');
    expect(parsed.items[0].favorite).toBe(true);
    expect(parsed.items[0].totpSecret).toBe('JBSWY3DPEHPK3PXP');
    expect(parsed.items[1].kind).toBe('secureNote');
  });

  it('识别 Chrome/Edge', () => {
    const csv = ['name,url,username,password,note', 'B站,https://bilibili.com,user,pw,'].join('\n');
    const parsed = parseImport(csv);
    expect(parsed.format).toBe('chrome');
    expect(parsed.items[0].urls).toEqual(['https://bilibili.com']);
  });

  it('识别 KeePass 与 1Password', () => {
    const keepass = ['"Group","Title","Username","Password","URL","Notes"', '"Root","Mail","a","b","https://mail.example","n"'].join('\n');
    expect(parseImport(keepass).format).toBe('keepass');
    expect(parseImport(keepass).items[0].title).toBe('Mail');

    const onepassword = ['Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes', 'X,https://x.test,u,p,otpauth://totp/X?secret=ABC234,0,0,"a,b",'].join('\n');
    const parsed = parseImport(onepassword);
    expect(parsed.format).toBe('onePassword');
    expect(parsed.items[0].totpSecret).toBe('ABC234');
    expect(parsed.items[0].tags).toEqual(['a', 'b']);
  });

  it('JSON 导入保留字段并重置 id', () => {
    const json = JSON.stringify({
      items: [{ title: 'A', username: 'u', password: 'p', kind: 'apiKey', id: 'old', history: [{ atMs: 1 }] }],
    });
    const parsed = parseImport(json);
    expect(parsed.format).toBe('json');
    expect(parsed.items[0].id).toBe('');
    expect(parsed.items[0].history).toEqual([]);
    expect(parsed.items[0].kind).toBe('apiKey');
  });

  it('全空行直接忽略；有内容但无标题/账号/密码的行计入 skipped', () => {
    const csv = [
      'name,url,username,password,note',
      ',,,,',
      ',https://example.test,,,只有网址',
    ].join('\n');
    const parsed = parseImport(csv);
    expect(parsed.items).toHaveLength(0);
    expect(parsed.skipped).toBe(1);
  });
});

describe('导出', () => {
  it('Bitwarden CSV 可被自己再解析回来', () => {
    const csv = toBitwardenCsv([
      {
        id: '1',
        kind: 'login',
        title: '含,逗号 "引号"',
        username: 'u',
        password: 'p,w',
        urls: ['https://a.test'],
        fields: [],
        notes: '多行\n备注',
        totpSecret: 'JBSWY3DPEHPK3PXP',
        tags: ['工作'],
        favorite: true,
        createdAtMs: 1,
        updatedAtMs: 2,
        lastUsedAtMs: 0,
        deletedAtMs: null,
        history: [],
      },
    ]);
    const parsed = parseImport(csv);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].title).toBe('含,逗号 "引号"');
    expect(parsed.items[0].password).toBe('p,w');
    expect(parsed.items[0].notes).toBe('多行\n备注');
    expect(parsed.items[0].totpSecret).toBe('JBSWY3DPEHPK3PXP');
  });

  it('Chrome CSV 表头固定', () => {
    expect(toChromeCsv([])).toBe('name,url,username,password,note');
  });
});

describe('totpSecretOf', () => {
  it('从 otpauth URI 提取 secret，其余原样返回', () => {
    expect(totpSecretOf('otpauth://totp/L?secret=ABC234&issuer=X')).toBe('ABC234');
    expect(totpSecretOf('JBSWY3DP')).toBe('JBSWY3DP');
    expect(totpSecretOf('')).toBe('');
  });
});
