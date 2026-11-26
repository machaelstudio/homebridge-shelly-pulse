'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');

const { ShellyRelay } = require('../lib/shelly');
const { startMockShelly } = require('./mock-shelly');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('identifies a Shelly 1 Gen4', async (t) => {
  const mock = await startMockShelly();
  t.after(() => mock.close());

  const found = await new ShellyRelay({ host: mock.host }).identify();

  assert.deepEqual(found, {
    id: 'shelly1g4-aabbccddeeff',
    mac: 'AABBCCDDEEFF',
    model: 'S1G4',
    generation: 4,
    firmware: '1.6.2',
  });
});

test('switches on with a flip-back timer that the device runs itself', async (t) => {
  const mock = await startMockShelly();
  t.after(() => mock.close());
  const relay = new ShellyRelay({ host: mock.host });

  await relay.set(true, 0.2);

  assert.deepEqual(mock.lastSet, { on: true, toggleAfter: 0.2 });
  assert.equal(await relay.isOn(), true);
  await sleep(300);
  assert.equal(await relay.isOn(), false);
});

test('switches on and off without a timer', async (t) => {
  const mock = await startMockShelly();
  t.after(() => mock.close());
  const relay = new ShellyRelay({ host: mock.host });

  await relay.set(true);
  assert.deepEqual(mock.lastSet, { on: true, toggleAfter: null });
  assert.equal(mock.output, true);

  await relay.set(false);
  assert.deepEqual(mock.lastSet, { on: false, toggleAfter: null });
  assert.equal(mock.output, false);
});

test('logs in to a password-protected device and keeps working', async (t) => {
  const mock = await startMockShelly({ password: 'open sesame' });
  t.after(() => mock.close());
  const relay = new ShellyRelay({ host: mock.host, password: 'open sesame' });

  await relay.set(true);
  assert.equal(await relay.isOn(), true);
  await relay.set(false);
  assert.equal(mock.output, false);

  // The device hands out a new challenge now and then.
  mock.expireChallenge();
  await relay.set(true);
  assert.equal(mock.output, true);
});

test('says so when the password is wrong', async (t) => {
  const mock = await startMockShelly({ password: 'open sesame' });
  t.after(() => mock.close());
  const relay = new ShellyRelay({ host: mock.host, password: 'wrong' });

  await assert.rejects(relay.set(true), /rejected the password/);
  assert.equal(mock.output, false);
});

test('says so when a password is needed and none is set', async (t) => {
  const mock = await startMockShelly({ password: 'open sesame' });
  t.after(() => mock.close());

  await assert.rejects(new ShellyRelay({ host: mock.host }).set(true), /is password protected/);
});

test('refuses a first-generation Shelly', async (t) => {
  const mock = await startMockShelly({ generation: 1 });
  t.after(() => mock.close());

  await assert.rejects(new ShellyRelay({ host: mock.host }).set(true), /first-generation Shelly/);
});

test('passes on the reason when the device refuses a command', async (t) => {
  const mock = await startMockShelly();
  t.after(() => mock.close());

  await assert.rejects(new ShellyRelay({ host: mock.host, channel: 3 }).set(true), /refused Switch\.Set \(Argument 'id', value 3 not found!\)/);
});

test('reports a device that is switched off or gone', async () => {
  const mock = await startMockShelly();
  await mock.close();

  await assert.rejects(new ShellyRelay({ host: mock.host }).isOn(), /cannot reach 127\.0\.0\.1/);
});

test('gives up on a device that accepts the connection and never answers', async (t) => {
  const silent = net.createServer(() => {});
  await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve));
  t.after(() => silent.close());
  const relay = new ShellyRelay({ host: `127.0.0.1:${silent.address().port}`, timeoutMs: 150 });

  const started = Date.now();
  await assert.rejects(relay.isOn(), /no answer from 127\.0\.0\.1:\d+ within 150 ms/);
  assert.ok(Date.now() - started < 1000);
});

test('rejects an address that is not one', async () => {
  await assert.rejects(new ShellyRelay({ host: 'not a host' }).isOn(), /is not a valid address/);
});
