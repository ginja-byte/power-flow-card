/**
 * Test harness for power-flow-card render logic.
 *
 * Mocks the browser globals the card file expects, then loads the card module.
 * The card registers itself with customElements (mocked), but we mainly want
 * to exercise the pure render functions with various hass + config inputs.
 */

// ---- Mock browser globals so the card file loads under node ---------------
global.window = global.window || {};
global.window.customCards = [];

global.HTMLElement = class HTMLElement {
  constructor() {
    this._innerHTML = "";
  }
  set innerHTML(v) { this._innerHTML = v; }
  get innerHTML() { return this._innerHTML; }
  querySelector() { return null; }
  addEventListener() {}
  dispatchEvent() {}
};

global.customElements = {
  _registry: new Map(),
  define(name, ctor) { this._registry.set(name, ctor); },
  get(name) { return this._registry.get(name); },
};

global.requestAnimationFrame = (cb) => setTimeout(cb, 0);
global.CustomEvent = class CustomEvent {
  constructor(name, init) {
    this.type = name;
    this.detail = init?.detail;
  }
};

global.document = {
  createElement(tag) {
    const Ctor = global.customElements.get(tag);
    if (Ctor) return new Ctor();
    return new global.HTMLElement();
  },
};

// ---- Load the card module by reading it and evaluating in a context -------
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "dist/power-flow-card.js"), "utf8");

// Wrap in a function to capture top-level functions/classes by appending an
// export trailer. We need access to normalizeConfig, deriveState, renderCard,
// and the PowerFlowCard class to drive the tests.
const wrapper = `
${src}
module.exports = {
  normalizeConfig,
  deriveState,
  computeColors,
  computeBatteryEta,
  renderCard,
  PowerFlowCard,
  PowerFlowCardEditor,
  collectWatchedEntities,
};
`;

const Module = require("module");
const mod = new Module("power-flow-card-test");
mod._compile(wrapper, "power-flow-card-test");
const api = mod.exports;

// ---- Helpers --------------------------------------------------------------
function makeHass(states) {
  const out = { states: {} };
  for (const [eid, val] of Object.entries(states)) {
    out.states[eid] = { state: String(val), attributes: {} };
  }
  return out;
}

function assert(name, condition, detail = "") {
  if (condition) {
    console.log(`✓ ${name}`);
  } else {
    console.log(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
    process.exitCode = 1;
  }
}

function contains(haystack, needle, name) {
  assert(name, haystack.includes(needle), `missing "${needle}"`);
}

function notContains(haystack, needle, name) {
  assert(name, !haystack.includes(needle), `unexpected "${needle}"`);
}

// ============================================================================
// Tests
// ============================================================================

console.log("\n=== Scenario 1: typical daytime — solar producing, battery charging from PV ===");
{
  const cfg = api.normalizeConfig({
    type: "custom:power-flow-card",
    title: "Test",
    solar: { power_entity: "sensor.pv", energy_today_entity: "sensor.pv_today" },
    battery: { power_entity: "sensor.batt", soc_entity: "sensor.soc",
               capacity_kwh: 10, min_soc_percent: 20,
               energy_in_today_entity: "sensor.batt_in", energy_out_today_entity: "sensor.batt_out" },
    grid: { power_entity: "sensor.grid", voltage_entity: "sensor.grid_v",
            energy_in_today_entity: "sensor.grid_in", energy_out_today_entity: "sensor.grid_out" },
    load: { power_entity: "sensor.load", percentage_entity: "sensor.load_pct",
            energy_today_entity: "sensor.load_today" },
    inverter: { output_source_priority_entity: "select.out", charger_source_priority_entity: "select.chg" },
  });
  const hass = makeHass({
    "sensor.pv": 3200, "sensor.pv_today": 12.4,
    "sensor.batt": 1800, "sensor.soc": 76,
    "sensor.batt_in": 5.1, "sensor.batt_out": 1.2,
    "sensor.grid": -50, "sensor.grid_v": 231,
    "sensor.grid_in": 0.4, "sensor.grid_out": 2.1,
    "sensor.load": 1200, "sensor.load_pct": 30, "sensor.load_today": 8.4,
    "select.out": "Solar/Battery/Utility (SBU)",
    "select.chg": "Solar Only (SO)",
  });
  const state = api.deriveState(hass, cfg);
  assert("solar detected as producing", state.solarOn);
  assert("battery detected as charging", state.battCharging);
  assert("battery not discharging",      !state.battDischarging);
  assert("grid online",                  !state.gridOff);
  assert("load is on",                   state.loadOn);
  const colors = api.computeColors(state, cfg);
  assert("solar color is solar yellow",  colors.cSol === "#fbbf24");
  assert("battery color is charging green", colors.cBat === "#10b981");
  const eta = api.computeBatteryEta(state, cfg);
  assert("battery ETA computed",         eta && eta.label === "FULL IN");
  const html = api.renderCard(hass, cfg);
  contains(html, "SOLAR",      "renders SOLAR label");
  contains(html, "GRID",       "renders GRID label");
  contains(html, "BATTERY",    "renders BATTERY label");
  contains(html, "LOAD",       "renders LOAD label");
  contains(html, "INVERTER",   "renders INVERTER box");
  contains(html, "TEST",       "renders card title");
  contains(html, "FULL IN",    "renders battery ETA");
  contains(html, "kW",         "renders power units");
  contains(html, "kWh",        "renders energy units");
  contains(html, "76%",        "renders battery SOC");
  // Inverter source mode shorthand extraction
  contains(html, "SBU",        "extracts inverter output source shorthand");
  contains(html, "SO",         "extracts inverter charger source shorthand");
  notContains(html, "GEN TODAY", "no generator footer column when disabled");
  notContains(html, '<div class="pfc-seps"',  "no separators div when none configured");
  notContains(html, '<div class="pfc-phases"',"no 3-phase panel when disabled");
}

console.log("\n=== Scenario 2: night — solar off, battery discharging, grid importing ===");
{
  const cfg = api.normalizeConfig({
    type: "custom:power-flow-card",
    solar: { power_entity: "sensor.pv" },
    battery: { power_entity: "sensor.batt", soc_entity: "sensor.soc", capacity_kwh: 10, min_soc_percent: 20 },
    grid: { power_entity: "sensor.grid", voltage_entity: "sensor.grid_v" },
    load: { power_entity: "sensor.load" },
    inverter: {},
  });
  const hass = makeHass({
    "sensor.pv": 0, "sensor.batt": -2000, "sensor.soc": 55,
    "sensor.grid": 800, "sensor.grid_v": 230, "sensor.load": 2800,
  });
  const state = api.deriveState(hass, cfg);
  assert("solar off",            !state.solarOn);
  assert("battery discharging",  state.battDischarging);
  assert("grid importing",       state.gridImporting);
  const eta = api.computeBatteryEta(state, cfg);
  assert("battery EMPTY IN eta", eta && eta.label === "EMPTY IN");
  const html = api.renderCard(hass, cfg);
  contains(html, "55%", "renders SOC");
  contains(html, "EMPTY IN", "renders empty-in ETA");
}

console.log("\n=== Scenario 3: grid outage (voltage below threshold) ===");
{
  const cfg = api.normalizeConfig({
    type: "custom:power-flow-card",
    solar: { power_entity: "sensor.pv" },
    battery: { power_entity: "sensor.batt", soc_entity: "sensor.soc", capacity_kwh: 10, min_soc_percent: 20 },
    grid: { power_entity: "sensor.grid", voltage_entity: "sensor.grid_v" },
    load: { power_entity: "sensor.load" },
    inverter: {},
  });
  const hass = makeHass({
    "sensor.pv": 500, "sensor.batt": -1200, "sensor.soc": 80,
    "sensor.grid": 0, "sensor.grid_v": 0, "sensor.load": 1700,
  });
  const state = api.deriveState(hass, cfg);
  assert("grid detected off",       state.gridOff);
  assert("not importing when off",  !state.gridImporting);
  const html = api.renderCard(hass, cfg);
  contains(html, "GRID OFF", "renders GRID OFF state");
  contains(html, "grid-alert", "applies grid-alert pulsing class");
}

console.log("\n=== Scenario 4: generator running, grid off ===");
{
  const cfg = api.normalizeConfig({
    type: "custom:power-flow-card",
    solar: { power_entity: "sensor.pv" },
    battery: { power_entity: "sensor.batt", soc_entity: "sensor.soc", capacity_kwh: 10, min_soc_percent: 20 },
    grid: { power_entity: "sensor.grid", voltage_entity: "sensor.grid_v" },
    load: { power_entity: "sensor.load" },
    inverter: {},
    generator: {
      enabled: true,
      power_entity: "sensor.gen_power",
      status_entity: "binary_sensor.gen_on",
      fuel_level_entity: "sensor.gen_fuel",
      energy_today_entity: "sensor.gen_today",
    },
  });
  const hass = makeHass({
    "sensor.pv": 0, "sensor.batt": 0, "sensor.soc": 45,
    "sensor.grid": 0, "sensor.grid_v": 0, "sensor.load": 2400,
    "sensor.gen_power": 2500,
    "binary_sensor.gen_on": "on",
    "sensor.gen_fuel": 68,
    "sensor.gen_today": 4.2,
  });
  const state = api.deriveState(hass, cfg);
  assert("generator detected on", state.genOn);
  assert("grid off",              state.gridOff);
  const html = api.renderCard(hass, cfg);
  contains(html, "GENERATOR", "renders GENERATOR label");
  contains(html, "FUEL 68%",  "renders fuel level");
  contains(html, "GEN TODAY", "renders generator footer column");
}

console.log("\n=== Scenario 5: three-phase grid ===");
{
  const cfg = api.normalizeConfig({
    type: "custom:power-flow-card",
    solar: { power_entity: "sensor.pv" },
    battery: { power_entity: "sensor.batt", soc_entity: "sensor.soc", capacity_kwh: 10, min_soc_percent: 20 },
    grid: {
      power_entity: "sensor.grid",
      three_phase: {
        enabled: true,
        phases: [
          { label: "L1", power_entity: "sensor.l1_p", voltage_entity: "sensor.l1_v", current_entity: "sensor.l1_a" },
          { label: "L2", power_entity: "sensor.l2_p", voltage_entity: "sensor.l2_v", current_entity: "sensor.l2_a" },
          { label: "L3", power_entity: "sensor.l3_p", voltage_entity: "sensor.l3_v", current_entity: "sensor.l3_a" },
        ],
      },
    },
    load: { power_entity: "sensor.load" },
    inverter: {},
  });
  const hass = makeHass({
    "sensor.pv": 0, "sensor.batt": 0, "sensor.soc": 60,
    "sensor.grid": 5000, "sensor.load": 5200,
    "sensor.l1_v": 230, "sensor.l1_a": 8.5, "sensor.l1_p": 1955,
    "sensor.l2_v": 231, "sensor.l2_a": 7.2, "sensor.l2_p": 1663,
    "sensor.l3_v": 229, "sensor.l3_a": 6.0, "sensor.l3_p": 1374,
  });
  const state = api.deriveState(hass, cfg);
  assert("grid online via 3-phase voltage detection", !state.gridOff);
  assert("3 phases derived",                          state.phases.length === 3);
  const html = api.renderCard(hass, cfg);
  contains(html, '<div class="pfc-phases"', "renders 3-phase detail panel");
  contains(html, "L1",         "renders L1 label");
  contains(html, "L2",         "renders L2 label");
  contains(html, "L3",         "renders L3 label");
}

console.log("\n=== Scenario 6: three load separators (pool, geyser, EV) ===");
{
  const cfg = api.normalizeConfig({
    type: "custom:power-flow-card",
    solar: { power_entity: "sensor.pv" },
    battery: { power_entity: "sensor.batt", soc_entity: "sensor.soc", capacity_kwh: 10, min_soc_percent: 20 },
    grid: { power_entity: "sensor.grid", voltage_entity: "sensor.grid_v" },
    load: { power_entity: "sensor.load" },
    inverter: {},
    load_separators: [
      { name: "Pool",   power_entity: "sensor.pool",   icon: "pool",         color: "#06b6d4", threshold_w: 5 },
      { name: "Geyser", power_entity: "sensor.geyser", icon: "water-boiler", color: "#ef4444", threshold_w: 50 },
      { name: "EV",     power_entity: "sensor.ev",     icon: "car-electric", color: "#a855f7", threshold_w: 100 },
    ],
  });
  const hass = makeHass({
    "sensor.pv": 0, "sensor.batt": 0, "sensor.soc": 50,
    "sensor.grid": 1000, "sensor.grid_v": 230, "sensor.load": 1500,
    "sensor.pool": 850,    // on
    "sensor.geyser": 0,    // off
    "sensor.ev": 7200,     // on
  });
  const state = api.deriveState(hass, cfg);
  assert("3 separators derived", state.separators.length === 3);
  assert("pool detected on",     state.separators[0].on);
  assert("geyser detected off",  !state.separators[1].on);
  assert("EV detected on",       state.separators[2].on);
  const html = api.renderCard(hass, cfg);
  contains(html, '<div class="pfc-seps"', "renders separators row");
  contains(html, "POOL",     "renders pool name");
  contains(html, "GEYSER",   "renders geyser name");
  contains(html, "EV",       "renders EV name");
  contains(html, "mdi:pool", "renders pool icon");
}

console.log("\n=== Scenario 7: missing optional entities — should not crash ===");
{
  const cfg = api.normalizeConfig({
    type: "custom:power-flow-card",
    solar: { power_entity: "sensor.pv" },
    battery: { power_entity: "sensor.batt", soc_entity: "sensor.soc", capacity_kwh: 10, min_soc_percent: 20 },
    grid: { power_entity: "sensor.grid" },
    load: { power_entity: "sensor.load" },
    inverter: {},
  });
  const hass = makeHass({
    "sensor.pv": "unknown",
    "sensor.batt": "unavailable",
    "sensor.soc": 50,
    "sensor.grid": 100,
    "sensor.load": 800,
  });
  // unknown/unavailable should resolve to 0 without throwing
  const state = api.deriveState(hass, cfg);
  assert("pv falls back to 0",      state.pv === 0);
  assert("batt falls back to 0",    state.batt === 0);
  const html = api.renderCard(hass, cfg);
  assert("renders without throwing on unknown states", html.length > 0);
  notContains(html, "NaN", "no NaN values in output");
}

console.log("\n=== Scenario 8: config normalization with invalid input ===");
{
  let threw = false;
  try {
    api.normalizeConfig(null);
  } catch (e) {
    threw = true;
  }
  assert("normalizeConfig throws on null", threw);

  // Empty config — should normalize but warn about missing entities, not throw
  let warning = false;
  const origWarn = console.warn;
  console.warn = () => { warning = true; };
  const cfg = api.normalizeConfig({ type: "custom:power-flow-card" });
  console.warn = origWarn;
  assert("empty config does not throw", !!cfg);
  assert("empty config warns about missing entities", warning);
  assert("battery defaults applied",     cfg.battery.capacity_kwh === 10);
  assert("min SOC default applied",      cfg.battery.min_soc_percent === 20);
  assert("voltage threshold default",    cfg.grid.voltage_threshold === 50);
  assert("3-phase disabled by default",  cfg.grid.three_phase.enabled === false);
  assert("no separators by default",     cfg.load_separators.length === 0);
  assert("generator disabled by default",cfg.generator.enabled === false);
}

console.log("\n=== Scenario 9: watched entity collection ===");
{
  const cfg = api.normalizeConfig({
    type: "custom:power-flow-card",
    solar: { power_entity: "sensor.pv", energy_today_entity: "sensor.pv_today" },
    battery: { power_entity: "sensor.batt", soc_entity: "sensor.soc", capacity_kwh: 10, min_soc_percent: 20 },
    grid: { power_entity: "sensor.grid", voltage_entity: "sensor.grid_v" },
    load: { power_entity: "sensor.load" },
    inverter: {},
    generator: { enabled: true, power_entity: "sensor.gen" },
    load_separators: [{ name: "Pool", power_entity: "sensor.pool" }],
  });
  const watched = api.collectWatchedEntities(cfg);
  assert("solar power watched", watched.has("sensor.pv"));
  assert("solar today watched", watched.has("sensor.pv_today"));
  assert("generator power watched", watched.has("sensor.gen"));
  assert("separator pool watched", watched.has("sensor.pool"));
  assert("non-configured entity not watched", !watched.has("sensor.random"));
}

console.log("\n=== Scenario 10: PowerFlowCard custom element lifecycle ===");
{
  const card = new api.PowerFlowCard();
  card.setConfig({
    type: "custom:power-flow-card",
    solar: { power_entity: "sensor.pv" },
    battery: { power_entity: "sensor.batt", soc_entity: "sensor.soc", capacity_kwh: 10, min_soc_percent: 20 },
    grid: { power_entity: "sensor.grid", voltage_entity: "sensor.grid_v" },
    load: { power_entity: "sensor.load" },
    inverter: {},
  });
  card.hass = makeHass({
    "sensor.pv": 2000, "sensor.batt": 500, "sensor.soc": 70,
    "sensor.grid": -100, "sensor.grid_v": 230, "sensor.load": 1400,
  });
  assert("card has size", card.getCardSize() >= 6);

  // Stub config
  const stub = api.PowerFlowCard.getStubConfig(null, [
    "sensor.solar_pv_power", "sensor.battery_power", "sensor.battery_soc",
    "sensor.grid_power", "sensor.grid_voltage", "sensor.load_power",
  ]);
  assert("stub config picks PV power",     stub.solar.power_entity === "sensor.solar_pv_power");
  assert("stub config picks battery power",stub.battery.power_entity === "sensor.battery_power");
}

console.log("\n=== Done ===");
if (process.exitCode) {
  console.log(`\nFAILURES detected.`);
} else {
  console.log(`\nAll checks passed.`);
}
