/**
 * Power Flow Card
 *
 * HACS-installable Lovelace card visualizing home energy flow: solar,
 * battery, grid, optional generator, and up to three load separators
 * (downstream circuits like pool, geyser, EV). Supports single-phase and
 * three-phase grid configurations.
 *
 * Repository: https://github.com/ginja-byte/power-flow-card
 * License: MIT
 */

const CARD_VERSION = "0.2.1";
const CARD_TAG = "power-flow-card";
const EDITOR_TAG = "power-flow-card-editor";

// Announce to Lovelace card picker
window.customCards = window.customCards || [];
if (!window.customCards.find((c) => c.type === CARD_TAG)) {
  window.customCards.push({
    type: CARD_TAG,
    name: "Power Flow Card",
    description:
      "Animated home energy flow with solar, battery, grid, generator, and load separators. Supports 3-phase.",
    preview: true,
    documentationURL: "https://github.com/ginja-byte/power-flow-card",
  });
}

console.info(
  `%c POWER-FLOW-CARD %c v${CARD_VERSION} `,
  "color: white; background: #1f2544; font-weight: 700;",
  "color: #fbbf24; background: #0a0d1c; font-weight: 700;"
);

// ============================================================================
// Defaults & Constants
// ============================================================================

const DEFAULTS = {
  battery_capacity_kwh: 10,
  battery_min_soc_percent: 20,
  grid_voltage_threshold: 50, // V — below this, grid considered offline
  flow_threshold_w: 10, // minimum power to consider a flow "active"
  battery_flow_threshold_w: 20, // minimum to flag battery as charging/discharging
  load_threshold_w: 20, // minimum to consider load "on"
  separator_threshold_w: 5, // minimum to consider a separator load "on"
  pv_threshold_w: 100, // minimum to consider solar "producing"
};

/**
 * Default color palette. Every key here can be overridden by the user via the
 * `colors:` section in the config — see `normalizeConfig` and `resolveColors`.
 * Renderers read from the resolved palette via the `COLORS` reference, which
 * is rewritten per-render to merge user overrides over these defaults.
 */
const DEFAULT_COLORS = {
  solar: "#fbbf24",
  battery_charging: "#10b981",
  battery_low_dis: "#fbbf24",
  battery_med_dis: "#f97316",
  battery_high_dis: "#ef4444",
  grid_import: "#f97316",
  grid_export: "#10b981",
  grid_off: "#ef4444",
  load_low: "#10b981",
  load_med: "#fbbf24",
  load_high: "#f97316",
  load_max: "#ef4444",
  generator: "#a855f7",
  idle: "#64748b",
  panel_dim: "#1f2544",
  bg_dark: "#0a0d1c",
  bg_darker: "#080a14",
  text: "#e2e8f0",
  text_muted: "#94a3b8",
  text_dim: "#64748b",
  text_alert: "#ef4444",
  alert_red_light: "#fca5a5",
  separator_off: "#475569",
};

/**
 * Mutable resolved palette. Renderers read from this. Rewritten per-render by
 * `resolveColors(cfg)` which merges user overrides over `DEFAULT_COLORS`.
 *
 * Implemented as a mutable container (rather than threading a `palette`
 * argument through every render function) to keep the diff small. Safe because
 * a single card instance renders synchronously start-to-finish.
 */
let COLORS = { ...DEFAULT_COLORS };

/**
 * Merge user-supplied color overrides over the defaults and update the
 * module-level COLORS cache. Only known keys are accepted — unknown keys are
 * silently ignored to prevent typos from leaking into the palette.
 *
 * Returns the resolved palette as well, in case a caller wants a snapshot.
 */
function resolveColors(userColors) {
  const out = { ...DEFAULT_COLORS };
  if (userColors && typeof userColors === "object") {
    for (const k of Object.keys(DEFAULT_COLORS)) {
      const v = userColors[k];
      if (typeof v === "string" && v.trim()) out[k] = v.trim();
    }
  }
  COLORS = out;
  return out;
}

const SEPARATOR_DEFAULT_COLORS = ["#06b6d4", "#a855f7", "#ec4899"];
const SEPARATOR_DEFAULT_ICONS = ["pool", "water-boiler", "car-electric"];

// ============================================================================
// Helpers
// ============================================================================

const safeFloat = (val, def = 0) => {
  const f = parseFloat(val);
  return Number.isFinite(f) ? f : def;
};

const getStateRaw = (hass, eid) => {
  if (!hass || !eid) return undefined;
  return hass.states?.[eid]?.state;
};

const getStateFloat = (hass, eid, def = 0) => {
  const s = getStateRaw(hass, eid);
  if (s === undefined || s === "unknown" || s === "unavailable") return def;
  return safeFloat(s, def);
};

const getStateString = (hass, eid, def = "") => {
  const s = getStateRaw(hass, eid);
  if (s === undefined || s === "unknown" || s === "unavailable") return def;
  return String(s);
};

const isAvailable = (hass, eid) => {
  if (!eid) return false;
  const s = getStateRaw(hass, eid);
  return s !== undefined && s !== "unknown" && s !== "unavailable";
};

const fmtPower = (w) => {
  const a = Math.abs(safeFloat(w, 0));
  if (a >= 1000) return `${(a / 1000).toFixed(2)} kW`;
  return `${a.toFixed(0)} W`;
};

const fmtEnergy = (kwh) => {
  const v = safeFloat(kwh, 0);
  return `${v.toFixed(1)} kWh`;
};

const fmtVoltage = (v) => `${safeFloat(v, 0).toFixed(0)} V`;

const fmtCurrent = (a) => `${safeFloat(a, 0).toFixed(1)} A`;

const fmtHoursMinutes = (h) => {
  if (!Number.isFinite(h) || h < 0) return "—";
  const hrs = Math.floor(h);
  const mins = Math.round((h % 1) * 60);
  return `${hrs}h ${String(mins).padStart(2, "0")}m`;
};

// Shorten a long select-state value (e.g. inverter source mode) to fit in the
// inverter center box. Tries to extract bracketed shorthand first.
const shortenSelectValue = (v) => {
  if (!v || v === "unknown" || v === "unavailable") return "—";
  const m = v.match(/\(([^)]+)\)/);
  if (m) return m[1];
  const words = v.split(/[\s/]+/);
  return words[0].length <= 7 ? words[0] : words[0].substring(0, 6) + "…";
};

// HTML/attribute escape for any user-supplied string we inject into innerHTML.
const esc = (s) => {
  if (s === undefined || s === null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
};

// ============================================================================
// Config validation & normalization
// ============================================================================

/**
 * Normalize a user-supplied config into a complete, defaults-filled shape that
 * the rest of the code can rely on. Missing optional fields become undefined
 * or sensible defaults. Throws on truly invalid input.
 */
function normalizeConfig(raw) {
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid config: expected an object");
  }

  const cfg = {
    type: raw.type,
    title: raw.title || "",

    solar: {
      enabled: raw.solar?.enabled !== false, // default true; only false disables
      power_entity: raw.solar?.power_entity,
      energy_today_entity: raw.solar?.energy_today_entity,
      production_threshold_w: safeFloat(
        raw.solar?.production_threshold_w,
        DEFAULTS.pv_threshold_w
      ),
    },

    battery: {
      power_entity: raw.battery?.power_entity,
      soc_entity: raw.battery?.soc_entity,
      capacity_kwh: safeFloat(
        raw.battery?.capacity_kwh,
        DEFAULTS.battery_capacity_kwh
      ),
      min_soc_percent: safeFloat(
        raw.battery?.min_soc_percent,
        DEFAULTS.battery_min_soc_percent
      ),
      energy_in_today_entity: raw.battery?.energy_in_today_entity,
      energy_out_today_entity: raw.battery?.energy_out_today_entity,
    },

    grid: {
      power_entity: raw.grid?.power_entity,
      voltage_entity: raw.grid?.voltage_entity,
      voltage_threshold: safeFloat(
        raw.grid?.voltage_threshold,
        DEFAULTS.grid_voltage_threshold
      ),
      energy_in_today_entity: raw.grid?.energy_in_today_entity,
      energy_out_today_entity: raw.grid?.energy_out_today_entity,
      three_phase: normalizeThreePhase(raw.grid?.three_phase),
    },

    load: {
      power_entity: raw.load?.power_entity,
      percentage_entity: raw.load?.percentage_entity,
      energy_today_entity: raw.load?.energy_today_entity,
    },

    inverter: {
      output_source_priority_entity:
        raw.inverter?.output_source_priority_entity,
      charger_source_priority_entity:
        raw.inverter?.charger_source_priority_entity,
    },

    generator: normalizeGenerator(raw.generator),

    load_separators: normalizeSeparators(raw.load_separators),

    // User color overrides. Validated per-render by resolveColors(); we just
    // pass through whatever the user gave us here.
    colors: raw.colors && typeof raw.colors === "object" ? { ...raw.colors } : {},
  };

  // Validate required entities — without solar+battery+grid+load we can't really
  // render a meaningful flow. Allow partial setups but warn on console.
  // Solar entity is only required when solar is enabled.
  const required = [
    cfg.battery.power_entity,
    cfg.battery.soc_entity,
    cfg.grid.power_entity,
    cfg.load.power_entity,
  ];
  if (cfg.solar.enabled) required.unshift(cfg.solar.power_entity);
  if (required.some((e) => !e)) {
    console.warn(
      "[power-flow-card] Some core entities are missing; card will degrade gracefully:",
      { solar_enabled: cfg.solar.enabled, solar: cfg.solar.power_entity,
        battery_power: cfg.battery.power_entity,
        battery_soc: cfg.battery.soc_entity, grid: cfg.grid.power_entity,
        load: cfg.load.power_entity }
    );
  }

  return cfg;
}

function normalizeThreePhase(raw) {
  if (!raw || raw.enabled !== true) {
    return { enabled: false, phases: [] };
  }
  const phases = Array.isArray(raw.phases) ? raw.phases : [];
  const normalised = phases.slice(0, 3).map((p, i) => ({
    label: p?.label || `L${i + 1}`,
    power_entity: p?.power_entity,
    voltage_entity: p?.voltage_entity,
    current_entity: p?.current_entity,
  }));
  return { enabled: true, phases: normalised };
}

function normalizeGenerator(raw) {
  if (!raw || raw.enabled !== true) {
    return { enabled: false };
  }
  return {
    enabled: true,
    power_entity: raw.power_entity,
    status_entity: raw.status_entity, // optional binary_sensor
    fuel_level_entity: raw.fuel_level_entity, // optional
    energy_today_entity: raw.energy_today_entity, // optional
    threshold_w: safeFloat(raw.threshold_w, DEFAULTS.flow_threshold_w),
  };
}

function normalizeSeparators(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 3).map((s, i) => ({
    name: s?.name || `Load ${i + 1}`,
    power_entity: s?.power_entity,
    energy_today_entity: s?.energy_today_entity,
    icon: s?.icon || SEPARATOR_DEFAULT_ICONS[i] || "flash",
    color: s?.color || SEPARATOR_DEFAULT_COLORS[i] || "#06b6d4",
    threshold_w: safeFloat(s?.threshold_w, DEFAULTS.separator_threshold_w),
  })).filter((s) => s.power_entity); // drop entries without a power entity
}

/**
 * Collect every entity ID this config depends on. Used to decide whether a
 * hass update should trigger a re-render — re-rendering on every state change
 * across the whole HA instance is wasteful.
 */
function collectWatchedEntities(cfg) {
  const ids = new Set();
  const add = (e) => e && ids.add(e);

  if (cfg.solar.enabled) {
    add(cfg.solar.power_entity);
    add(cfg.solar.energy_today_entity);
  }

  add(cfg.battery.power_entity);
  add(cfg.battery.soc_entity);
  add(cfg.battery.energy_in_today_entity);
  add(cfg.battery.energy_out_today_entity);

  add(cfg.grid.power_entity);
  add(cfg.grid.voltage_entity);
  add(cfg.grid.energy_in_today_entity);
  add(cfg.grid.energy_out_today_entity);

  if (cfg.grid.three_phase.enabled) {
    cfg.grid.three_phase.phases.forEach((p) => {
      add(p.power_entity);
      add(p.voltage_entity);
      add(p.current_entity);
    });
  }

  add(cfg.load.power_entity);
  add(cfg.load.percentage_entity);
  add(cfg.load.energy_today_entity);

  add(cfg.inverter.output_source_priority_entity);
  add(cfg.inverter.charger_source_priority_entity);

  if (cfg.generator.enabled) {
    add(cfg.generator.power_entity);
    add(cfg.generator.status_entity);
    add(cfg.generator.fuel_level_entity);
    add(cfg.generator.energy_today_entity);
  }

  cfg.load_separators.forEach((s) => {
    add(s.power_entity);
    add(s.energy_today_entity);
  });

  return ids;
}

// ============================================================================
// State derivation — extract all numeric / display state from hass once
// ============================================================================

/**
 * Pull every value the renderers need out of hass, in one place. Returns a
 * single "state" object the render functions can consume. Centralising this
 * keeps the renderers pure.
 */
function deriveState(hass, cfg) {
  // When solar is disabled, force its values to 0 regardless of whatever
  // entity is configured. This means downstream flow detection (solarOn,
  // contribution mix) treats it as not present.
  const pv = cfg.solar.enabled
    ? getStateFloat(hass, cfg.solar.power_entity)
    : 0;
  const pvToday = cfg.solar.enabled
    ? getStateFloat(hass, cfg.solar.energy_today_entity)
    : 0;

  const batt = getStateFloat(hass, cfg.battery.power_entity);
  const soc = getStateFloat(hass, cfg.battery.soc_entity);
  const battInToday = getStateFloat(hass, cfg.battery.energy_in_today_entity);
  const battOutToday = getStateFloat(hass, cfg.battery.energy_out_today_entity);

  const grid = getStateFloat(hass, cfg.grid.power_entity);
  // Voltage: if 3-phase, take the max of the available phases for the
  // grid-on/off detection. Single-phase uses the configured voltage entity.
  let gridV = 0;
  if (cfg.grid.three_phase.enabled) {
    const vs = cfg.grid.three_phase.phases
      .map((p) => getStateFloat(hass, p.voltage_entity))
      .filter((v) => v > 0);
    gridV = vs.length ? Math.max(...vs) : 0;
  } else if (cfg.grid.voltage_entity) {
    gridV = getStateFloat(hass, cfg.grid.voltage_entity);
  } else {
    // No voltage entity configured — assume grid is "on" so we don't show
    // false grid-off alerts. Users without voltage monitoring just don't get
    // the grid-off detection feature.
    gridV = 230;
  }
  const gridInToday = getStateFloat(hass, cfg.grid.energy_in_today_entity);
  const gridOutToday = getStateFloat(hass, cfg.grid.energy_out_today_entity);

  // Three-phase per-phase detail
  const phases = cfg.grid.three_phase.enabled
    ? cfg.grid.three_phase.phases.map((p) => ({
        label: p.label,
        voltage: p.voltage_entity ? getStateFloat(hass, p.voltage_entity) : null,
        current: p.current_entity ? getStateFloat(hass, p.current_entity) : null,
        power: p.power_entity ? getStateFloat(hass, p.power_entity) : null,
      }))
    : [];

  const load = getStateFloat(hass, cfg.load.power_entity);
  const loadPct = cfg.load.percentage_entity
    ? getStateFloat(hass, cfg.load.percentage_entity)
    : null;
  const loadToday = getStateFloat(hass, cfg.load.energy_today_entity);

  const outSrcRaw = getStateString(
    hass,
    cfg.inverter.output_source_priority_entity
  );
  const chgSrcRaw = getStateString(
    hass,
    cfg.inverter.charger_source_priority_entity
  );

  const gen = cfg.generator.enabled
    ? {
        power: getStateFloat(hass, cfg.generator.power_entity),
        statusRaw: cfg.generator.status_entity
          ? getStateString(hass, cfg.generator.status_entity)
          : null,
        fuel: cfg.generator.fuel_level_entity
          ? getStateFloat(hass, cfg.generator.fuel_level_entity, -1)
          : -1,
        today: getStateFloat(hass, cfg.generator.energy_today_entity),
      }
    : null;

  const separators = cfg.load_separators.map((s) => ({
    name: s.name,
    icon: s.icon,
    color: s.color,
    power: getStateFloat(hass, s.power_entity),
    today: getStateFloat(hass, s.energy_today_entity),
    on: getStateFloat(hass, s.power_entity) > s.threshold_w,
  }));

  // Derived flow flags
  const T = DEFAULTS.flow_threshold_w;
  const Tb = DEFAULTS.battery_flow_threshold_w;
  const Tl = DEFAULTS.load_threshold_w;

  const solarOn = cfg.solar.enabled && pv > cfg.solar.production_threshold_w;
  const battCharging = batt > Tb;
  const battDischarging = batt < -Tb;
  const gridOff = gridV < cfg.grid.voltage_threshold;
  const gridImporting = !gridOff && grid > T;
  const gridExporting = !gridOff && grid < -T;
  const loadOn = load > Tl;
  const genOn = gen
    ? (gen.statusRaw
        ? gen.statusRaw === "on"
        : gen.power > cfg.generator.threshold_w)
    : false;

  return {
    pv, pvToday,
    batt, soc, battInToday, battOutToday,
    grid, gridV, gridInToday, gridOutToday,
    phases,
    load, loadPct, loadToday,
    outSrc: shortenSelectValue(outSrcRaw),
    chgSrc: shortenSelectValue(chgSrcRaw),
    gen, genOn,
    separators,
    solarOn, battCharging, battDischarging, gridOff, gridImporting,
    gridExporting, loadOn,
  };
}

// ============================================================================
// Color computation — context-aware colors for each node and flow line
// ============================================================================

function computeColors(s, cfg) {
  const cSol = s.solarOn ? COLORS.solar : COLORS.idle;

  const cGrd = s.gridOff
    ? COLORS.grid_off
    : s.gridImporting
    ? COLORS.grid_import
    : s.gridExporting
    ? COLORS.grid_export
    : COLORS.idle;

  let cBat = COLORS.idle;
  if (s.battCharging) cBat = COLORS.battery_charging;
  else if (s.battDischarging) {
    const a = Math.abs(s.batt);
    cBat =
      a <= 1000
        ? COLORS.battery_low_dis
        : a <= 2500
        ? COLORS.battery_med_dis
        : COLORS.battery_high_dis;
  }

  // Load color from percentage if available, otherwise from absolute draw
  let cLoad;
  if (s.loadPct !== null) {
    cLoad =
      s.loadPct <= 40
        ? COLORS.load_low
        : s.loadPct <= 60
        ? COLORS.load_med
        : s.loadPct <= 80
        ? COLORS.load_high
        : COLORS.load_max;
  } else {
    // No percentage entity — use a sliding scale on absolute watts
    cLoad =
      s.load <= 500
        ? COLORS.load_low
        : s.load <= 1500
        ? COLORS.load_med
        : s.load <= 3000
        ? COLORS.load_high
        : COLORS.load_max;
  }

  const cGen = s.genOn ? COLORS.generator : COLORS.idle;

  // Inverter color: matches the dominant active source
  const pvNet = Math.max(0, s.pv - Math.max(0, s.batt));
  const battDis = Math.max(0, -s.batt);
  const gridImp = Math.max(0, s.grid);
  const genContrib = s.genOn ? Math.max(0, s.gen?.power || 0) : 0;
  const totalSrc = pvNet + battDis + gridImp + genContrib;

  let cInv = COLORS.idle;
  if (s.loadOn && totalSrc > 0) {
    const max = Math.max(pvNet, battDis, gridImp, genContrib);
    if (max === pvNet) cInv = cSol;
    else if (max === battDis) cInv = cBat;
    else if (max === gridImp) cInv = cGrd;
    else cInv = cGen;
  }

  return { cSol, cGrd, cBat, cLoad, cGen, cInv,
           pvNet, battDis, gridImp, genContrib, totalSrc };
}

// ============================================================================
// ETA computation — "battery full in" / "empty in"
// ============================================================================

function computeBatteryEta(s, cfg) {
  if (s.battCharging && s.batt > 50 && s.soc < 100) {
    const h = ((100 - s.soc) / 100) * cfg.battery.capacity_kwh / (s.batt / 1000);
    return { label: "FULL IN", value: fmtHoursMinutes(h) };
  }
  if (s.battDischarging && Math.abs(s.batt) > 50 && s.soc > cfg.battery.min_soc_percent) {
    const usable = ((s.soc - cfg.battery.min_soc_percent) / 100) * cfg.battery.capacity_kwh;
    const h = usable / (Math.abs(s.batt) / 1000);
    return { label: "EMPTY IN", value: fmtHoursMinutes(h) };
  }
  if (s.battDischarging && s.soc <= cfg.battery.min_soc_percent) {
    return { label: "AT CUTOFF", value: `${cfg.battery.min_soc_percent}%` };
  }
  return null;
}

// Sun position (0..1) along the daylight arc, used to draw the solar arc dot
function computeSunPosition() {
  const now = new Date();
  return Math.max(0, Math.min(1, (now.getHours() + now.getMinutes() / 60 - 6) / 12));
}

// ============================================================================
// Layout — pick geometry based on which optional sections are visible
// ============================================================================

/**
 * Returns all positioning data the renderers need — node `top:%` values, SVG
 * viewBox, flow line endpoints, container aspect ratio. Computed once per
 * render so we don't repeat geometry decisions inline in each renderer.
 *
 * Two layout modes:
 *  - "tall" (solar enabled): the original 5-node layout with solar at the top
 *    and battery at the bottom, aspect ratio ~1:1.05.
 *  - "short" (solar disabled): solar zone removed, vertical canvas trimmed to
 *    roughly 2/3 of tall, grid/load/inverter line near the top, battery below.
 *
 * Battery and generator vertical positions also shift up slightly in "short"
 * mode so the layout stays balanced.
 */
function computeLayout(cfg) {
  if (cfg.solar.enabled) {
    // Tall layout — original v0.1.0 geometry, unchanged.
    return {
      mode: "tall",
      aspectRatio: "1/1.05",
      flowViewBox: "0 0 500 460",
      nodes: {
        solar:     { left: "50%", top: "14%" },
        grid:      { left: "16%", top: "50%" },
        generator: { left: "16%", top: "78%" },
        load:      { left: "84%", top: "50%" },
        battery:   { left: "50%", top: "84%" },
      },
      inverter: { topPercent: 50 },
      flow: {
        solarToInverter:     { x1: 250, y1: 116, x2: 250, y2: 196 },
        gridToInverter:      { x1: 124, y1: 230, x2: 206, y2: 230 },
        inverterToLoad:      { x1: 294, y1: 230, x2: 376, y2: 230 },
        inverterToBatt:      { x1: 250, y1: 274, x2: 250, y2: 344 },
        generatorToInverter: { x1: 124, y1: 354, x2: 206, y2: 274 },
        boltsTransform:      "translate(250,120)",
      },
    };
  }

  // Short layout — solar zone removed. Canvas is ~62% of original height.
  // Inverter sits near the upper-third with grid/load on its sides, battery
  // below. Generator (when enabled) tucks into the lower-left.
  return {
    mode: "short",
    aspectRatio: "1/0.65",
    flowViewBox: "0 0 500 290",
    nodes: {
      // No "solar" entry — render code already gates on cfg.solar.enabled
      grid:      { left: "16%", top: "30%" },
      generator: { left: "16%", top: "72%" },
      load:      { left: "84%", top: "30%" },
      battery:   { left: "50%", top: "78%" },
    },
    inverter: { topPercent: 30 },
    flow: {
      // Horizontal grid→inverter→load line is at y=80 (instead of 230)
      gridToInverter:      { x1: 124, y1: 80, x2: 206, y2: 80 },
      inverterToLoad:      { x1: 294, y1: 80, x2: 376, y2: 80 },
      // Battery line is shorter — from inverter bottom (y=124) down to
      // battery top (y=200)
      inverterToBatt:      { x1: 250, y1: 124, x2: 250, y2: 200 },
      // Generator approaches inverter from lower-left
      generatorToInverter: { x1: 124, y1: 215, x2: 206, y2: 124 },
    },
  };
}

// ============================================================================
// SVG icon templates
// ============================================================================

const SVG_ICONS = {
  solarPanel: (cSol, solarOn) => `
    <svg viewBox="0 0 80 64" width="62" height="50">
      <rect x="8" y="14" width="64" height="44" rx="3" fill="#1e293b" stroke="${cSol}" stroke-width="1.5"/>
      <line x1="24" y1="14" x2="24" y2="58" stroke="${cSol}66"/>
      <line x1="40" y1="14" x2="40" y2="58" stroke="${cSol}66"/>
      <line x1="56" y1="14" x2="56" y2="58" stroke="${cSol}66"/>
      <line x1="8"  y1="30" x2="72" y2="30" stroke="${cSol}66"/>
      <line x1="8"  y1="46" x2="72" y2="46" stroke="${cSol}66"/>
      <rect x="8" y="14" width="64" height="44" rx="3" fill="${cSol}" opacity="${solarOn ? 0.18 : 0.05}"/>
      <circle cx="40" cy="6" r="4" fill="${solarOn ? COLORS.solar : "#475569"}"/>
      ${solarOn ? `
        <circle cx="40" cy="6" r="6" fill="none" stroke="${COLORS.solar}" stroke-width="1" opacity="0.5">
          <animate attributeName="r" values="4;9;4" dur="2s" repeatCount="indefinite"/>
          <animate attributeName="opacity" values="0.6;0;0.6" dur="2s" repeatCount="indefinite"/>
        </circle>` : ""}
    </svg>`,

  gridPylon: (cGrd, gridOff) => `
    <svg viewBox="0 0 80 84" width="44" height="46">
      <path d="M40 4 L22 78 M40 4 L58 78" stroke="${cGrd}" stroke-width="2.5" fill="none"/>
      <path d="M40 4 L40 24" stroke="${cGrd}" stroke-width="2"/>
      <path d="M28 28 L52 28" stroke="${cGrd}" stroke-width="2"/>
      <path d="M26 46 L54 46" stroke="${cGrd}" stroke-width="2"/>
      <path d="M24 62 L56 62" stroke="${cGrd}" stroke-width="2"/>
      <path d="M28 28 L26 46 M52 28 L54 46 M26 46 L24 62 M54 46 L56 62" stroke="${cGrd}" stroke-width="1"/>
      <circle cx="40" cy="4" r="2.5" fill="${cGrd}"/>
      <circle cx="28" cy="28" r="2" fill="${cGrd}"/>
      <circle cx="52" cy="28" r="2" fill="${cGrd}"/>
      <circle cx="26" cy="46" r="2" fill="${cGrd}"/>
      <circle cx="54" cy="46" r="2" fill="${cGrd}"/>
      <line x1="16" y1="80" x2="64" y2="80" stroke="${cGrd}" stroke-width="1.5"/>
      ${gridOff ? `
        <line x1="10" y1="10" x2="70" y2="74" stroke="${COLORS.text_alert}" stroke-width="4" stroke-linecap="round"/>
        <line x1="10" y1="10" x2="70" y2="74" stroke="${COLORS.alert_red_light}" stroke-width="1.5" stroke-linecap="round"/>
      ` : ""}
    </svg>`,

  house: (cLoad) => `
    <svg viewBox="0 0 80 70" width="42" height="36">
      <path d="M8 38 L40 12 L72 38 L72 62 L8 62 Z" fill="#1e293b" stroke="${cLoad}" stroke-width="1.5"/>
      <path d="M8 38 L40 12 L72 38" fill="${cLoad}" opacity="0.25" stroke="${cLoad}" stroke-width="1.5"/>
      <rect x="50" y="18" width="6"  height="11" fill="${cLoad}33" stroke="${cLoad}" stroke-width="1"/>
      <rect x="36" y="44" width="8"  height="18" fill="${cLoad}" opacity="0.55"/>
      <rect x="22" y="44" width="9"  height="9"  fill="${cLoad}" opacity="0.45" stroke="${cLoad}" stroke-width="0.5"/>
      <rect x="49" y="44" width="9"  height="9"  fill="${cLoad}" opacity="0.45" stroke="${cLoad}" stroke-width="0.5"/>
    </svg>`,

  battery: (cBat, soc, minSoc, ch) => `
    <svg viewBox="0 0 60 88" width="34" height="50">
      <rect x="22" y="0" width="16" height="6" rx="1.5" fill="#475569"/>
      <rect x="6"  y="8" width="48" height="78" rx="5" fill="#1e293b" stroke="${cBat}" stroke-width="1.5"/>
      <rect x="9"  y="${11 + 72 * (1 - soc / 100)}" width="42" height="${72 * soc / 100}" rx="2.5" fill="${cBat}" opacity="0.75"/>
      <line x1="6" y1="${11 + 72 * (1 - minSoc / 100)}" x2="54" y2="${11 + 72 * (1 - minSoc / 100)}"
            stroke="${COLORS.text_alert}" stroke-width="0.8" stroke-dasharray="2 2" opacity="0.6"/>
      ${ch ? `<path d="M30 28 L22 50 L29 50 L24 64 L38 42 L30 42 L34 28 Z" fill="white" opacity="0.95"/>` : ""}
    </svg>`,

  generator: (cGen, on) => `
    <svg viewBox="0 0 80 64" width="44" height="38">
      <rect x="8" y="20" width="64" height="32" rx="4" fill="#1e293b" stroke="${cGen}" stroke-width="1.5"/>
      <rect x="14" y="26" width="20" height="20" rx="2" fill="${cGen}" opacity="${on ? 0.35 : 0.1}"/>
      <text x="24" y="40" font-size="10" fill="${cGen}" text-anchor="middle" font-weight="700" font-family="monospace">G</text>
      <line x1="40" y1="28" x2="64" y2="28" stroke="${cGen}" stroke-width="1.2"/>
      <line x1="40" y1="34" x2="64" y2="34" stroke="${cGen}" stroke-width="1.2"/>
      <line x1="40" y1="40" x2="64" y2="40" stroke="${cGen}" stroke-width="1.2"/>
      <circle cx="50" cy="14" r="3" fill="${on ? cGen : "#475569"}"/>
      ${on ? `
        <circle cx="50" cy="14" r="5" fill="none" stroke="${cGen}" stroke-width="1" opacity="0.5">
          <animate attributeName="r" values="3;7;3" dur="1.5s" repeatCount="indefinite"/>
          <animate attributeName="opacity" values="0.5;0;0.5" dur="1.5s" repeatCount="indefinite"/>
        </circle>` : ""}
      <line x1="14" y1="58" x2="66" y2="58" stroke="${cGen}" stroke-width="1.5"/>
    </svg>`,

  // Generic separator badge — uses an mdi icon name to fetch via ha-icon. We
  // can't include arbitrary mdi paths inline, so the separator chip renders an
  // <ha-icon> element instead. This SVG is a fallback if ha-icon is missing.
  separatorFallback: (color) => `
    <svg viewBox="0 0 24 24" width="20" height="20">
      <circle cx="12" cy="12" r="9" fill="none" stroke="${color}" stroke-width="2"/>
      <path d="M12 7 L12 17 M7 12 L17 12" stroke="${color}" stroke-width="2" stroke-linecap="round"/>
    </svg>`,
};

// ============================================================================
// CSS — packaged as a single block injected at render time
// ============================================================================

function renderCss(cInv, layout) {
  return `
    .pfc{font-family:var(--primary-font-family,system-ui);color:${COLORS.text};
         font-variant-numeric:tabular-nums;display:flex;flex-direction:column;
         width:100%;overflow:hidden;box-sizing:border-box;}
    .pfc *{box-sizing:border-box;}
    .pfc-title{font-size:13px;letter-spacing:.16em;font-weight:700;
               color:${COLORS.text_muted};padding:12px 14px 0;}

    .pfc-arc{position:relative;height:54px;border-bottom:1px solid ${COLORS.panel_dim}88;
             background:linear-gradient(180deg,${COLORS.bg_dark} 0%,transparent 100%);}
    .pfc-arc svg{display:block;width:100%;height:100%;}

    .pfc-main{position:relative;aspect-ratio:${layout.aspectRatio};width:100%;max-width:520px;
              margin:0 auto;box-sizing:border-box;overflow:hidden;}
    .pfc-main > svg.flow{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;}

    .pfc-node{position:absolute;transform:translate(-50%,-50%);display:flex;
              flex-direction:column;align-items:center;gap:3px;text-align:center;
              max-width:26%;box-sizing:border-box;}
    .pfc-label{font-size:9px;letter-spacing:.18em;font-weight:700;color:${COLORS.text_muted};}
    .pfc-val{font-size:14px;font-weight:700;}
    .pfc-sub{font-size:9.5px;color:${COLORS.text_dim};line-height:1.25;}
    .pfc-eta{font-size:9.5px;letter-spacing:.08em;font-weight:600;margin-top:2px;}

    .pfc-ring{width:64px;height:64px;border-radius:50%;padding:4px;box-sizing:border-box;
              display:flex;transition:background .4s;}
    .pfc-ring-inner{width:100%;height:100%;background:${COLORS.bg_dark};border-radius:50%;
                    display:flex;align-items:center;justify-content:center;}

    .pfc-inv{position:absolute;left:50%;top:${layout.inverter.topPercent}%;transform:translate(-50%,-50%);
             width:18%;aspect-ratio:1;min-width:78px;max-width:100px;
             border-radius:12px;background:${COLORS.bg_darker};border:2px solid ${cInv};
             box-shadow:0 0 14px ${cInv}99,inset 0 0 10px ${cInv}33;
             display:flex;flex-direction:column;justify-content:center;
             padding:5px 6px;gap:2px;box-sizing:border-box;
             transition:border-color .4s, box-shadow .4s;}
    .pfc-inv::before{content:'';position:absolute;inset:-4px;border-radius:15px;
                     border:1px solid ${cInv}44;pointer-events:none;}
    .pfc-inv .lbl{font-size:8.5px;letter-spacing:.14em;color:${cInv};font-weight:800;
                  text-align:center;margin-bottom:2px;border-bottom:1px solid ${cInv}33;
                  padding-bottom:2px;}
    .pfc-inv .iv-row{display:flex;justify-content:space-between;align-items:baseline;gap:3px;}
    .pfc-inv .iv-l{font-size:7.5px;letter-spacing:.08em;color:${COLORS.text_muted};font-weight:700;}
    .pfc-inv .iv-v{font-size:9.5px;font-weight:700;color:#fff;text-align:right;
                   overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
                   flex:1;min-width:0;}

    .pfc-phases{padding:6px 10px;background:${COLORS.bg_darker};border-top:1px solid ${COLORS.panel_dim};
                display:grid;grid-template-columns:repeat(3,1fr);gap:6px;}
    .pfc-phase{display:flex;flex-direction:column;align-items:center;gap:1px;
               padding:4px;background:${COLORS.bg_dark};border-radius:6px;border:1px solid ${COLORS.panel_dim};}
    .pfc-phase .pl{font-size:9px;letter-spacing:.1em;font-weight:800;color:${COLORS.text_muted};}
    .pfc-phase .pv{font-size:11px;font-weight:700;color:#fff;}
    .pfc-phase .pi{font-size:9px;color:${COLORS.text_dim};}

    .pfc-seps{display:flex;flex-wrap:wrap;gap:6px;padding:8px 10px;
              background:${COLORS.bg_darker};border-top:1px solid ${COLORS.panel_dim};}
    .pfc-sep{flex:1 1 0;min-width:0;display:flex;align-items:center;gap:6px;
             padding:6px 8px;border-radius:8px;background:${COLORS.bg_dark};
             border:1px solid ${COLORS.panel_dim};transition:border-color .3s,box-shadow .3s;}
    .pfc-sep.on{border-color:var(--sep-color);box-shadow:0 0 8px var(--sep-color)55;}
    .pfc-sep .si{flex-shrink:0;color:var(--sep-color);
                 opacity:var(--sep-icon-opacity,0.4);transition:opacity .3s;
                 --mdc-icon-size:20px;}
    .pfc-sep.on .si{opacity:1;}
    .pfc-sep .sb{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1;}
    .pfc-sep .sn{font-size:9px;letter-spacing:.14em;font-weight:700;color:${COLORS.text_muted};
                 white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .pfc-sep .sv{font-size:11px;font-weight:700;color:#fff;white-space:nowrap;}
    .pfc-sep.off .sv{color:${COLORS.separator_off};}

    .pfc-foot{display:grid;gap:1px;background:${COLORS.panel_dim};}
    .pfc-foot.cols-6{grid-template-columns:repeat(6,minmax(0,1fr));}
    .pfc-foot.cols-7{grid-template-columns:repeat(7,minmax(0,1fr));}
    .pfc-foot .c{background:${COLORS.bg_dark};padding:7px 1px;display:flex;flex-direction:column;
                 align-items:center;gap:2px;min-width:0;overflow:hidden;}
    .pfc-foot .l{font-size:7.5px;letter-spacing:.04em;color:${COLORS.text_dim};font-weight:600;white-space:nowrap;}
    .pfc-foot .v{font-size:10.5px;font-weight:700;color:#fff;white-space:nowrap;}

    @keyframes pfc-flow{from{stroke-dashoffset:32;}to{stroke-dashoffset:0;}}
    @keyframes pfc-pour{0%{transform:translateY(-12px);opacity:0;}20%{opacity:1;}
                        80%{opacity:1;}100%{transform:translateY(58px);opacity:0;}}
    @keyframes pfc-alert{0%,100%{opacity:1;}50%{opacity:.4;}}
    .pour-b{animation:pfc-pour .9s linear infinite;}
    .pour-b:nth-child(2){animation-delay:.15s;}
    .pour-b:nth-child(3){animation-delay:.3s;}
    .pour-b:nth-child(4){animation-delay:.45s;}
    .pour-b:nth-child(5){animation-delay:.6s;}
    .grid-alert{animation:pfc-alert 1.6s ease-in-out infinite;}
  `;
}

// ============================================================================
// Render functions — each returns an HTML/SVG string fragment
// ============================================================================

/**
 * Single flow line between two points. Animated when `active`. `rev` reverses
 * the animation direction (so flow can visually go either way).
 */
function flowLine(x1, y1, x2, y2, active, rev, color) {
  return `
    <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"
          stroke="${COLORS.panel_dim}" stroke-width="3" stroke-linecap="round"/>
    ${active ? `
      <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"
            stroke="${color}" stroke-width="2.5"
            stroke-dasharray="6 10" stroke-linecap="round"
            style="animation:pfc-flow 1s linear infinite;
                   animation-direction:${rev ? "reverse" : "normal"};"/>
    ` : ""}
  `;
}

/**
 * Flow line composed of several proportional colored segments. Used for the
 * battery line when both PV and grid are charging it simultaneously — the
 * segments visually show the contribution of each source.
 */
function flowLineSegmented(x1, y1, x2, y2, segments, rev) {
  const base = `
    <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"
          stroke="${COLORS.panel_dim}" stroke-width="3" stroke-linecap="round"/>
  `;
  const total = segments.reduce((a, b) => a + b.frac, 0);
  if (total <= 0) return base;

  const dy = y2 - y1;
  let cur = 0;
  const parts = segments.filter((s) => s.frac > 0).map((s) => {
    const ya = y1 + dy * (cur / total);
    cur += s.frac;
    const yb = y1 + dy * (cur / total);
    return `
      <line x1="${x1}" y1="${ya}" x2="${x2}" y2="${yb}"
            stroke="${s.color}" stroke-width="2.5"
            stroke-dasharray="6 10" stroke-linecap="round"
            style="animation:pfc-flow 1s linear infinite;
                   animation-direction:${rev ? "reverse" : "normal"};"/>
    `;
  }).join("");
  return base + parts;
}

function renderSolarArc(solarOn) {
  const sPct = computeSunPosition();
  return `
    <div class="pfc-arc">
      <svg viewBox="0 0 500 54" preserveAspectRatio="none">
        <path d="M30 48 Q250 -18 470 48" stroke="${COLORS.panel_dim}"
              stroke-width="1" fill="none" stroke-dasharray="2 4"/>
        <circle cx="${30 + 440 * sPct}"
                cy="${48 - Math.sin(Math.PI * sPct) * 45}"
                r="${solarOn ? 6 : 3}"
                fill="${solarOn ? COLORS.solar : "#475569"}"
                opacity="${solarOn ? 1 : 0.5}">
          ${solarOn ? `<animate attributeName="r" values="5;7;5" dur="2.5s" repeatCount="indefinite"/>` : ""}
        </circle>
        <text x="32"  y="46" font-size="9" fill="${COLORS.text_dim}" letter-spacing="1">06:00</text>
        <text x="250" y="10" font-size="9" fill="${COLORS.text_dim}" text-anchor="middle" letter-spacing="1">12:00</text>
        <text x="468" y="46" font-size="9" fill="${COLORS.text_dim}" text-anchor="end"   letter-spacing="1">18:00</text>
      </svg>
    </div>
  `;
}

function renderSolarNode(s, c, layout) {
  const pos = layout.nodes.solar;
  return `
    <div class="pfc-node" style="left:${pos.left};top:${pos.top};">
      ${SVG_ICONS.solarPanel(c.cSol, s.solarOn)}
      <span class="pfc-label">SOLAR</span>
      <span class="pfc-val" style="color:${c.cSol};">${fmtPower(s.pv)}</span>
      ${s.pvToday ? `<span class="pfc-sub">TODAY ${fmtEnergy(s.pvToday)}</span>` : ""}
    </div>
  `;
}

function renderGridNode(s, c, cfg, layout) {
  const pos = layout.nodes.grid;
  const stateLine = s.gridOff
    ? "NO POWER"
    : `${fmtVoltage(s.gridV)} · ${s.gridImporting ? "IMPORT" : s.gridExporting ? "EXPORT" : "IDLE"}`;
  return `
    <div class="pfc-node ${s.gridOff ? "grid-alert" : ""}" style="left:${pos.left};top:${pos.top};">
      ${SVG_ICONS.gridPylon(c.cGrd, s.gridOff)}
      <span class="pfc-label" style="color:${s.gridOff ? COLORS.text_alert : COLORS.text_muted};">
        ${s.gridOff ? "GRID OFF" : "GRID"}
      </span>
      <span class="pfc-val" style="color:${c.cGrd};">${s.gridOff ? "—" : fmtPower(s.grid)}</span>
      <span class="pfc-sub">${stateLine}</span>
    </div>
  `;
}

function renderGeneratorNode(s, c, layout) {
  if (!s.gen) return "";
  const pos = layout.nodes.generator;
  return `
    <div class="pfc-node" style="left:${pos.left};top:${pos.top};">
      ${SVG_ICONS.generator(c.cGen, s.genOn)}
      <span class="pfc-label" style="color:${s.genOn ? COLORS.generator : COLORS.text_muted};">GENERATOR</span>
      <span class="pfc-val" style="color:${c.cGen};">${s.genOn ? fmtPower(s.gen.power) : "OFF"}</span>
      ${s.gen.fuel >= 0 ? `<span class="pfc-sub">FUEL ${s.gen.fuel.toFixed(0)}%</span>` : ""}
    </div>
  `;
}

function renderLoadNode(s, c, layout) {
  const pos = layout.nodes.load;
  const pctOrPower = s.loadPct !== null
    ? `${s.loadPct.toFixed(0)}%`
    : fmtPower(s.load);
  const sub = s.loadPct !== null
    ? `${fmtPower(s.load)}${s.loadToday ? ` · today ${fmtEnergy(s.loadToday)}` : ""}`
    : `${s.loadToday ? `today ${fmtEnergy(s.loadToday)}` : ""}`;

  // Conic-gradient ring showing source contribution mix
  let ringBg = COLORS.panel_dim;
  if (s.loadOn && c.totalSrc > 0) {
    const stops = [];
    let cur = 0;
    const add = (frac, color) => {
      if (frac <= 0) return;
      const end = cur + frac * 360;
      stops.push(`${color} ${cur}deg ${end}deg`);
      cur = end;
    };
    add(c.pvNet / c.totalSrc, c.cSol);
    add(c.battDis / c.totalSrc, c.cBat);
    add(c.gridImp / c.totalSrc, c.cGrd);
    add(c.genContrib / c.totalSrc, c.cGen);
    if (cur < 360) stops.push(`${COLORS.panel_dim} ${cur}deg 360deg`);
    ringBg = `conic-gradient(${stops.join(", ")})`;
  }

  return `
    <div class="pfc-node" style="left:${pos.left};top:${pos.top};">
      <div class="pfc-ring" style="background:${ringBg};">
        <div class="pfc-ring-inner">
          ${SVG_ICONS.house(c.cLoad)}
        </div>
      </div>
      <span class="pfc-label">LOAD</span>
      <span class="pfc-val" style="color:${c.cLoad};">${pctOrPower}</span>
      ${sub ? `<span class="pfc-sub">${sub}</span>` : ""}
    </div>
  `;
}

function renderBatteryNode(s, c, cfg, layout) {
  const pos = layout.nodes.battery;
  const eta = computeBatteryEta(s, cfg);
  const arrow = s.battCharging ? "↓ IN" : s.battDischarging ? "↑ OUT" : "";
  return `
    <div class="pfc-node" style="left:${pos.left};top:${pos.top};">
      ${SVG_ICONS.battery(c.cBat, s.soc, cfg.battery.min_soc_percent, s.battCharging)}
      <span class="pfc-label">BATTERY</span>
      <span class="pfc-val" style="color:${c.cBat};">${s.soc.toFixed(0)}%</span>
      <span class="pfc-sub">${arrow} ${fmtPower(s.batt)}</span>
      ${eta ? `<span class="pfc-eta" style="color:${c.cBat};">${eta.label} <span style="color:#fff;">${eta.value}</span></span>` : ""}
    </div>
  `;
}

function renderInverterCenter(s) {
  return `
    <div class="pfc-inv">
      <span class="lbl">INVERTER</span>
      <div class="iv-row"><span class="iv-l">OUT</span><span class="iv-v">${esc(s.outSrc)}</span></div>
      <div class="iv-row"><span class="iv-l">CHG</span><span class="iv-v">${esc(s.chgSrc)}</span></div>
    </div>
  `;
}

/**
 * Render the SVG-overlay flow lines connecting solar/grid/battery/load/inverter.
 * Coordinates and viewBox come from the layout object so the same renderer
 * works for both "tall" (solar enabled) and "short" (solar disabled) modes.
 */
function renderFlowLines(s, c, cfg, layout) {
  const pvCh   = s.battCharging ? Math.max(0, Math.min(s.batt, s.pv)) : 0;
  const gridCh = s.battCharging ? Math.max(0, s.batt - pvCh) : 0;
  const battSegments = [
    { frac: pvCh,   color: c.cSol },
    { frac: gridCh, color: c.cGrd },
  ];

  const f = layout.flow;

  // Solar→inverter line and "bolts" particle animation — only in tall layout
  const solarSection = (cfg.solar.enabled && f.solarToInverter && f.boltsTransform)
    ? `${flowLine(f.solarToInverter.x1, f.solarToInverter.y1,
                  f.solarToInverter.x2, f.solarToInverter.y2,
                  s.solarOn, false, c.cSol)}
       ${s.solarOn ? `
         <g transform="${f.boltsTransform}">
           ${[0, 1, 2, 3, 4].map(() => `
             <g class="pour-b">
               <path d="M0 0 L-3 9 L1 9 L-2 20 L4 7 L0 7 L3 0 Z" fill="${c.cSol}"/>
             </g>
           `).join("")}
         </g>` : ""}`
    : "";

  const genLine = (cfg.generator.enabled && f.generatorToInverter)
    ? flowLine(f.generatorToInverter.x1, f.generatorToInverter.y1,
               f.generatorToInverter.x2, f.generatorToInverter.y2,
               s.genOn, false, c.cGen)
    : "";

  const battLine = s.battCharging
    ? flowLineSegmented(f.inverterToBatt.x1, f.inverterToBatt.y1,
                        f.inverterToBatt.x2, f.inverterToBatt.y2,
                        battSegments, false)
    : flowLine(f.inverterToBatt.x1, f.inverterToBatt.y1,
               f.inverterToBatt.x2, f.inverterToBatt.y2,
               s.battDischarging, s.battDischarging, c.cBat);

  return `
    <svg class="flow" viewBox="${layout.flowViewBox}" preserveAspectRatio="none">
      ${solarSection}
      ${flowLine(f.gridToInverter.x1, f.gridToInverter.y1,
                 f.gridToInverter.x2, f.gridToInverter.y2,
                 s.gridImporting || s.gridExporting, s.gridExporting, c.cGrd)}
      ${flowLine(f.inverterToLoad.x1, f.inverterToLoad.y1,
                 f.inverterToLoad.x2, f.inverterToLoad.y2,
                 s.loadOn, false, c.cLoad)}
      ${battLine}
      ${genLine}
    </svg>
  `;
}

function renderThreePhaseDetail(s, cfg) {
  if (!cfg.grid.three_phase.enabled || s.phases.length === 0) return "";
  return `
    <div class="pfc-phases">
      ${s.phases.map((p) => `
        <div class="pfc-phase">
          <span class="pl">${esc(p.label)}</span>
          ${p.voltage !== null ? `<span class="pv">${fmtVoltage(p.voltage)}</span>` : ""}
          ${p.power !== null ? `<span class="pi">${fmtPower(p.power)}</span>` : ""}
          ${p.current !== null ? `<span class="pi">${fmtCurrent(p.current)}</span>` : ""}
        </div>
      `).join("")}
    </div>
  `;
}

function renderLoadSeparators(s) {
  if (!s.separators || s.separators.length === 0) return "";
  return `
    <div class="pfc-seps">
      ${s.separators.map((sep) => `
        <div class="pfc-sep ${sep.on ? "on" : "off"}" style="--sep-color:${esc(sep.color)};">
          <ha-icon icon="mdi:${esc(sep.icon)}" class="si"></ha-icon>
          <div class="sb">
            <span class="sn">${esc(sep.name.toUpperCase())}</span>
            <span class="sv">${sep.on ? fmtPower(sep.power) : "OFF"}</span>
          </div>
        </div>
      `).join("")}
    </div>
  `;
}

function renderEnergyFooter(s, c, cfg) {
  // Build the footer cells dynamically so users without certain entities don't
  // get blank columns. Generator total is the 7th column only when enabled.
  const cells = [];

  if (cfg.solar.enabled && cfg.solar.energy_today_entity) {
    cells.push({ l: "PV TODAY", v: fmtEnergy(s.pvToday), color: c.cSol });
  }
  if (cfg.load.energy_today_entity) {
    cells.push({ l: "LOAD TODAY", v: fmtEnergy(s.loadToday), color: c.cLoad });
  }
  if (cfg.grid.energy_in_today_entity) {
    cells.push({ l: "GRID IN", v: fmtEnergy(s.gridInToday), color: COLORS.text_alert });
  }
  if (cfg.grid.energy_out_today_entity) {
    cells.push({ l: "GRID OUT", v: fmtEnergy(s.gridOutToday), color: COLORS.grid_export });
  }
  if (cfg.battery.energy_in_today_entity) {
    cells.push({ l: "BATT IN", v: fmtEnergy(s.battInToday), color: "#3b82f6" });
  }
  if (cfg.battery.energy_out_today_entity) {
    cells.push({ l: "BATT OUT", v: fmtEnergy(s.battOutToday), color: c.cBat });
  }
  if (cfg.generator.enabled && cfg.generator.energy_today_entity) {
    cells.push({ l: "GEN TODAY", v: fmtEnergy(s.gen.today), color: COLORS.generator });
  }

  if (cells.length === 0) return "";
  const cls = cells.length <= 6 ? "cols-6" : "cols-7";
  return `
    <div class="pfc-foot ${cls}">
      ${cells.map((c2) => `
        <div class="c"><span class="l">${esc(c2.l)}</span>
                       <span class="v" style="color:${c2.color};">${esc(c2.v)}</span></div>
      `).join("")}
    </div>
  `;
}

/**
 * Top-level render. Assembles all pieces into the full card HTML.
 */
function renderCard(hass, cfg) {
  if (!hass) return `<div class="pfc"><div class="pfc-title">Loading…</div></div>`;
  // Resolve user color overrides over the defaults BEFORE deriving state or
  // computing flow colors — every renderer below reads from the resolved
  // COLORS palette.
  resolveColors(cfg.colors);
  const s = deriveState(hass, cfg);
  const c = computeColors(s, cfg);
  const layout = computeLayout(cfg);
  return `
    <style>${renderCss(c.cInv, layout)}</style>
    <div class="pfc">
      ${cfg.title ? `<div class="pfc-title">${esc(cfg.title.toUpperCase())}</div>` : ""}
      ${cfg.solar.enabled ? renderSolarArc(s.solarOn) : ""}
      <div class="pfc-main">
        ${renderFlowLines(s, c, cfg, layout)}
        ${cfg.solar.enabled ? renderSolarNode(s, c, layout) : ""}
        ${renderGridNode(s, c, cfg, layout)}
        ${cfg.generator.enabled ? renderGeneratorNode(s, c, layout) : ""}
        ${renderLoadNode(s, c, layout)}
        ${renderBatteryNode(s, c, cfg, layout)}
        ${renderInverterCenter(s)}
      </div>
      ${renderThreePhaseDetail(s, cfg)}
      ${renderLoadSeparators(s)}
      ${renderEnergyFooter(s, c, cfg)}
    </div>
  `;
}

// ============================================================================
// PowerFlowCard custom element
// ============================================================================

class PowerFlowCard extends HTMLElement {
  constructor() {
    super();
    this._hass = null;
    this._cfg = null;
    this._watched = new Set();
    this._lastStates = new Map(); // entityId -> stringified state for change detection
    this._renderQueued = false;
  }

  /**
   * Called by Lovelace once when the card is created or its config is edited.
   * Throws on invalid config to surface errors in the dashboard editor.
   */
  setConfig(config) {
    this._cfg = normalizeConfig(config);
    this._watched = collectWatchedEntities(this._cfg);
    this._lastStates.clear();
    this._render();
  }

  /**
   * Called by Lovelace on every HA state update. We re-render only when one
   * of our watched entities actually changed value.
   */
  set hass(hass) {
    this._hass = hass;
    if (!this._cfg) return;
    if (this._shouldRender(hass)) {
      this._queueRender();
    }
  }

  get hass() {
    return this._hass;
  }

  _shouldRender(hass) {
    if (!hass?.states) return false;
    let changed = false;
    for (const eid of this._watched) {
      const cur = hass.states[eid]?.state;
      const prev = this._lastStates.get(eid);
      if (cur !== prev) {
        this._lastStates.set(eid, cur);
        changed = true;
      }
    }
    return changed;
  }

  _queueRender() {
    if (this._renderQueued) return;
    this._renderQueued = true;
    requestAnimationFrame(() => {
      this._renderQueued = false;
      this._render();
    });
  }

  _render() {
    if (!this._cfg) return;
    try {
      this.innerHTML = renderCard(this._hass, this._cfg);
    } catch (err) {
      // Surface render errors visibly rather than silently breaking layout
      console.error("[power-flow-card] render error:", err);
      this.innerHTML = `
        <div style="padding:14px;color:#ef4444;font-family:monospace;">
          power-flow-card error: ${esc(err?.message || String(err))}
        </div>`;
    }
  }

  /** Estimated card height in HA grid units. */
  getCardSize() {
    if (!this._cfg) return 6;
    let n = 6;
    if (this._cfg.grid.three_phase.enabled) n += 1;
    if (this._cfg.load_separators.length > 0) n += 1;
    return n;
  }

  /** Used by the Lovelace card picker for the "Add Card" preview defaults. */
  static getStubConfig(_hass, entities) {
    // Try to auto-pick plausible defaults from the user's entities, but don't
    // fail if nothing matches — empty strings let the visual editor guide them.
    const find = (pattern) => {
      const re = new RegExp(pattern, "i");
      return (entities || []).find((e) => re.test(e)) || "";
    };
    return {
      type: `custom:${CARD_TAG}`,
      title: "Energy Flow",
      solar: { power_entity: find("solar|pv.*power"), energy_today_entity: find("pv.*energy|solar.*today") },
      battery: {
        power_entity: find("battery.*power"),
        soc_entity: find("battery.*(soc|charge|state_of_charge)"),
        capacity_kwh: 10,
        min_soc_percent: 20,
      },
      grid: { power_entity: find("grid.*power"), voltage_entity: find("grid.*volt") },
      load: { power_entity: find("load.*power|home.*power") },
      inverter: {},
      generator: { enabled: false },
      load_separators: [],
    };
  }

  /** Tells Lovelace to use our editor element. */
  static getConfigElement() {
    return document.createElement(EDITOR_TAG);
  }
}

// ============================================================================
// PowerFlowCardEditor custom element — visual configuration UI
// ============================================================================

class PowerFlowCardEditor extends HTMLElement {
  constructor() {
    super();
    this._hass = null;
    this._config = null;
    this._rendered = false;
  }

  setConfig(config) {
    this._config = config || {};
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  get hass() {
    return this._hass;
  }

  _fireConfigChanged(newConfig) {
    this._config = newConfig;
    const evt = new CustomEvent("config-changed", {
      detail: { config: newConfig },
      bubbles: true,
      composed: true,
    });
    this.dispatchEvent(evt);
  }

  /**
   * Build the ha-form schema. We use ha-form (HA's schema-driven form) because
   * building a full visual editor manually is enormous and brittle across HA
   * versions. ha-form handles entity pickers, expandable sections, validation,
   * and theming for us.
   *
   * Note: ha-form has limited support for arbitrary arrays of objects, so we
   * give each load separator a fixed slot (separator_1/2/3) as expandable
   * sub-sections. This is the cleanest fit for the user's "up to 3" constraint.
   */
  _schema() {
    const entity = (domain) => ({ entity: domain ? { domain } : {} });
    const optionalEntity = (domain) => ({ entity: domain ? { domain } : {}, multiple: false });

    return [
      { name: "title", selector: { text: {} } },

      {
        name: "solar",
        type: "expandable",
        title: "Solar",
        icon: "mdi:solar-power",
        schema: [
          { name: "enabled", selector: { boolean: {} } },
          { name: "power_entity", selector: optionalEntity("sensor") },
          { name: "energy_today_entity", selector: optionalEntity("sensor") },
          { name: "production_threshold_w", selector: { number: { min: 0, max: 1000, step: 10, unit_of_measurement: "W", mode: "box" } } },
        ],
      },

      {
        name: "battery",
        type: "expandable",
        title: "Battery",
        icon: "mdi:battery",
        schema: [
          { name: "power_entity", required: true, selector: entity("sensor") },
          { name: "soc_entity", required: true, selector: entity("sensor") },
          { name: "capacity_kwh", selector: { number: { min: 0.5, max: 200, step: 0.5, unit_of_measurement: "kWh", mode: "box" } } },
          { name: "min_soc_percent", selector: { number: { min: 0, max: 100, step: 1, unit_of_measurement: "%", mode: "box" } } },
          { name: "energy_in_today_entity", selector: optionalEntity("sensor") },
          { name: "energy_out_today_entity", selector: optionalEntity("sensor") },
        ],
      },

      {
        name: "grid",
        type: "expandable",
        title: "Grid",
        icon: "mdi:transmission-tower",
        schema: [
          { name: "power_entity", required: true, selector: entity("sensor") },
          { name: "voltage_entity", selector: optionalEntity("sensor") },
          { name: "voltage_threshold", selector: { number: { min: 0, max: 250, step: 1, unit_of_measurement: "V", mode: "box" } } },
          { name: "energy_in_today_entity", selector: optionalEntity("sensor") },
          { name: "energy_out_today_entity", selector: optionalEntity("sensor") },
          {
            name: "three_phase",
            type: "expandable",
            title: "Three-phase setup",
            icon: "mdi:sine-wave",
            schema: [
              { name: "enabled", selector: { boolean: {} } },
              { name: "l1_power_entity",   selector: optionalEntity("sensor") },
              { name: "l1_voltage_entity", selector: optionalEntity("sensor") },
              { name: "l1_current_entity", selector: optionalEntity("sensor") },
              { name: "l2_power_entity",   selector: optionalEntity("sensor") },
              { name: "l2_voltage_entity", selector: optionalEntity("sensor") },
              { name: "l2_current_entity", selector: optionalEntity("sensor") },
              { name: "l3_power_entity",   selector: optionalEntity("sensor") },
              { name: "l3_voltage_entity", selector: optionalEntity("sensor") },
              { name: "l3_current_entity", selector: optionalEntity("sensor") },
            ],
          },
        ],
      },

      {
        name: "load",
        type: "expandable",
        title: "Load (house)",
        icon: "mdi:home-lightning-bolt",
        schema: [
          { name: "power_entity", required: true, selector: entity("sensor") },
          { name: "percentage_entity", selector: optionalEntity("sensor") },
          { name: "energy_today_entity", selector: optionalEntity("sensor") },
        ],
      },

      {
        name: "inverter",
        type: "expandable",
        title: "Inverter (optional)",
        icon: "mdi:flash",
        schema: [
          { name: "output_source_priority_entity", selector: { entity: { domain: ["sensor", "select"] } } },
          { name: "charger_source_priority_entity", selector: { entity: { domain: ["sensor", "select"] } } },
        ],
      },

      {
        name: "generator",
        type: "expandable",
        title: "Generator (optional)",
        icon: "mdi:engine",
        schema: [
          { name: "enabled", selector: { boolean: {} } },
          { name: "power_entity", selector: optionalEntity("sensor") },
          { name: "status_entity", selector: { entity: { domain: ["binary_sensor", "switch", "sensor"] } } },
          { name: "fuel_level_entity", selector: optionalEntity("sensor") },
          { name: "energy_today_entity", selector: optionalEntity("sensor") },
          { name: "threshold_w", selector: { number: { min: 0, max: 5000, step: 1, unit_of_measurement: "W", mode: "box" } } },
        ],
      },

      ...this._separatorSchema(1, "First load separator (e.g. pool)"),
      ...this._separatorSchema(2, "Second load separator (e.g. geyser)"),
      ...this._separatorSchema(3, "Third load separator (e.g. EV charger)"),

      {
        name: "colors",
        type: "expandable",
        title: "Custom colors (optional)",
        icon: "mdi:palette",
        schema: [
          // Subset of the most-tweaked palette entries. Users wanting more
          // control can edit the full set via YAML — see README for the full
          // list of overridable keys.
          { name: "solar", selector: { color_rgb: {} } },
          { name: "battery_charging", selector: { color_rgb: {} } },
          { name: "battery_low_dis", selector: { color_rgb: {} } },
          { name: "battery_med_dis", selector: { color_rgb: {} } },
          { name: "battery_high_dis", selector: { color_rgb: {} } },
          { name: "grid_import", selector: { color_rgb: {} } },
          { name: "grid_export", selector: { color_rgb: {} } },
          { name: "grid_off", selector: { color_rgb: {} } },
          { name: "load_low", selector: { color_rgb: {} } },
          { name: "load_med", selector: { color_rgb: {} } },
          { name: "load_high", selector: { color_rgb: {} } },
          { name: "load_max", selector: { color_rgb: {} } },
          { name: "generator", selector: { color_rgb: {} } },
          { name: "idle", selector: { color_rgb: {} } },
        ],
      },
    ];
  }

  _separatorSchema(n, title) {
    return [
      {
        name: `separator_${n}`,
        type: "expandable",
        title,
        icon: "mdi:flash-outline",
        schema: [
          { name: "name", selector: { text: {} } },
          { name: "power_entity", selector: optionalEntity_("sensor") },
          { name: "energy_today_entity", selector: optionalEntity_("sensor") },
          { name: "icon", selector: { icon: {} } },
          { name: "color", selector: { color_rgb: {} } },
          { name: "threshold_w", selector: { number: { min: 0, max: 5000, step: 1, unit_of_measurement: "W", mode: "box" } } },
        ],
      },
    ];
  }

  /**
   * Convert the on-disk config into the flat shape ha-form expects.
   * (Three-phase phases array → flat l1_/l2_/l3_ fields, separators array →
   * separator_1/2/3 objects, rgb arrays stay as-is.)
   */
  _toFormData(cfg) {
    const data = { ...cfg };

    if (cfg.grid?.three_phase) {
      const tp = cfg.grid.three_phase;
      const flat = { enabled: !!tp.enabled };
      (tp.phases || []).forEach((p, i) => {
        const n = i + 1;
        if (p?.power_entity)   flat[`l${n}_power_entity`]   = p.power_entity;
        if (p?.voltage_entity) flat[`l${n}_voltage_entity`] = p.voltage_entity;
        if (p?.current_entity) flat[`l${n}_current_entity`] = p.current_entity;
      });
      data.grid = { ...cfg.grid, three_phase: flat };
    }

    (cfg.load_separators || []).slice(0, 3).forEach((s, i) => {
      data[`separator_${i + 1}`] = {
        name: s?.name,
        power_entity: s?.power_entity,
        energy_today_entity: s?.energy_today_entity,
        icon: s?.icon,
        color: this._hexToRgb(s?.color),
        threshold_w: s?.threshold_w,
      };
    });

    // Colors section: convert any hex strings the user has saved into the RGB
    // arrays the color_rgb selector expects. Leave unset keys absent so the
    // form shows them as not-set rather than defaulting to black.
    if (cfg.colors && typeof cfg.colors === "object") {
      const formColors = {};
      for (const [k, v] of Object.entries(cfg.colors)) {
        const rgb = this._hexToRgb(v);
        if (rgb) formColors[k] = rgb;
      }
      data.colors = formColors;
    }

    return data;
  }

  /** Inverse of _toFormData — assembles the form's flat fields back into config. */
  _fromFormData(data) {
    const cfg = { ...data };

    if (data.grid?.three_phase) {
      const tp = data.grid.three_phase;
      const phases = [1, 2, 3].map((n) => {
        const power = tp[`l${n}_power_entity`];
        const voltage = tp[`l${n}_voltage_entity`];
        const current = tp[`l${n}_current_entity`];
        if (!power && !voltage && !current) return null;
        return { label: `L${n}`, power_entity: power, voltage_entity: voltage, current_entity: current };
      }).filter(Boolean);
      cfg.grid = {
        ...data.grid,
        three_phase: { enabled: !!tp.enabled, phases },
      };
    }

    const seps = [];
    [1, 2, 3].forEach((n) => {
      const s = data[`separator_${n}`];
      if (s && s.power_entity) {
        seps.push({
          name: s.name || `Load ${n}`,
          power_entity: s.power_entity,
          energy_today_entity: s.energy_today_entity,
          icon: s.icon,
          color: Array.isArray(s.color) ? this._rgbToHex(s.color) : s.color,
          threshold_w: s.threshold_w,
        });
      }
      delete cfg[`separator_${n}`];
    });
    if (seps.length) cfg.load_separators = seps;

    // Colors section: convert RGB arrays back to hex strings for persistence.
    // Strip out any keys the user reset to undefined so we don't write empties.
    if (data.colors && typeof data.colors === "object") {
      const out = {};
      for (const [k, v] of Object.entries(data.colors)) {
        if (Array.isArray(v) && v.length === 3) {
          out[k] = this._rgbToHex(v);
        } else if (typeof v === "string" && v.trim()) {
          out[k] = v.trim();
        }
      }
      if (Object.keys(out).length) cfg.colors = out;
      else delete cfg.colors;
    }

    return cfg;
  }

  _hexToRgb(hex) {
    if (!hex) return undefined;
    if (Array.isArray(hex)) return hex;
    const m = String(hex).match(/^#?([0-9a-f]{6})$/i);
    if (!m) return undefined;
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  _rgbToHex(rgb) {
    if (!Array.isArray(rgb) || rgb.length !== 3) return undefined;
    const h = (v) => Math.max(0, Math.min(255, v|0)).toString(16).padStart(2, "0");
    return `#${h(rgb[0])}${h(rgb[1])}${h(rgb[2])}`;
  }

  _render() {
    if (!this._hass || !this._config) {
      this.innerHTML = "";
      return;
    }
    if (this._rendered) {
      // Update existing ha-form data instead of re-creating the element —
      // re-creating loses focus on the field the user is editing.
      const form = this.querySelector("ha-form");
      if (form) {
        form.hass = this._hass;
        form.data = this._toFormData(this._config);
        return;
      }
    }

    const schema = this._schema();
    this.innerHTML = `<ha-form></ha-form>`;
    const form = this.querySelector("ha-form");
    form.hass = this._hass;
    form.data = this._toFormData(this._config);
    form.schema = schema;
    form.computeLabel = (s) => this._labelFor(s.name);
    form.addEventListener("value-changed", (ev) => {
      const data = ev.detail.value;
      const newCfg = this._fromFormData(data);
      this._fireConfigChanged(newCfg);
    });
    this._rendered = true;
  }

  _labelFor(name) {
    const map = {
      title: "Card title",
      power_entity: "Power sensor",
      soc_entity: "State-of-charge sensor",
      voltage_entity: "Voltage sensor",
      energy_today_entity: "Energy today sensor",
      energy_in_today_entity: "Energy in today sensor",
      energy_out_today_entity: "Energy out today sensor",
      percentage_entity: "Load percentage sensor (optional)",
      capacity_kwh: "Battery capacity (kWh)",
      min_soc_percent: "Minimum SOC cutoff (%)",
      voltage_threshold: "Grid-off voltage threshold (V)",
      production_threshold_w: "Solar production threshold (W)",
      output_source_priority_entity: "Output source priority entity",
      charger_source_priority_entity: "Charger source priority entity",
      enabled: "Enabled",
      status_entity: "Status entity",
      fuel_level_entity: "Fuel level entity",
      threshold_w: "Power threshold (W)",
      name: "Display name",
      icon: "Icon",
      color: "Color",
      l1_power_entity: "L1 power", l1_voltage_entity: "L1 voltage", l1_current_entity: "L1 current",
      l2_power_entity: "L2 power", l2_voltage_entity: "L2 voltage", l2_current_entity: "L2 current",
      l3_power_entity: "L3 power", l3_voltage_entity: "L3 voltage", l3_current_entity: "L3 current",
      // Color override labels — readable names for the palette keys
      solar: "Solar",
      battery_charging: "Battery — charging",
      battery_low_dis: "Battery — light discharge (≤1 kW)",
      battery_med_dis: "Battery — medium discharge (≤2.5 kW)",
      battery_high_dis: "Battery — heavy discharge (>2.5 kW)",
      grid_import: "Grid — importing",
      grid_export: "Grid — exporting",
      grid_off: "Grid — offline",
      load_low: "Load — low (≤40%)",
      load_med: "Load — medium (≤60%)",
      load_high: "Load — high (≤80%)",
      load_max: "Load — peak (>80%)",
      generator: "Generator",
      idle: "Idle (no flow)",
    };
    return map[name] || name;
  }
}

// _separatorSchema uses a local helper that references `optionalEntity` which
// is defined inside _schema's scope; we lift a version here for the editor.
function optionalEntity_(domain) {
  return { entity: domain ? { domain } : {}, multiple: false };
}

// ============================================================================
// Register custom elements
// ============================================================================

if (!customElements.get(CARD_TAG)) {
  customElements.define(CARD_TAG, PowerFlowCard);
}
if (!customElements.get(EDITOR_TAG)) {
  customElements.define(EDITOR_TAG, PowerFlowCardEditor);
}
