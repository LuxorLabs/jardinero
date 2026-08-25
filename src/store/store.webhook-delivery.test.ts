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

describe('Store.recordWebhookDelivery', () => {
  // A provider redelivers the same id, and answering false is what makes the second
  // arrival a no-op instead of a second run.
  const cases: Array<{
    name: string;
    seenTtlMs?: number;
    providerName: string;
    deliveryId: string;
    payload?: string;
    want: { recorded: boolean; storedPayload: string | null };
  }> = [
    {
      name: 'When the delivery is new then should record it',
      providerName: 'github',
      deliveryId: 'delivery-2',
      want: { recorded: true, storedPayload: null },
    },
    {
      name: 'When the delivery was already seen then should refuse it',
      providerName: 'github',
      deliveryId: 'delivery-1',
      want: { recorded: false, storedPayload: null },
    },
    {
      // Two providers number their deliveries independently, so the pair is the key.
      name: 'When another provider used the same id then should record it',
      providerName: 'linear',
      deliveryId: 'delivery-1',
      want: { recorded: true, storedPayload: null },
    },
    {
      // Nothing else keeps a copy of what a provider sent.
      name: 'When the delivery carries what arrived then should keep it with it',
      providerName: 'linear',
      deliveryId: 'delivery-2',
      payload: '{"action":"created"}',
      want: { recorded: true, storedPayload: '{"action":"created"}' },
    },
    {
      name: 'When what was seen expired then should record it again',
      seenTtlMs: 0,
      providerName: 'github',
      deliveryId: 'delivery-1',
      want: { recorded: true, storedPayload: null },
    },
  ];

  for (const testCase of cases) {
    test(testCase.name, () => {
      store.recordWebhookDelivery('github', 'delivery-1', testCase.seenTtlMs ?? 60_000);

      const recorded = store.recordWebhookDelivery(
        testCase.providerName,
        testCase.deliveryId,
        60_000,
        testCase.payload,
      );

      assert.equal(recorded, testCase.want.recorded);
      assert.equal(
        store.db
          .prepare(
            'SELECT payload FROM webhook_delivery WHERE provider_name = ? AND provider_delivery_id = ?',
          )
          .get(testCase.providerName, testCase.deliveryId)?.payload,
        testCase.want.storedPayload,
      );
    });
  }
});
