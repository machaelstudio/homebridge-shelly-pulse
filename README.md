# Shelly Pulse for Homebridge

[![npm](https://img.shields.io/npm/v/homebridge-shelly-pulse)](https://www.npmjs.com/package/homebridge-shelly-pulse)
[![Test](https://github.com/machaelstudio/homebridge-shelly-pulse/actions/workflows/test.yml/badge.svg)](https://github.com/machaelstudio/homebridge-shelly-pulse/actions/workflows/test.yml)

A [Homebridge](https://homebridge.io) plugin that puts a Shelly relay into
Apple Home as a switch that turns itself off again after a few seconds. It is
made for relays wired across the push button of a garage door, a gate or a door
buzzer, where the relay only has to "press" for a moment.

The relay can also be shown as a garage door, including doors and gates that
close by themselves.

Homebridge talks to the Shelly over the Shelly's own local network API. There
is no cloud and no account.

## What you need

- A Shelly Gen 2 or newer with a relay (Plus, Pro, Gen3, Gen4). First-generation
  Shellys are not supported.
- Homebridge 1.8 or later, including Homebridge 2, on Node.js 22, 24 or 26.
- The Shelly on a fixed IP address that the Homebridge server can reach.

The plugin was developed and tested with a Shelly 1 Gen4. Other Gen 2+ relays
use the same local API and should work, but have not been tried. Reports are
welcome in the [issues](https://github.com/machaelstudio/homebridge-shelly-pulse/issues).

## Install

Search for **Shelly Pulse** on the Plugins page of the Homebridge UI and
install it. Or from a terminal:

```bash
npm install -g homebridge-shelly-pulse
```

## Settings

Open the plugin's settings in the Homebridge UI and add your Shelly, or write
the block by hand:

```json
{
  "platform": "ShellyPulse",
  "name": "Shelly Pulse",
  "devices": [
    {
      "name": "Garage Door",
      "host": "192.168.1.50",
      "type": "switch",
      "pulseSeconds": 2
    }
  ]
}
```

| Setting | Default | Meaning |
| --- | --- | --- |
| `name` | `Shelly <host>` | The name shown in Home. |
| `host` | none | IP address of the Shelly. |
| `type` | `switch` | `switch` or `garageDoor`. |
| `pulseSeconds` | `2` | Seconds the relay stays on. `0` makes a switch stay on until you turn it off. |
| `autoCloseSeconds` | `0` | Garage door only, for a door or gate that closes by itself: Home shows it closed again this long after you open it. `0` means it stays open until you close it. |
| `doorTravelSeconds` | `15` | Garage door only: how long the door takes to open or close. |
| `channel` | `0` | Which relay, on a Shelly with several. The first is `0`. |
| `password` | none | Only if the Shelly itself is password protected. |
| `pollSeconds` | `5` | Switch only: how often the relay is checked. `0` turns the check off. |

If the plugin runs on your main bridge, the accessory appears in Home after the
restart with nothing to pair. If you give it its own child bridge, add that
bridge to Home with the HomeKit code the Homebridge UI shows for it.

## How it behaves

**Switch.** Turning it on tells the Shelly to switch on and to switch itself
off again after `pulseSeconds`. That timer runs on the Shelly, so the relay is
released even if Homebridge stops in the middle. When the time is up the tile
in Home goes back to off and the plugin sends one more "off" as a confirmation.

The auto-off also applies when the relay is switched on some other way (the
wall input, the Shelly app): the plugin notices at its next check and turns it
off `pulseSeconds` later.

**Garage door.** Opening or closing presses the relay for `pulseSeconds`. The
relay cannot tell where the door is, so the position in Home is an estimate: it
is whatever you last asked for, reached after `doorTravelSeconds`. If the door
is moved with its own remote or wall button, Home is out of step until you
press the tile once more. Home asks you to unlock your iPhone before it opens a
garage door from an automation or from Siri; it does not do that for a switch.

**Garage door that closes by itself.** Set `autoCloseSeconds` for a gate or
door that closes on its own, or that a press only ever opens. Opening presses
the relay; that many seconds after the press, Home shows the door closed again
without pressing anything. Closing it in Home earlier only changes the tile and
leaves the relay alone. Use roughly the time from pressing the button until
your gate is shut again. After a Homebridge restart the door is shown closed.

Changing `type`, `host` or `channel` makes a new accessory in Home, so its room
and automations have to be set again.

## Development

```bash
npm install
```

```bash
npm test
```

The tests run against a simulated Shelly (`test/mock-shelly.js`), not real
hardware.

## Licence

[MIT](LICENSE). This is an independent project and is not affiliated with or
endorsed by Shelly.
