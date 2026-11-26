'use strict';

// A HomeKit switch that turns itself off again `pulseSeconds` after it was
// turned on. With `pulseSeconds` 0 it is a plain on/off switch.

// Missed status checks in a row before Home shows "No Response".
const UNREACHABLE_AFTER = 3;

class PulseSwitch {
  constructor(platform, accessory, device, relay) {
    this.log = platform.log;
    this.hap = platform.api.hap;
    this.device = device;
    this.relay = relay;

    this.isOn = false;
    this.failures = 0;
    // Counts commands sent to the relay, so a status check that overlapped a
    // command (and may describe the moment before it) can be thrown away.
    this.commands = 0;
    this.releaseTimer = null;
    this.pollTimer = null;
    this.stopped = false;

    const { Service, Characteristic } = this.hap;
    const service = accessory.getService(Service.Switch) || accessory.addService(Service.Switch, device.name);
    this.onCharacteristic = service
      .getCharacteristic(Characteristic.On)
      .onGet(() => this.read())
      .onSet((value) => this.write(Boolean(value)));
    this.onCharacteristic.updateValue(false);

    if (device.pollSeconds > 0) {
      this.poll();
    }
  }

  read() {
    if (this.failures >= UNREACHABLE_AFTER) {
      throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    return this.isOn;
  }

  async write(on) {
    const pulse = on ? this.device.pulseSeconds : 0;
    this.commands += 1;
    try {
      await this.relay.set(on, pulse);
    } catch (err) {
      this.log.error(`${this.device.name}: could not switch ${on ? 'on' : 'off'}: ${err.message}`);
      throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    } finally {
      this.commands += 1;
    }

    this.isOn = on;
    this.cancelRelease();
    if (pulse > 0) {
      this.scheduleRelease();
      this.log.info(`${this.device.name}: on for ${pulse} s`);
    } else {
      this.log.info(`${this.device.name}: ${on ? 'on' : 'off'}`);
    }
  }

  scheduleRelease() {
    this.releaseTimer = setTimeout(() => this.release(), this.device.pulseSeconds * 1000);
  }

  cancelRelease() {
    clearTimeout(this.releaseTimer);
    this.releaseTimer = null;
  }

  // End of the pulse: show "off" in Home and tell the relay to be off. When
  // the pulse was started from Home the Shelly's own timer has already
  // released the relay, and this only confirms it.
  async release() {
    this.releaseTimer = null;
    this.isOn = false;
    this.onCharacteristic.updateValue(false);
    this.commands += 1;
    try {
      await this.relay.set(false);
      this.log.info(`${this.device.name}: off`);
    } catch (err) {
      this.log.warn(`${this.device.name}: could not confirm it switched off: ${err.message}`);
    } finally {
      this.commands += 1;
    }
  }

  async poll() {
    this.pollTimer = null;
    const commandsBefore = this.commands;
    try {
      const on = await this.relay.isOn();
      if (this.failures >= UNREACHABLE_AFTER) {
        this.log.info(`${this.device.name}: reachable again`);
      }
      this.failures = 0;
      if (commandsBefore === this.commands) {
        this.observe(on);
      }
    } catch (err) {
      this.failures += 1;
      if (this.failures === UNREACHABLE_AFTER) {
        this.log.warn(`${this.device.name}: not reachable: ${err.message}`);
      }
    }
    if (!this.stopped) {
      this.pollTimer = setTimeout(() => this.poll(), this.device.pollSeconds * 1000);
    }
  }

  // What a status check found on the device itself.
  observe(on) {
    if (on !== this.isOn) {
      this.isOn = on;
      this.onCharacteristic.updateValue(on);
      this.log.debug(`${this.device.name}: found ${on ? 'on' : 'off'}`);
      if (!on) {
        this.cancelRelease();
      }
    }
    // On, but nothing is going to turn it off: it was switched on from the
    // wall input or the Shelly app. The auto-off applies to that as well.
    if (on && this.device.pulseSeconds > 0 && !this.releaseTimer) {
      this.scheduleRelease();
    }
  }

  stop() {
    this.stopped = true;
    this.cancelRelease();
    clearTimeout(this.pollTimer);
  }
}

module.exports = { PulseSwitch };
