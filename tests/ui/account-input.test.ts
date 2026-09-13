/**
 * Add-account onboarding rules (Sprint Contract 08a).
 *
 * The form must accept the bare identifier and the official profile URL while refusing every
 * look-alike link. These tests pin the pure decision `App.tsx` renders, so no DOM and no network are
 * needed to prove that a deceptive host, a credential URL or a malformed UID never reaches the
 * business API.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ACCOUNT_GUIDES,
  ACCOUNT_SAVE_NOTE,
  checkAccountInput,
  type AccountInputCheck,
  type AccountPlatform,
} from '../../src/ui/account-input.js';

/** Narrow to the accepted branch, failing loudly with the actual check otherwise. */
function valid(check: AccountInputCheck): { handle: string; viaProfileUrl: boolean } {
  assert.equal(check.state, 'valid', `expected a valid check, got ${JSON.stringify(check)}`);
  if (check.state !== 'valid') throw new Error('unreachable');
  return { handle: check.handle, viaProfileUrl: check.viaProfileUrl };
}

/** Narrow to the refusal branch and return its actionable message. */
function message(check: AccountInputCheck): string {
  assert.equal(check.state, 'invalid', `expected an invalid check, got ${JSON.stringify(check)}`);
  if (check.state !== 'invalid') throw new Error('unreachable');
  return check.message;
}

void test('an empty field is not an error', () => {
  assert.deepEqual(checkAccountInput('codeforces', ''), { state: 'empty' });
  assert.deepEqual(checkAccountInput('luogu', '   '), { state: 'empty' });
});

void test('a bare Codeforces handle is trimmed and its display spelling is preserved', () => {
  assert.deepEqual(valid(checkAccountInput('codeforces', '  tourist \n')), { handle: 'tourist', viaProfileUrl: false });
  // The adapter lowercases identity, but the user's spelling travels to it as the display name.
  assert.deepEqual(valid(checkAccountInput('codeforces', 'Petr')), { handle: 'Petr', viaProfileUrl: false });
  assert.deepEqual(valid(checkAccountInput('codeforces', 'a_b.c-1')), { handle: 'a_b.c-1', viaProfileUrl: false });
  const longest = 'x'.repeat(24);
  assert.deepEqual(valid(checkAccountInput('codeforces', longest)), { handle: longest, viaProfileUrl: false });
});

void test('a Codeforces profile URL yields the handle and ignores query, hash and trailing slash', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['https://codeforces.com/profile/tourist', 'tourist'],
    ['https://www.codeforces.com/profile/tourist/', 'tourist'],
    ['http://codeforces.com/profile/Petr/?locale=en#x', 'Petr'],
    ['HTTPS://CODEFORCES.COM/profile/tourist', 'tourist'],
    ['  https://codeforces.com/profile/a_b.c-1#top  ', 'a_b.c-1'],
  ];
  for (const [url, handle] of cases) {
    assert.deepEqual(valid(checkAccountInput('codeforces', url)), { handle, viaProfileUrl: true }, url);
  }
});

void test('an invalid Codeforces identifier is refused with the platform rule', () => {
  for (const bad of ['ab', 'x'.repeat(25), 'tourist@example.com', 'tour ist', 'tourist!', '用户名']) {
    assert.match(message(checkAccountInput('codeforces', bad)), /Handle/, bad);
  }
});

void test('a bare Luogu UID is trimmed and must stay canonical', () => {
  assert.deepEqual(valid(checkAccountInput('luogu', ' 123456 ')), { handle: '123456', viaProfileUrl: false });
  const longest = '9'.repeat(20);
  assert.deepEqual(valid(checkAccountInput('luogu', longest)), { handle: longest, viaProfileUrl: false });
  for (const bad of ['0', '007', '1 23', '+123', '-1', '1.5', 'abc', '１２３', '123456789012345678901']) {
    assert.match(message(checkAccountInput('luogu', bad)), /UID/, bad);
  }
});

void test('a Luogu profile URL yields the canonical UID', () => {
  const cases: readonly string[] = [
    'https://www.luogu.com.cn/user/123456',
    'https://www.luogu.com.cn/user/123456/',
    'https://luogu.com.cn/user/123456?tab=records#x',
    'http://www.luogu.com.cn/user/123456',
  ];
  for (const url of cases) {
    assert.deepEqual(valid(checkAccountInput('luogu', url)), { handle: '123456', viaProfileUrl: true }, url);
  }
});

void test('only http(s) on an exact official host is accepted', () => {
  assert.match(message(checkAccountInput('codeforces', 'ftp://codeforces.com/profile/tourist')), /只支持 http\(s\)/);
  assert.match(message(checkAccountInput('codeforces', 'javascript:alert(1)')), /只支持 http\(s\)/);
  assert.match(message(checkAccountInput('codeforces', 'codeforces.com/profile/tourist')), /https:\/\//);
  for (const host of [
    'codeforces.com.evil.example',
    'evilcodeforces.com',
    'm.codeforces.com',
    'codeforces.com.cn',
    'www.codeforces.com.evil',
    'luogu.com.cn.evil.example',
    'luogu.com',
  ]) {
    assert.match(
      message(checkAccountInput(host.startsWith('luogu') ? 'luogu' : 'codeforces', `https://${host}/profile/tourist`)),
      /官方站点/,
      host,
    );
  }
});

void test('credential URLs and explicit ports are refused, including the hidden default port', () => {
  assert.match(message(checkAccountInput('codeforces', 'https://user:pass@codeforces.com/profile/tourist')), /登录信息/);
  assert.match(message(checkAccountInput('codeforces', 'https://tourist@codeforces.com/profile/tourist')), /登录信息/);
  assert.match(message(checkAccountInput('codeforces', 'https://codeforces.com:8443/profile/tourist')), /端口/);
  // `new URL` strips `:443`; the raw authority check still refuses it.
  assert.match(message(checkAccountInput('codeforces', 'https://codeforces.com:443/profile/tourist')), /端口/);
});

void test('only the platform profile path is accepted', () => {
  for (const bad of [
    'https://codeforces.com/',
    'https://codeforces.com/contests',
    'https://codeforces.com/profile/',
    'https://codeforces.com/profile/tourist/submissions',
    'https://codeforces.com/user/123456',
    'https://codeforces.com/profile//tourist',
  ]) {
    assert.match(message(checkAccountInput('codeforces', bad)), /只支持个人主页链接/, bad);
  }
  for (const bad of ['https://www.luogu.com.cn/problem/P1000', 'https://www.luogu.com.cn/user/123456/records']) {
    assert.match(message(checkAccountInput('luogu', bad)), /只支持个人主页链接/, bad);
  }
});

void test('the other platform link names the platform to switch to', () => {
  assert.match(message(checkAccountInput('codeforces', 'https://www.luogu.com.cn/user/123456')), /洛谷/);
  assert.match(message(checkAccountInput('luogu', 'https://codeforces.com/profile/tourist')), /Codeforces/);
});

void test('encoded separators never smuggle a second path segment', () => {
  for (const bad of [
    'https://codeforces.com/profile/tourist%2Fextra',
    'https://codeforces.com/profile/tourist%2f..%2f..',
    'https://codeforces.com/profile/a%5Cb',
  ]) {
    assert.match(message(checkAccountInput('codeforces', bad)), /编码/, bad);
  }
});

void test('a URL whose identifier is malformed is refused by the platform rule', () => {
  assert.match(message(checkAccountInput('codeforces', 'https://codeforces.com/profile/ab')), /Handle/);
  assert.match(message(checkAccountInput('luogu', 'https://www.luogu.com.cn/user/0')), /UID/);
  assert.match(message(checkAccountInput('luogu', 'https://www.luogu.com.cn/user/007')), /UID/);
  assert.match(message(checkAccountInput('luogu', `https://www.luogu.com.cn/user/${'1'.repeat(21)}`)), /UID/);
  assert.match(message(checkAccountInput('luogu', 'https://www.luogu.com.cn/user/123456abc')), /UID/);
});

void test('every platform explains its own identifier and the neutral next step', () => {
  for (const platform of ['codeforces', 'luogu'] as const satisfies readonly AccountPlatform[]) {
    const guide = ACCOUNT_GUIDES[platform];
    assert.ok(guide.label.length > 0 && guide.placeholder.length > 0 && guide.help.length > 0, platform);
    assert.match(guide.placeholder, new RegExp(platform === 'codeforces' ? 'tourist' : '123456'));
  }
  assert.match(ACCOUNT_GUIDES.codeforces.help, /\/profile\//);
  assert.match(ACCOUNT_GUIDES.codeforces.help, /不是邮箱/);
  assert.match(ACCOUNT_GUIDES.luogu.help, /\/user\//);
  assert.match(ACCOUNT_GUIDES.luogu.help, /不是昵称/);
  assert.notEqual(ACCOUNT_GUIDES.codeforces.label, ACCOUNT_GUIDES.luogu.label);
  assert.match(ACCOUNT_SAVE_NOTE, /不需要密码/);
  assert.match(ACCOUNT_SAVE_NOTE, /不会自动同步/);
  assert.match(ACCOUNT_SAVE_NOTE, /导入或同步/);
});

void test('the example links are the contract examples, never submitted values', () => {
  assert.equal(ACCOUNT_GUIDES.codeforces.exampleUrl, 'https://codeforces.com/profile/tourist');
  assert.equal(ACCOUNT_GUIDES.luogu.exampleUrl, 'https://www.luogu.com.cn/user/123456');
  // Even the contract examples stay inert text: the form only ever submits what the user typed.
  for (const platform of ['codeforces', 'luogu'] as const) {
    const example = ACCOUNT_GUIDES[platform].exampleUrl;
    assert.notEqual(example, '');
  }
});
