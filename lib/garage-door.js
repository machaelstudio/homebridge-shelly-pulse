'use strict';

// A HomeKit garage door driven by a relay wired across the opener's push
// button. A press lasts `pulseSeconds`.
//
// The relay cannot tell where the door is, so the position shown in Home is
// an estimate. Two kinds of door are covered:
//
// - One that stays where it is put (`autoCloseSeconds` is 0). Opening and
//   closing both press the button, and Home shows the last thing asked for,
//   reached after `doorTravelSeconds`.
// - One that closes by itself (`autoCloseSeconds` above 0). Only opening
//   presses the button. Home shows the door closed again that long after the
//   press, and closing it in Home changes the tile without touching the relay.

class GarageDoor {
  constructor(platform, accessory, device, relay) {
    this.log = platform.log;
    this.api = platform.api;
    this.hap = platform.api.hap;
    this.accessory = accessory;
    this.device = device;
    this.relay = relay;
    this.closesItself = device.autoCloseSeconds > 0;
    this.releaseTimer = null;
    this.travelTimer = null;
    this.closeTimer = null;

    const { Service, Characteristic } = this.hap;
    this.OPEN = Characteristic.TargetDoorState.OPEN;
    this.CLOSED = Characteristic.TargetDoorState.CLOSED;

    // Closed unless the last request before a restart was to open. A door
    // that closes by itself is taken to be closed: its countdown is gone.
    const wasOpen = accessory.context.doorClosed === false && !this.closesItself;
    this.target = wasOpen ? this.OPEN : this.CLOSED;
    this.current = wasOpen ? Characteristic.CurrentDoorState.OPEN : Characteristic.CurrentDoorState.CLOSED;
    accessory.context.doorClosed = !wasOpen;

    const service =
      accessory.getService(Service.GarageDoorOpener) || accessory.addService(Service.GarageDoorOpener, device.name);
    this.currentCharacteristic = service.getCharacteristic(Characteristic.CurrentDoorState).onGet(() => this.current);
    this.targetCharacteristic = service
      .getCharacteristic(Characteristic.TargetDoorState)
      .onGet(() => this.target)
      .onSet((value) => this.move(value));
    service.getCharacteristic(Characteristic.ObstructionDetected).onGet(() => false);

    this.currentCharacteristic.updateValue(this.current);
    this.targetCharacteristic.updateValue(this.target);
  }

  async move(target) {
    if (target === this.target) {
      return; // already there, or already on its way
    }
    const { CurrentDoorState } = this.hap.Characteristic;
    const opening = target === this.OPEN;

    if (!opening && this.closesItself) {
      // The door comes down on its own, and a press would open it again.
      this.showClosed();
      return;
    }

    try {
      await this.relay.set(true, this.device.pulseSeconds);
    } catch (err) {
      this.log.error(`${this.device.name}: could not ${opening ? 'open' : 'close'}: ${err.message}`);
      throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    this.log.info(`${this.device.name}: ${opening ? 'opening' : 'closing'}`);

    // The Shelly releases the relay by itself; this confirms it.
    clearTimeout(this.releaseTimer);
    this.releaseTimer = setTimeout(() => {
      this.relay.set(false).catch((err) => {
        this.log.warn(`${this.device.name}: could not confirm the relay released: ${err.message}`);
      });
    }, this.device.pulseSeconds * 1000);

    this.target = target;
    this.current = opening ? CurrentDoorState.OPENING : CurrentDoorState.CLOSING;
    this.currentCharacteristic.updateValue(this.current);
    this.accessory.context.doorClosed = !opening;
    this.api.updatePlatformAccessories([this.accessory]);

    clearTimeout(this.travelTimer);
    clearTimeout(this.closeTimer);
    // A door that closes itself before it would count as open never shows open.
    if (!this.closesItself || this.device.doorTravelSeconds < this.device.autoCloseSeconds) {
      this.travelTimer = setTimeout(() => {
        this.current = opening ? CurrentDoorState.OPEN : CurrentDoorState.CLOSED;
        this.currentCharacteristic.updateValue(this.current);
        this.log.info(`${this.device.name}: ${opening ? 'open' : 'closed'}`);
      }, this.device.doorTravelSeconds * 1000);
    }
    if (this.closesItself) {
      this.closeTimer = setTimeout(() => this.showClosed(), this.device.autoCloseSeconds * 1000);
    }
  }

  // Puts the tile back to closed without touching the relay.
  showClosed() {
    clearTimeout(this.travelTimer);
    clearTimeout(this.closeTimer);
    this.target = this.CLOSED;
    this.current = this.hap.Characteristic.CurrentDoorState.CLOSED;
    this.targetCharacteristic.updateValue(this.target);
    this.currentCharacteristic.updateValue(this.current);
    this.accessory.context.doorClosed = true;
    this.api.updatePlatformAccessories([this.accessory]);
    this.log.info(`${this.device.name}: closed`);
  }

  stop() {
    clearTimeout(this.releaseTimer);
    clearTimeout(this.travelTimer);
    clearTimeout(this.closeTimer);
  }
}

module.exports = { GarageDoor };
