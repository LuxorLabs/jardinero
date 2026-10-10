import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import type { Store } from './store.js';
import { type StoreFixture, createTestStore } from '../testing/store.js';

let fixture: StoreFixture;
let store: Store;

beforeEach(() => {
  fixture = createTestStore();
  store = fixture.store;
});

afterEach(() => {
  fixture.cleanup();
});

describe('Store.getHostBlock', () => {
  test('When nothing is stored then should return nothing', () => {
    assert.equal(store.getHostBlock(), undefined);
  });

  test('When a block was written then should return it', () => {
    store.setHostBlock({ reason: 'codex_auth_revoked', authFingerprint: 'dead' });

    const block = store.getHostBlock();
    assert.equal(block?.reason, 'codex_auth_revoked');
    assert.equal(block?.authFingerprint, 'dead');
    assert.equal(typeof block?.createdAt, 'number');
    assert.equal(block?.updatedAt, block?.createdAt);
  });
});

describe('Store.setHostBlock', () => {
  test('When the same block is written again then should leave the created time', () => {
    store.setHostBlock({ reason: 'codex_auth_revoked', authFingerprint: 'dead' });
    const first = store.getHostBlock();
    store.setHostBlock({ reason: 'codex_auth_revoked', authFingerprint: 'dead' });

    assert.deepEqual(store.getHostBlock(), first);
  });

  test('When the fingerprint changes then should replace the block', () => {
    store.setHostBlock({ reason: 'codex_auth_revoked', authFingerprint: 'dead' });
    const first = store.getHostBlock();
    store.setHostBlock({ reason: 'codex_auth_revoked', authFingerprint: 'still-dead' });

    const next = store.getHostBlock();
    assert.equal(next?.authFingerprint, 'still-dead');
    assert.equal(next?.createdAt, first?.createdAt);
    assert.ok((next?.updatedAt ?? 0) >= (first?.updatedAt ?? 0));
  });
});

describe('Store.clearHostBlock', () => {
  test('When a block is stored then should remove it', () => {
    store.setHostBlock({ reason: 'codex_auth_revoked', authFingerprint: 'dead' });

    store.clearHostBlock();

    assert.equal(store.getHostBlock(), undefined);
  });

  test('When nothing is stored then should change nothing', () => {
    store.clearHostBlock();

    assert.equal(store.getHostBlock(), undefined);
  });
});
