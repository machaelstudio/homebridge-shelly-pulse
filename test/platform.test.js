'use strict';

// Runs the plugin against Homebridge's own API object and real HomeKit
// characteristics, with a simulated Shelly on the other side.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { ShellyPulsePlatform, readDevice } = require('../lib/platform');
const { startMockShelly } = require('./mock-shelly');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Homebridge does not export this class, so it is loaded by file path.
const apiModule = import(
  pathToFileURL(path.join(__dirname, '..', 'node_modules', 'homebridge', 'dist', 'api.js')).href
);

async function boot(t, devices, restored = []) {
  const { HomebridgeAPI } = await apiModule;
  const api = new HomebridgeAPI();
  const lines = [];
  const log = {};
  for (const level of ['debug', 'info', 'success', 'warn', 'error']) {
    log[level] = (message) => lines.push(`${level}: ${message}`);
  }
  const registered = [];
  const unregistered = [];
  api.on('registerPlatformAccessories', (accessories) => registered.push(...accessories));
  api.on('unregisterPlatformAccessories', (accessories) => unregistered.push(...accessories));

  const platform = new ShellyPulsePlatform(log, { platform: 'ShellyPulse', devices }, api);
  restored.forEach((accessory) => platform.configureAccessory(accessory));
  api.signalFinished();
  t.after(() => api.signalShutdown());

  const { Service, Characteristic, HAPStatus } = api.hap;
  return {
    api,
    lines,
    registered,
    unregistered,
    Characteristic,
    failure: HAPStatus.SERVICE_COMMUNICATION_FAILURE,
    switchOf: (accessory) => accessory.getService(Service.Switch).getCharacteristic(Characteristic.On),
    doorOf: (accessory) => {
      const service = accessory.getService(Service.GarageDoorOpener);
      return {
        current: service.getCharacteristic(Characteristic.CurrentDoorState),
        target: service.getCharacteristic(Characteristic.TargetDoorState),
      };
    },
  };
}

test('switch: turning it on in Home pulses the relay and the tile goes back to off', async (t) => {
  const mock = await startMockShelly();
  t.after(() => mock.close());
  const home = await boot(t, [{ name: 'Garage', host: mock.host, pulseSeconds: 0.3, pollSeconds: 0 }]);
  const on = home.switchOf(home.registered[0]);

  await on.handleSetRequest(true);

  assert.deepEqual(mock.lastSet, { on: true, toggleAfter: 0.3 });
  assert.equal(mock.output, true);
  assert.equal(await on.handleGetRequest(), true);

  await sleep(450);

  assert.equal(on.value, false);
  assert.equal(await on.handleGetRequest(), false);
  assert.equal(mock.output, false);
  assert.deepEqual(mock.lastSet, { on: false, toggleAfter: null }, 'the plugin confirms the off itself');
});

test('switch: turning it off during the pulse ends it at once', async (t) => {
  const mock = await startMockShelly();
  t.after(() => mock.close());
  const home = await boot(t, [{ host: mock.host, pulseSeconds: 0.4, pollSeconds: 0 }]);
  const on = home.switchOf(home.registered[0]);

  await on.handleSetRequest(true);
  await on.handleSetRequest(false);
  assert.equal(mock.output, false);

  const requestsAfterOff = mock.requests.length;
  await sleep(550);
  assert.equal(mock.requests.length, requestsAfterOff, 'no late off is sent');
  assert.equal(on.value, false);
});

test('switch: with pulseSeconds 0 it stays on', async (t) => {
  const mock = await startMockShelly();
  t.after(() => mock.close());
  const home = await boot(t, [{ host: mock.host, pulseSeconds: 0, pollSeconds: 0 }]);
  const on = home.switchOf(home.registered[0]);

  await on.handleSetRequest(true);
  await sleep(300);

  assert.deepEqual(mock.lastSet, { on: true, toggleAfter: null });
  assert.equal(mock.output, true);
  assert.equal(on.value, true);
});

test('switch: a command the Shelly refuses is reported to Home as a failure', async (t) => {
  const mock = await startMockShelly();
  t.after(() => mock.close());
  const home = await boot(t, [{ name: 'Garage', host: mock.host, pollSeconds: 0 }]);
  const on = home.switchOf(home.registered[0]);
  await sleep(50); // let the plugin identify the device first
  mock.failNext = 1;

  await assert.rejects(on.handleSetRequest(true), (status) => status === home.failure);

  assert.equal(mock.output, false);
  assert.equal(await on.handleGetRequest(), false);
  assert.ok(home.lines.some((line) => /^error: Garage: could not switch on: .*simulated failure/.test(line)));
});

test('switch: switched on outside Home, it shows on and is turned off after the pulse time', async (t) => {
  const mock = await startMockShelly();
  t.after(() => mock.close());
  const home = await boot(t, [{ host: mock.host, pulseSeconds: 0.3, pollSeconds: 1 }]);
  const on = home.switchOf(home.registered[0]);
  await sleep(100);
  assert.equal(on.value, false);

  mock.output = true; // someone pressed the wall button

  await sleep(1100);
  assert.equal(on.value, true);
  await sleep(450);
  assert.equal(on.value, false);
  assert.equal(mock.output, false);
});

test('switch: a status answer that was already on its way does not undo a command', async (t) => {
  const mock = await startMockShelly();
  t.after(() => mock.close());
  mock.statusDelayMs = 200;
  const home = await boot(t, [{ host: mock.host, pulseSeconds: 5, pollSeconds: 60 }]);
  const on = home.switchOf(home.registered[0]);
  await sleep(60); // the first status check is now waiting for its answer ("off")

  await on.handleSetRequest(true);
  await sleep(300); // the stale "off" has arrived

  assert.equal(on.value, true);
  assert.equal(mock.output, true);
});

test('switch: Home shows No Response once the Shelly stops answering, and recovers', async (t) => {
  const mock = await startMockShelly();
  const home = await boot(t, [{ name: 'Garage', host: mock.host, pollSeconds: 1 }]);
  const on = home.switchOf(home.registered[0]);
  await sleep(100);
  assert.equal(await on.handleGetRequest(), false);
  const port = Number(mock.host.split(':')[1]);

  await mock.close();
  await sleep(3200);
  await assert.rejects(on.handleGetRequest(), (status) => status === home.failure);
  assert.ok(home.lines.some((line) => /^warn: Garage: not reachable: cannot reach/.test(line)));

  const back = await startMockShelly({ port });
  t.after(() => back.close());
  await sleep(1200);
  assert.equal(await on.handleGetRequest(), false);
  assert.ok(home.lines.includes('info: Garage: reachable again'));
});

test('garage door: opening presses the relay once and the door ends up open', async (t) => {
  const mock = await startMockShelly();
  t.after(() => mock.close());
  const home = await boot(t, [
    { name: 'Door', host: mock.host, type: 'garageDoor', pulseSeconds: 0.2, doorTravelSeconds: 1 },
  ]);
  const accessory = home.registered[0];
  const door = home.doorOf(accessory);
  const { CurrentDoorState, TargetDoorState } = home.Characteristic;
  assert.equal(await door.current.handleGetRequest(), CurrentDoorState.CLOSED);
  assert.equal(await door.target.handleGetRequest(), TargetDoorState.CLOSED);

  await door.target.handleSetRequest(TargetDoorState.OPEN);

  assert.deepEqual(mock.lastSet, { on: true, toggleAfter: 0.2 });
  assert.equal(door.current.value, CurrentDoorState.OPENING);
  assert.equal(accessory.context.doorClosed, false);

  // Asking for the same thing again must not press the button a second time.
  const presses = () => mock.requests.filter((url) => url.includes('on=true')).length;
  await door.target.handleSetRequest(TargetDoorState.OPEN);
  assert.equal(presses(), 1);

  await sleep(1150);
  assert.equal(door.current.value, CurrentDoorState.OPEN);
  assert.equal(mock.output, false);

  await door.target.handleSetRequest(TargetDoorState.CLOSED);
  assert.equal(presses(), 2);
  assert.equal(door.current.value, CurrentDoorState.CLOSING);
  await sleep(1150);
  assert.equal(door.current.value, CurrentDoorState.CLOSED);
  assert.equal(accessory.context.doorClosed, true);
});

test('garage door: a failed press leaves the door where it was', async (t) => {
  const mock = await startMockShelly();
  t.after(() => mock.close());
  const home = await boot(t, [{ host: mock.host, type: 'garageDoor' }]);
  const door = home.doorOf(home.registered[0]);
  const { CurrentDoorState, TargetDoorState } = home.Characteristic;
  await sleep(50);
  mock.failNext = 1;

  await assert.rejects(door.target.handleSetRequest(TargetDoorState.OPEN), (status) => status === home.failure);

  assert.equal(await door.current.handleGetRequest(), CurrentDoorState.CLOSED);
  assert.equal(await door.target.handleGetRequest(), TargetDoorState.CLOSED);
});

test('garage door: remembers that it was open across a restart', async (t) => {
  const mock = await startMockShelly();
  t.after(() => mock.close());
  const devices = [{ host: mock.host, type: 'garageDoor', doorTravelSeconds: 1 }];
  const first = await boot(t, devices);
  const accessory = first.registered[0];
  await first.doorOf(accessory).target.handleSetRequest(first.Characteristic.TargetDoorState.OPEN);
  first.api.signalShutdown();

  const second = await boot(t, devices, [accessory]);

  assert.equal(second.registered.length, 0, 'the remembered accessory is reused');
  const door = second.doorOf(accessory);
  assert.equal(await door.current.handleGetRequest(), second.Characteristic.CurrentDoorState.OPEN);
  assert.equal(await door.target.handleGetRequest(), second.Characteristic.TargetDoorState.OPEN);
});

const pressesOf = (mock) => mock.requests.filter((url) => url.includes('on=true')).length;

test('self-closing door: Home shows it closed again without a second press', async (t) => {
  const mock = await startMockShelly();
  t.after(() => mock.close());
  const home = await boot(t, [
    { name: 'Gate', host: mock.host, type: 'garageDoor', pulseSeconds: 0.2, doorTravelSeconds: 1, autoCloseSeconds: 0.6 },
  ]);
  const accessory = home.registered[0];
  const door = home.doorOf(accessory);
  const { CurrentDoorState, TargetDoorState } = home.Characteristic;

  await door.target.handleSetRequest(TargetDoorState.OPEN);
  assert.equal(pressesOf(mock), 1);
  assert.equal(door.current.value, CurrentDoorState.OPENING);
  await sleep(800);
  assert.equal(door.current.value, CurrentDoorState.CLOSED);
  assert.equal(door.target.value, TargetDoorState.CLOSED);
  assert.equal(accessory.context.doorClosed, true);
  assert.equal(pressesOf(mock), 1, 'closing by itself must not press the relay');
  assert.equal(mock.output, false);
  // The travel time ends later than the countdown and must not show it open.
  await sleep(400);
  assert.equal(door.current.value, CurrentDoorState.CLOSED);

  // The next open presses the relay again.
  await door.target.handleSetRequest(TargetDoorState.OPEN);
  assert.equal(pressesOf(mock), 2);
});

test('self-closing door: it shows open in between when it stays open long enough', async (t) => {
  const mock = await startMockShelly();
  t.after(() => mock.close());
  const home = await boot(t, [
    { host: mock.host, type: 'garageDoor', pulseSeconds: 0.2, doorTravelSeconds: 1, autoCloseSeconds: 1.8 },
  ]);
  const door = home.doorOf(home.registered[0]);
  const { CurrentDoorState, TargetDoorState } = home.Characteristic;
  const seen = [];
  door.current.on('change', (change) => seen.push(change.newValue));

  await door.target.handleSetRequest(TargetDoorState.OPEN);
  await sleep(1250);
  assert.equal(door.current.value, CurrentDoorState.OPEN);
  assert.equal(door.target.value, TargetDoorState.OPEN);
  await sleep(750);
  assert.equal(door.current.value, CurrentDoorState.CLOSED);
  assert.deepEqual(seen, [CurrentDoorState.OPENING, CurrentDoorState.OPEN, CurrentDoorState.CLOSED]);
  assert.equal(pressesOf(mock), 1);
});

test('self-closing door: closing it in Home changes the tile and leaves the relay alone', async (t) => {
  const mock = await startMockShelly();
  t.after(() => mock.close());
  const home = await boot(t, [
    { host: mock.host, type: 'garageDoor', pulseSeconds: 0.2, doorTravelSeconds: 1, autoCloseSeconds: 1.5 },
  ]);
  const door = home.doorOf(home.registered[0]);
  const { CurrentDoorState, TargetDoorState } = home.Characteristic;
  const seen = [];
  door.current.on('change', (change) => seen.push(change.newValue));

  await door.target.handleSetRequest(TargetDoorState.OPEN);
  await sleep(300);
  await door.target.handleSetRequest(TargetDoorState.CLOSED);

  assert.equal(pressesOf(mock), 1);
  assert.equal(door.current.value, CurrentDoorState.CLOSED);
  assert.equal(await door.target.handleGetRequest(), TargetDoorState.CLOSED);
  // Neither the travel time nor the countdown may change the tile afterwards.
  await sleep(1500);
  assert.deepEqual(seen, [CurrentDoorState.OPENING, CurrentDoorState.CLOSED]);
  assert.equal(pressesOf(mock), 1);
});

test('self-closing door: it is closed after a restart', async (t) => {
  const mock = await startMockShelly();
  t.after(() => mock.close());
  const devices = [{ host: mock.host, type: 'garageDoor', autoCloseSeconds: 30 }];
  const first = await boot(t, devices);
  const accessory = first.registered[0];
  await first.doorOf(accessory).target.handleSetRequest(first.Characteristic.TargetDoorState.OPEN);
  assert.equal(accessory.context.doorClosed, false);
  first.api.signalShutdown();

  const second = await boot(t, devices, [accessory]);

  const door = second.doorOf(accessory);
  assert.equal(await door.current.handleGetRequest(), second.Characteristic.CurrentDoorState.CLOSED);
  assert.equal(await door.target.handleGetRequest(), second.Characteristic.TargetDoorState.CLOSED);
  assert.equal(accessory.context.doorClosed, true);
});

test('fills in the accessory details from the device', async (t) => {
  const mock = await startMockShelly();
  t.after(() => mock.close());
  const home = await boot(t, [{ name: 'Garage', host: mock.host, pollSeconds: 0 }]);
  await sleep(100);

  const { Service, Characteristic } = home.api.hap;
  const information = home.registered[0].getService(Service.AccessoryInformation);
  assert.equal(information.getCharacteristic(Characteristic.Manufacturer).value, 'Shelly');
  assert.equal(information.getCharacteristic(Characteristic.Model).value, 'S1G4');
  assert.equal(information.getCharacteristic(Characteristic.SerialNumber).value, 'AABBCCDDEEFF');
  assert.equal(information.getCharacteristic(Characteristic.FirmwareRevision).value, '1.6.2');
  assert.ok(home.lines.includes(`info: Garage: connected to shelly1g4-aabbccddeeff at ${mock.host}`));
});

test('removes accessories whose entry is gone, and changing the type makes a new one', async (t) => {
  const mock = await startMockShelly();
  t.after(() => mock.close());
  const first = await boot(t, [{ host: mock.host, pollSeconds: 0 }]);
  const asSwitch = first.registered[0];

  const second = await boot(t, [{ host: mock.host, type: 'garageDoor' }], [asSwitch]);

  assert.deepEqual(second.unregistered, [asSwitch]);
  assert.equal(second.registered.length, 1);
  assert.notEqual(second.registered[0].UUID, asSwitch.UUID);
});

test('skips entries it cannot use and says which', async (t) => {
  const mock = await startMockShelly();
  t.after(() => mock.close());
  const home = await boot(t, [
    { name: 'No address' },
    { host: mock.host, type: 'gate' },
    { name: 'Good', host: mock.host, pollSeconds: 0 },
    { name: 'Twice', host: mock.host, pollSeconds: 0 },
  ]);

  assert.equal(home.registered.length, 1);
  assert.equal(home.registered[0].displayName, 'Good');
  assert.ok(home.lines.includes('error: Device 1 has no "host" (the IP address of the Shelly). It was skipped.'));
  assert.ok(home.lines.includes('error: Device 2 has the unknown type "gate" (use "switch" or "garageDoor"). It was skipped.'));
  assert.ok(home.lines.some((line) => /^warn: Twice: .* is listed twice/.test(line)));
});

test('reads settings with sensible defaults', () => {
  assert.deepEqual(readDevice({ host: ' http://192.168.1.50/ ' }), {
    name: 'Shelly 192.168.1.50',
    host: '192.168.1.50',
    type: 'switch',
    channel: 0,
    password: '',
    pulseSeconds: 2,
    pollSeconds: 5,
    doorTravelSeconds: 15,
    autoCloseSeconds: 0,
  });
  assert.equal(readDevice({ host: 'h', type: 'garageDoor', autoCloseSeconds: '45' }).autoCloseSeconds, 45);
  assert.equal(readDevice({ host: 'h', type: 'garageDoor', autoCloseSeconds: -5 }).autoCloseSeconds, 0);
  assert.equal(readDevice({ host: 'h', type: 'garageDoor', pulseSeconds: 0 }).pulseSeconds, 1);
  assert.equal(readDevice({ host: 'h', pulseSeconds: '3.5' }).pulseSeconds, 3.5);
  assert.equal(readDevice({ host: 'h', pollSeconds: 0 }).pollSeconds, 0);
  assert.equal(readDevice({ host: 'h', pollSeconds: 0.2 }).pollSeconds, 1);
});
