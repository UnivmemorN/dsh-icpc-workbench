/**
 * Account naming and the public Luogu nickname flow (Sprint Contract 22b2).
 *
 * These tests pin the labels the accounts page, the header selector and the Luogu panel derive, and
 * the one asynchronous flow that reads `luogu.profile` through an injected port: cancellation wins
 * at every await boundary, an answer for another account is never applied, and a refusal is always a
 * fixed short sentence that cannot echo server or platform text.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LUOGU_FALLBACK_NAME,
  NICKNAME_FAILURE_FALLBACK,
  NICKNAME_LOOKUP_MISMATCH,
  accountListLabels,
  accountOptionLabel,
  currentAccountNote,
  lookupLuoguNickname,
  luoguNickname,
  luoguPrimaryName,
  luoguUidLabel,
  needsLuoguNickname,
  nicknameFailureText,
  sourceOfAccount,
} from '../../src/ui/account-name.js';
import type { ApiAccountView } from '../../src/application/workbench-api.js';

/** One Luogu account view with the contract's default shape. */
function luoguAccount(overrides: Partial<ApiAccountView> = {}): ApiAccountView {
  return {
    id: 'luogu:www.luogu.com.cn|123456',
    sourceInstanceId: 'luogu:www.luogu.com.cn',
    handle: '123456',
    displayName: null,
    profileUrl: 'https://www.luogu.com.cn/user/123456',
    ...overrides,
  };
}

/** A promise plus its resolver, for tests that answer after an explicit cancellation. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

void test('a missing, empty or UID-equal display name never becomes a nickname', () => {
  for (const displayName of [null, '', '   ', '123456', '  123456 ']) {
    const account = luoguAccount({ displayName });
    assert.equal(luoguNickname(account), null, JSON.stringify(displayName));
    assert.equal(luoguPrimaryName(account), LUOGU_FALLBACK_NAME);
    assert.notEqual(luoguPrimaryName(account), account.handle);
    assert.equal(needsLuoguNickname(account, 'luogu'), true);
  }
});

void test('a distinct nickname is trimmed and shown next to the explicit UID', () => {
  const account = luoguAccount({ displayName: '  示例昵称  ' });
  assert.equal(luoguNickname(account), '示例昵称');
  assert.equal(luoguPrimaryName(account), '示例昵称');
  assert.equal(luoguUidLabel(account.handle), 'UID 123456');
  assert.equal(needsLuoguNickname(account, 'luogu'), false);
});

void test('duplicate nicknames stay distinguishable by UID in list and header', () => {
  const first = luoguAccount({ id: 'a', handle: '111', displayName: '同名人' });
  const second = luoguAccount({ id: 'b', handle: '222', displayName: '同名人' });
  const source = { platform: 'luogu', displayName: 'Luogu' };
  assert.equal(accountOptionLabel(first, source), '同名人 · UID 111 · 洛谷');
  assert.equal(accountOptionLabel(second, source), '同名人 · UID 222 · 洛谷');
  assert.notEqual(accountOptionLabel(first, source), accountOptionLabel(second, source));
  assert.deepEqual(accountListLabels(first, 'luogu', 'Luogu'), {
    primary: '同名人',
    secondary: 'Luogu · UID 111',
  });
  assert.equal(currentAccountNote(first, 'luogu', 'Luogu'), 'Luogu · UID 111');
});

void test('a Luogu account without a nickname states the UID separately, never as the name', () => {
  const account = luoguAccount({ displayName: null });
  assert.deepEqual(accountListLabels(account, 'luogu', 'Luogu'), {
    primary: LUOGU_FALLBACK_NAME,
    secondary: 'Luogu · UID 123456',
  });
  assert.equal(accountOptionLabel(account, { platform: 'luogu', displayName: 'Luogu' }), '洛谷用户 · UID 123456 · 洛谷');
});

void test('Codeforces labels and eligibility are unchanged', () => {
  const named: ApiAccountView = {
    id: 'codeforces:codeforces.com|tourist',
    sourceInstanceId: 'codeforces:codeforces.com',
    handle: 'tourist',
    displayName: 'Tourist',
    profileUrl: 'https://codeforces.com/profile/Tourist',
  };
  assert.deepEqual(accountListLabels(named, 'codeforces', 'Codeforces'), {
    primary: 'Tourist',
    secondary: 'Codeforces · tourist',
  });
  assert.equal(currentAccountNote(named, 'codeforces', 'Codeforces'), 'Codeforces');
  assert.equal(accountOptionLabel(named, { platform: 'codeforces', displayName: 'Codeforces' }), 'Tourist · codeforces');
  assert.equal(needsLuoguNickname(named, 'codeforces'), false);
  // The historical fallback for a Codeforces account without a stored display name still applies.
  const bare = { ...named, displayName: null };
  assert.deepEqual(accountListLabels(bare, 'codeforces', 'Codeforces'), {
    primary: 'tourist',
    secondary: 'Codeforces · tourist',
  });
  assert.equal(accountOptionLabel(bare, { platform: 'codeforces', displayName: 'Codeforces' }), 'tourist · codeforces');
});

void test('the platform comes from the real source list, never from the opaque instance id', () => {
  const sources = [
    { id: 'luogu:www.luogu.com.cn', platform: 'luogu', displayName: 'Luogu' },
    { id: 'codeforces:codeforces.com', platform: 'codeforces', displayName: 'Codeforces' },
  ];
  assert.equal(sourceOfAccount(sources, luoguAccount())?.platform, 'luogu');
  assert.equal(sourceOfAccount(sources, { sourceInstanceId: 'hydro:example.edu' }), null);
  // A Luogu-looking id with no resolved source is not enough to start a lookup.
  assert.equal(needsLuoguNickname(luoguAccount(), null), false);
});

void test('a successful lookup returns the stored nickname', async () => {
  const controller = new AbortController();
  const outcome = await lookupLuoguNickname(
    'luogu:www.luogu.com.cn|123456',
    async (accountId, signal) => {
      assert.equal(accountId, 'luogu:www.luogu.com.cn|123456');
      assert.equal(signal, controller.signal);
      return luoguAccount({ displayName: '示例昵称' });
    },
    controller.signal,
  );
  assert.deepEqual(outcome, { status: 'refreshed', nickname: '示例昵称' });
});

void test('a successful lookup without a distinct nickname refreshes with a null nickname', async () => {
  const outcome = await lookupLuoguNickname(
    'luogu:www.luogu.com.cn|123456',
    async () => luoguAccount({ displayName: '123456' }),
    new AbortController().signal,
  );
  assert.deepEqual(outcome, { status: 'refreshed', nickname: null });
});

void test('a cancelled caller performs no read at all', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const outcome = await lookupLuoguNickname(
    'luogu:www.luogu.com.cn|123456',
    async () => {
      calls += 1;
      return luoguAccount({ displayName: '迟到' });
    },
    controller.signal,
  );
  assert.deepEqual(outcome, { status: 'aborted' });
  assert.equal(calls, 0);
});

void test('an answer that settles after cancellation is dropped, not applied', async () => {
  const controller = new AbortController();
  const gate = deferred();
  const pending = lookupLuoguNickname(
    'luogu:www.luogu.com.cn|123456',
    async () => {
      await gate.promise;
      return luoguAccount({ displayName: '迟到昵称' });
    },
    controller.signal,
  );
  controller.abort();
  gate.resolve();
  assert.deepEqual(await pending, { status: 'aborted' });
});

void test('a refusal that raced a cancellation is an abort, not a failure', async () => {
  const controller = new AbortController();
  const outcome = await lookupLuoguNickname(
    'luogu:www.luogu.com.cn|123456',
    async () => {
      controller.abort();
      throw Object.assign(new Error('transport'), { code: 'conflict' });
    },
    controller.signal,
  );
  assert.deepEqual(outcome, { status: 'aborted' });
});

void test('an answer for another account is refused instead of applied', async () => {
  const outcome = await lookupLuoguNickname(
    'luogu:www.luogu.com.cn|123456',
    async () => luoguAccount({ id: 'luogu:www.luogu.com.cn|999999' }),
    new AbortController().signal,
  );
  assert.deepEqual(outcome, { status: 'failed', reason: NICKNAME_LOOKUP_MISMATCH });
});

void test('a refusal is a fixed short reason that never echoes server text', async () => {
  const marker = 'PRIVATE_PROFILE_MARKER_7c41f0';
  const outcome = await lookupLuoguNickname(
    'luogu:www.luogu.com.cn|123456',
    async () => {
      throw Object.assign(new Error(marker), { code: 'conflict' });
    },
    new AbortController().signal,
  );
  assert.equal(outcome.status, 'failed');
  if (outcome.status !== 'failed') throw new Error('unreachable');
  assert.equal(outcome.reason, nicknameFailureText({ code: 'conflict' }));
  assert.doesNotMatch(outcome.reason, new RegExp(marker));
  assert.match(outcome.reason, /稍后重试/);
});

void test('only known transport codes get a named reason; everything else is neutral', () => {
  assert.match(nicknameFailureText({ code: 'cancelled' }), /取消/);
  assert.match(nicknameFailureText({ code: 'not_found' }), /账号/);
  assert.match(nicknameFailureText({ code: 'network_error' }), /dsh/);
  assert.equal(nicknameFailureText(null), NICKNAME_FAILURE_FALLBACK);
  assert.equal(nicknameFailureText(new Error('boom')), NICKNAME_FAILURE_FALLBACK);
  assert.equal(nicknameFailureText({ code: 'not_a_code' }), NICKNAME_FAILURE_FALLBACK);
  assert.equal(nicknameFailureText({ code: 42 }), NICKNAME_FAILURE_FALLBACK);
});
