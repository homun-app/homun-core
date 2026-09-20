import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as client from '../apps/web/src/lib/engine-client.ts';

test('source subscribers update together and unsubscribe cleanly', () => {
  const values = new Map<string, string>();
  const fake = new EventTarget() as EventTarget & { localStorage: unknown };
  fake.localStorage = { getItem: (key: string) => values.get(key), setItem: (key: string, value: string) => values.set(key, value) };
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { value: fake, configurable: true });
  try {
    const seenA: string[] = [], seenB: string[] = [];
    const stopA = client.subscribeEngineDataSource(() => seenA.push(client.readEngineDataSource()));
    const stopB = client.subscribeEngineDataSource(() => seenB.push(client.readEngineDataSource()));
    client.writeEngineDataSource('simulation');
    assert.deepEqual(seenA, ['simulation']);
    assert.deepEqual(seenB, ['simulation']);
    stopA();
    client.writeEngineDataSource('engine');
    assert.deepEqual(seenA, ['simulation']);
    assert.deepEqual(seenB, ['simulation', 'engine']);
    fake.dispatchEvent(new Event('storage'));
    assert.deepEqual(seenB, ['simulation', 'engine', 'engine']);
    stopB();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
