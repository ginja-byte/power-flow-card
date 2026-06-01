# Power Flow Card

[![hacs_badge](https://img.shields.io/badge/HACS-Custom-41BDF5.svg)](https://hacs.xyz/)
[![Validate](https://github.com/ginja-byte/power-flow-card/actions/workflows/validate.yml/badge.svg)](https://github.com/ginja-byte/power-flow-card/actions/workflows/validate.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Animated Lovelace card showing real-time energy flow between solar, battery, grid, optional generator, the house, and up to three downstream load separators (pool, geyser, EV charger, etc.). Supports single-phase and three-phase grid setups.

## Features

- 🔄 **Animated flow lines** between every node — direction reverses to indicate import vs export, battery charge vs discharge
- 🎨 **Context-aware colors** — load color from percentage, battery color from discharge rate, inverter color from dominant source
- 🌞 **Solar arc** with animated sun position
- 🔋 **Battery ETA** — "FULL IN 1h 24m" / "EMPTY IN 3h 12m" / "AT CUTOFF"
- ⚡ **Grid outage detection** via voltage threshold with pulsing red alert
- 🔌 **Generator support** with fuel level and status indication
- 🧪 **Three-phase grid** — per-phase voltage / current / power detail panel
- 🚿 **Up to three load separators** — show downstream circuits like pool pump, geyser, EV charger separately from total house load
- 📊 **Source contribution ring** around the house icon showing PV/battery/grid/generator mix
- ⚙️ **Visual editor** — no YAML required for basic setup
- 🧩 **Graceful degradation** — missing optional entities don't break the card

## Requirements

- Home Assistant 2024.6 or newer
- HACS installed (or you can install manually — see below)

## Installation

### Via HACS (recommended)

1. Open HACS → **Frontend**
2. Top-right menu (⋮) → **Custom repositories**
3. Add `https://github.com/ginja-byte/power-flow-card` with category **Lovelace**
4. Install **Power Flow Card** from the list
5. Hard-refresh your browser (Cmd+Shift+R / Ctrl+Shift+R)

### Manual installation

1. Download `dist/power-flow-card.js` from the [latest release](https://github.com/ginja-byte/power-flow-card/releases)
2. Copy it to `<config>/www/power-flow-card.js`
3. In **Settings → Dashboards → ⋮ → Resources → Add resource**:
   - URL: `/local/power-flow-card.js`
   - Type: JavaScript module
4. Hard-refresh your browser

## Adding the card

1. Edit a dashboard → **Add Card** → search "Power Flow Card"
2. The visual editor opens — fill in your entity IDs in each section (Solar, Battery, Grid, Load)
3. Optional sections (Inverter, Generator, separators, three-phase) stay collapsed unless you expand and configure them
4. Click **Save**

Or paste this YAML and adjust:

```yaml
type: custom:power-flow-card
title: Energy
solar:
  power_entity: sensor.pv_power
  energy_today_entity: sensor.pv_energy_today
battery:
  power_entity: sensor.battery_power
  soc_entity: sensor.battery_state_of_charge
  capacity_kwh: 10           # your battery's usable capacity
  min_soc_percent: 20        # your inverter's cutoff
  energy_in_today_entity: sensor.battery_energy_in_today
  energy_out_today_entity: sensor.battery_energy_out_today
grid:
  power_entity: sensor.grid_power
  voltage_entity: sensor.grid_voltage      # used for grid-off detection
  energy_in_today_entity: sensor.grid_energy_in_today
  energy_out_today_entity: sensor.grid_energy_out_today
load:
  power_entity: sensor.load_power
  percentage_entity: sensor.load_percentage   # optional — drives the load color
  energy_today_entity: sensor.load_energy_today
inverter:                                     # optional
  output_source_priority_entity: select.output_source_priority
  charger_source_priority_entity: select.charger_source_priority
```

## Conventions

- **Power entities are in watts** (positive = into the node, negative = out of it for battery and grid).
- **Battery power**: positive = charging, negative = discharging.
- **Grid power**: positive = importing from grid, negative = exporting.
- **Energy entities are in kWh** and accumulate over the day, typically resetting at midnight (the card just displays the current value).

If your sensors are in kW or your sign conventions are opposite, create template sensors first to convert.

## Optional features

### Generator

```yaml
generator:
  enabled: true
  power_entity: sensor.generator_power           # W
  status_entity: binary_sensor.generator_running # optional — if not set, uses power threshold
  fuel_level_entity: sensor.generator_fuel       # optional — 0–100 %
  energy_today_entity: sensor.generator_energy_today
  threshold_w: 50                                # power above this = considered on
```

When enabled, the generator node appears below-left and connects to the inverter via its own animated flow line.

### Three-phase grid

```yaml
grid:
  power_entity: sensor.grid_total_power
  three_phase:
    enabled: true
    phases:
      - label: L1
        power_entity: sensor.l1_power
        voltage_entity: sensor.l1_voltage
        current_entity: sensor.l1_current
      - label: L2
        power_entity: sensor.l2_power
        voltage_entity: sensor.l2_voltage
        current_entity: sensor.l2_current
      - label: L3
        power_entity: sensor.l3_power
        voltage_entity: sensor.l3_voltage
        current_entity: sensor.l3_current
```

A per-phase detail panel appears below the main flow. Grid-off detection uses the max voltage across configured phases.

### Load separators

Up to three "downstream" loads that you want to see broken out from the total house load (the values are not subtracted — they're just shown alongside). Common examples: pool pump, geyser, EV charger.

```yaml
load_separators:
  - name: Pool
    power_entity: sensor.pool_pump_power
    icon: pool                    # any mdi icon name without the "mdi:" prefix
    color: "#06b6d4"
    threshold_w: 5
  - name: Geyser
    power_entity: sensor.geyser_power
    icon: water-boiler
    color: "#ef4444"
    threshold_w: 50
  - name: EV
    power_entity: sensor.ev_charger_power
    energy_today_entity: sensor.ev_charger_today
    icon: car-electric
    color: "#a855f7"
    threshold_w: 100
```

A chip row appears under the main flow showing each separator with on/off styling.

### Inverter mode display

If your inverter exposes output and charger source-priority entities (e.g. a Growatt SPF, Voltronic / Axpert, MPP Solar setup), wire them up to show the current modes inside the central inverter box:

```yaml
inverter:
  output_source_priority_entity: select.output_source_priority
  charger_source_priority_entity: select.charger_source_priority
```

The card extracts shorthand from values like `Solar/Battery/Utility (SBU)` → shows `SBU`.

## Configuration reference

### Top level

| Key | Type | Required | Default | Description |
|---|---|---|---|---|
| `type` | string | yes | — | Must be `custom:power-flow-card` |
| `title` | string | no | `""` | Optional title shown at the top of the card |
| `solar` | object | yes | — | Solar configuration |
| `battery` | object | yes | — | Battery configuration |
| `grid` | object | yes | — | Grid configuration |
| `load` | object | yes | — | House load configuration |
| `inverter` | object | no | — | Inverter mode display (optional) |
| `generator` | object | no | `{ enabled: false }` | Generator configuration (optional) |
| `load_separators` | array | no | `[]` | 0–3 downstream load separators |

### `solar`

| Key | Type | Required | Default | Description |
|---|---|---|---|---|
| `power_entity` | string | yes | — | PV power in watts |
| `energy_today_entity` | string | no | — | PV energy today in kWh |
| `production_threshold_w` | number | no | `100` | Below this, solar is considered "off" |

### `battery`

| Key | Type | Required | Default | Description |
|---|---|---|---|---|
| `power_entity` | string | yes | — | Battery power in W (+ charging, − discharging) |
| `soc_entity` | string | yes | — | State of charge 0–100 |
| `capacity_kwh` | number | no | `10` | Usable capacity, used for ETA calculation |
| `min_soc_percent` | number | no | `20` | Cutoff threshold — shown as red dashed line on battery icon |
| `energy_in_today_entity` | string | no | — | kWh into battery today |
| `energy_out_today_entity` | string | no | — | kWh out of battery today |

### `grid`

| Key | Type | Required | Default | Description |
|---|---|---|---|---|
| `power_entity` | string | yes | — | Total grid power in W (+ import, − export) |
| `voltage_entity` | string | no | — | Grid voltage, used for outage detection |
| `voltage_threshold` | number | no | `50` | Below this voltage, grid is considered offline |
| `energy_in_today_entity` | string | no | — | kWh imported today |
| `energy_out_today_entity` | string | no | — | kWh exported today |
| `three_phase.enabled` | bool | no | `false` | Enable three-phase display |
| `three_phase.phases[].label` | string | no | `L1/L2/L3` | Phase label |
| `three_phase.phases[].power_entity` | string | no | — | Per-phase power in W |
| `three_phase.phases[].voltage_entity` | string | no | — | Per-phase voltage |
| `three_phase.phases[].current_entity` | string | no | — | Per-phase current in A |

### `load`

| Key | Type | Required | Default | Description |
|---|---|---|---|---|
| `power_entity` | string | yes | — | Total house load in W |
| `percentage_entity` | string | no | — | Load %, drives the load color severity |
| `energy_today_entity` | string | no | — | kWh consumed today |

### `inverter`

| Key | Type | Required | Default | Description |
|---|---|---|---|---|
| `output_source_priority_entity` | string | no | — | Inverter output source mode (e.g. SBU/SOL/UTI) |
| `charger_source_priority_entity` | string | no | — | Inverter charger source mode |

### `generator`

| Key | Type | Required | Default | Description |
|---|---|---|---|---|
| `enabled` | bool | yes | `false` | Set to `true` to show the generator node |
| `power_entity` | string | no | — | Generator power output in W |
| `status_entity` | string | no | — | binary_sensor/switch — if "on", generator is on regardless of power |
| `fuel_level_entity` | string | no | — | Fuel level 0–100 |
| `energy_today_entity` | string | no | — | kWh generated today |
| `threshold_w` | number | no | `10` | Power above this = on (used when status_entity not set) |

### `load_separators[]`

| Key | Type | Required | Default | Description |
|---|---|---|---|---|
| `name` | string | no | `Load N` | Display name |
| `power_entity` | string | yes | — | Power in W |
| `energy_today_entity` | string | no | — | kWh today |
| `icon` | string | no | `pool`/`water-boiler`/`car-electric` | mdi icon name (no `mdi:` prefix) |
| `color` | string | no | cyan / purple / pink | Hex color `#RRGGBB` |
| `threshold_w` | number | no | `5` | Power above this = on |

## Sign conventions cheat sheet

If your existing sensors don't match the conventions above, here's the quick fix — define a template sensor in your `configuration.yaml`:

```yaml
template:
  - sensor:
      # Flip the sign of battery power so charge is positive
      - name: "Battery Power (signed)"
        unit_of_measurement: "W"
        state: "{{ 0 - (states('sensor.original_battery_power') | float(0)) }}"
```

## Troubleshooting

**Card shows "Loading…" and never appears**
The card hasn't finished loading from your browser cache. Hard-refresh: Cmd+Shift+R (Mac) / Ctrl+Shift+R (Windows). Open the browser dev console — the card logs `POWER-FLOW-CARD v…` on load.

**Card shows red error banner**
The config is invalid. The error text tells you what's wrong — usually a missing required entity. Open the visual editor and fill in the highlighted field.

**Sensors show as 0 W / 0 %**
The entity ID is wrong, or the entity is in `unknown` / `unavailable` state. The card treats both as 0 to avoid breaking. Double-check entity IDs in **Developer Tools → States**.

**Animation flickers or is choppy**
Caused by other dashboard cards triggering frequent re-renders. The card re-renders only when its own watched entities change — if you see thrashing, check that you don't have other custom cards on the dashboard that force the whole view to re-render.

**Inverter mode shows "—"**
You haven't configured the inverter section, or the configured entity is unavailable. Both fields are optional — the box just shows a dash when unset.

## License

MIT — see [LICENSE](LICENSE).
