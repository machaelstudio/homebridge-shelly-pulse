# Changelog

## 1.0.1 (2026-11-26)

- The settings schema now lists its required fields the standard JSON Schema
  way, which Homebridge's plugin checks require. The settings form looks and
  behaves the same.

## 1.0.0 (2026-11-26)

First public release.

- A Shelly relay appears in Apple Home as a switch that turns itself off after
  a set number of seconds. The timer runs on the Shelly itself.
- The relay can be shown as a garage door instead, with a setting for doors
  and gates that close by themselves.
- The auto-off also applies when the relay is switched on outside Home.
- Password-protected Shellys are supported.
