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

describe('Store.saveDiscordConversation', () => {
  const cases: Array<{ name: string; conversationKey: string; wantThreadId: string }> = [
    {
      name: 'When the work has no conversation then should open one',
      conversationKey: 'work-2',
      wantThreadId: 'thread-2',
    },
    {
      name: 'When the work already has one then should keep the thread it kept',
      conversationKey: 'work-1',
      wantThreadId: 'thread-1',
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      store.saveDiscordConversation({ conversationKey: 'work-1', threadId: 'thread-1' });

      const saved = store.saveDiscordConversation({
        conversationKey: testCase.conversationKey,
        threadId: 'thread-2',
      });

      assert.equal(saved.conversationKey, testCase.conversationKey);
      assert.equal(saved.threadId, testCase.wantThreadId);
      assert.ok(saved.createdAt > 0);
    });
  }
});

describe('Store.findDiscordConversationByThread', () => {
  const cases: Array<{ name: string; threadId: string; wantConversationKey?: string }> = [
    {
      // A command run inside a thread is only told the thread, so this is what says what it
      // was asked about.
      name: 'When a thread follows a piece of work then should answer which',
      threadId: 'thread-1',
      wantConversationKey: 'work-1',
    },
    {
      name: 'When the thread is not one of ours then should answer nothing',
      threadId: 'thread-404',
      wantConversationKey: undefined,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      store.saveDiscordConversation({ conversationKey: 'work-1', threadId: 'thread-1' });

      assert.equal(
        store.findDiscordConversationByThread(testCase.threadId)?.conversationKey,
        testCase.wantConversationKey,
      );
    });
  }
});

describe('Store.findDiscordConversation', () => {
  const cases: Array<{ name: string; conversationKey: string; wantThreadId?: string }> = [
    {
      name: 'When the work is talked about somewhere then should answer where',
      conversationKey: 'work-1',
      wantThreadId: 'thread-1',
    },
    {
      name: 'When nothing was ever said about it then should answer nothing',
      conversationKey: 'work-404',
      wantThreadId: undefined,
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      store.saveDiscordConversation({ conversationKey: 'work-1', threadId: 'thread-1' });

      assert.equal(
        store.findDiscordConversation(testCase.conversationKey)?.threadId,
        testCase.wantThreadId,
      );
    });
  }
});
