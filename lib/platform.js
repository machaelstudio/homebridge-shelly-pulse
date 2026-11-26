'use strict';

const { ShellyRelay } = require('./shelly');
const { PulseSwitch } = require('./pulse-switch');
const { GarageDoor } = require('./garage-door');

const PLUGIN_NAME = 'homebridge-shelly-pulse';
const PLATFORM_NAME = 'ShellyPulse';

function numberOr(value, fallback) {
  const number = Number(value);
  return value === undefined || value === null || value === '' || !Number.isFinite(number) ? fallback : number;
}

// Turns one entry of the "devices" setting into the values the plugin uses.
// Throws with the reason when the entry cannot be used.
function readDevice(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('is not a settings entry');
  }
  const host = String(raw.host || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');
  if (!host) {
    throw new Error('has no "host" (the IP address of the Shelly)');
  }
  const type = raw.type === undefined || raw.type === '' ? 'switch' : raw.type;
  if (type !== 'switch' && type !== 'garageDoor') {
    throw new Error(`has the unknown type "${type}" (use "switch" or "garageDoor")`);
  }

  let pulseSeconds = Math.max(0, numberOr(raw.pulseSeconds, 2));
  if (type === 'garageDoor' && pulseSeconds === 0) {
    pulseSeconds = 1; // a garage door button always has to be let go again
  }
  const pollSeconds = numberOr(raw.pollSeconds, 5);

  return {
    name: String(raw.name || '').trim() || `Shelly ${host}`,
    host,
    type,
    channel: Math.max(0, Math.trunc(numberOr(raw.channel, 0))),
    password: String(raw.password || ''),
    pulseSeconds,
    pollSeconds: pollSeconds <= 0 ? 0 : Math.max(1, pollSeconds),
    doorTravelSeconds: Math.max(1, numberOr(raw.doorTravelSeconds, 15)),
    autoCloseSeconds: Math.max(0, numberOr(raw.autoCloseSeconds, 0)),
  };
}

class ShellyPulsePlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.restored = new Map(); // accessories Homebridge remembered from the last run
    this.handlers = [];

    api.on('didFinishLaunching', () => this.setUp());
    api.on('shutdown', () => this.handlers.forEach((handler) => handler.stop()));
  }

  configureAccessory(accessory) {
    this.restored.set(accessory.UUID, accessory);
  }

  setUp() {
    const entries = Array.isArray(this.config.devices) ? this.config.devices : [];
    const wanted = new Set();

    entries.forEach((raw, index) => {
      let device;
      try {
        device = readDevice(raw);
      } catch (err) {
        this.log.error(`Device ${index + 1} ${err.message}. It was skipped.`);
        return;
      }

      // The type is part of the identity: Home gets a new accessory when a
      // switch becomes a garage door, instead of one that changed shape.
      const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${device.host}:${device.channel}:${device.type}`);
      if (wanted.has(uuid)) {
        this.log.warn(`${device.name}: ${device.host} channel ${device.channel} is listed twice. The second entry was skipped.`);
        return;
      }
      wanted.add(uuid);

      const known = this.restored.get(uuid);
      const accessory = known || new this.api.platformAccessory(device.name, uuid);
      const relay = new ShellyRelay({ host: device.host, channel: device.channel, password: device.password });
      const Handler = device.type === 'garageDoor' ? GarageDoor : PulseSwitch;
      this.handlers.push(new Handler(this, accessory, device, relay));
      if (!known) {
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
      this.describe(accessory, device, relay);
    });

    const gone = [...this.restored.values()].filter((accessory) => !wanted.has(accessory.UUID));
    if (gone.length > 0) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, gone);
      this.log.info(`Removed ${gone.length} accessory(ies) that are no longer in the settings.`);
    }
    if (wanted.size === 0) {
      this.log.warn('No Shelly is set up yet. Add one in the plugin settings.');
    }
  }

  // Fills in the accessory's model, serial number and firmware from the device.
  async describe(accessory, device, relay) {
    const { Service, Characteristic } = this.api.hap;
    const information = accessory.getService(Service.AccessoryInformation);
    information.setCharacteristic(Characteristic.Manufacturer, 'Shelly');
    try {
      const found = await relay.identify();
      information.setCharacteristic(Characteristic.Model, found.model);
      information.setCharacteristic(Characteristic.SerialNumber, found.mac || found.id);
      const version = /\d+\.\d+(\.\d+)?/.exec(found.firmware);
      if (version) {
        information.setCharacteristic(Characteristic.FirmwareRevision, version[0]);
      }
      this.log.info(`${device.name}: connected to ${found.id} at ${device.host}`);
    } catch (err) {
      this.log.warn(`${device.name}: ${err.message}. The plugin keeps trying.`);
    }
  }
}

module.exports = { ShellyPulsePlatform, readDevice, PLUGIN_NAME, PLATFORM_NAME };
