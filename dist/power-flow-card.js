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

const CARD_VERSION = "0.3.0";
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
  const sepCount = cfg.load_separators.length;
  const hasSep1 = sepCount >= 1;          // top-right (alongside solar)
  const belowLoadCount = Math.max(0, sepCount - 1); // 0–2 below load

  if (cfg.solar.enabled) {
    // ─── TALL layout (solar enabled) ──────────────────────────────────────
    // viewBox is 500x460. sep1 at (84%, 16%) alongside solar; flow line is a
    // straight vertical from load-top up to sep1-bottom. sep2/sep3 below load
    // with a tee/branch flow pattern from load-bottom.
    //
    // When sep1 is the ONLY separator: just the top-right node + line.
    // When 2 separators: sep1 + sep2 centered below load (straight line down).
    // When 3 separators: sep1 + sep2/sep3 below load (tee/branch).

    // Geometry for the below-load tee/branch (viewBox coords)
    const loadX = 420, loadBottomY = 250;
    const stemEndY = 305;              // vertical stem from load bottom
    const branchY = 305;               // horizontal crossbar Y
    const sep2X = 370, sep3X = 470;    // L/R positions of below-load nodes (aligns to 74%/94% in viewBox 500)
                                       //   (match sep2/sep3 left% at 72%/92% of 500px)
    const sepTopY = 339;               // where the down-branch meets sep node

    const sepFlows = {};
    if (hasSep1) {
      // Top-right: from load top (y=210) up to sep1 bottom (y=100)
      sepFlows.loadToSep1 = { x1: 420, y1: 210, x2: 420, y2: 100 };
    }
    if (belowLoadCount === 1) {
      // Straight line down from load to centered sep below
      sepFlows.loadToSep2Straight = { x1: 420, y1: loadBottomY, x2: 420, y2: sepTopY };
    } else if (belowLoadCount === 2) {
      // Tee/branch: stem + crossbar + two short downs
      sepFlows.loadStem = { x1: loadX, y1: loadBottomY, x2: loadX, y2: stemEndY };
      sepFlows.branchBar = { x1: sep2X, y1: branchY, x2: sep3X, y2: branchY };
      sepFlows.sep2Down = { x1: sep2X, y1: branchY, x2: sep2X, y2: sepTopY };
      sepFlows.sep3Down = { x1: sep3X, y1: branchY, x2: sep3X, y2: sepTopY };
    }

    // Node positions for separators
    const sepNodes = {};
    if (hasSep1) sepNodes.sep1 = { left: "84%", top: "16%" };
    if (belowLoadCount === 1) {
      // Single sep below load, centered under load
      sepNodes.sep2 = { left: "84%", top: "78%" };
    } else if (belowLoadCount === 2) {
      // Two seps flanking the load column. sep3 pulled in from the right
      // edge to prevent the node from overflowing the card boundary.
      sepNodes.sep2 = { left: "72%", top: "78%" };
      sepNodes.sep3 = { left: "92%", top: "78%" };
    }

    return {
      mode: "tall",
      aspectRatio: "1/1.05",
      flowViewBox: "0 0 500 460",
      sepCount,
      nodes: {
        solar:     { left: "50%", top: "14%" },
        grid:      { left: "16%", top: "50%" },
        generator: { left: "16%", top: "78%" },
        load:      { left: "84%", top: "50%" },
        battery:   { left: "50%", top: "84%" },
        ...sepNodes,
      },
      inverter: { topPercent: 50 },
      flow: {
        solarToInverter:     { x1: 250, y1: 116, x2: 250, y2: 196 },
        gridToInverter:      { x1: 124, y1: 230, x2: 206, y2: 230 },
        inverterToLoad:      { x1: 294, y1: 230, x2: 376, y2: 230 },
        inverterToBatt:      { x1: 250, y1: 274, x2: 250, y2: 344 },
        generatorToInverter: { x1: 124, y1: 354, x2: 206, y2: 274 },
        boltsTransform:      "translate(250,120)",
        ...sepFlows,
      },
    };
  }

  // ─── SHORT layout (solar disabled) ──────────────────────────────────────
  // viewBox 500x290 by default. Separators all go below load in this mode
  // (no "alongside solar" position because solar is hidden). Card height
  // grows when separators are configured to make room for them below load.

  const hasAnySep = sepCount >= 1;
  // Card grows from 0.65 to 0.95 aspect when separators are present, giving
  // ~95px more of vertical room below the load row.
  const aspectRatio = hasAnySep ? "1/0.95" : "1/0.65";
  const flowViewBox = hasAnySep ? "0 0 500 425" : "0 0 500 290";

  // Geometry (viewBox 500 × 425 when separators present):
  //   - grid/inverter/load horizontal line moves up slightly to y=70
  //   - inverter→battery line: 95 → 195 (battery at y=240 area)
  //   - below-load tee/branch starts at load bottom y=90
  //   - separator nodes at y ≈ 195 (about 46% of 425)
  //   - battery moves down to y=55%-ish (e.g. 78% of card = 332)
  // For consistency with the tall layout, I'll keep node positions in
  // percentages of card height (which scales with the aspect ratio).

  // Below-load tee/branch in short mode
  const loadX = 420, loadBottomY = hasAnySep ? 92 : 100;
  const stemEndY = hasAnySep ? 165 : 200;
  const branchY = stemEndY;
  const sep2X = 370, sep3X = 470;
  const sepTopY = hasAnySep ? 200 : 235;

  const sepFlows = {};
  // In short mode there's no sep1 alongside solar. All separators are below load.
  // 1 separator → straight line from load down
  // 2 separators → tee/branch from load
  // 3 separators → tee with a center-stem-extending node (rare; documented)
  if (sepCount === 1) {
    sepFlows.loadToSep2Straight = { x1: loadX, y1: loadBottomY, x2: loadX, y2: sepTopY };
  } else if (sepCount >= 2) {
    sepFlows.loadStem = { x1: loadX, y1: loadBottomY, x2: loadX, y2: stemEndY };
    sepFlows.branchBar = { x1: sep2X, y1: branchY, x2: sep3X, y2: branchY };
    sepFlows.sep2Down = { x1: sep2X, y1: branchY, x2: sep2X, y2: sepTopY };
    sepFlows.sep3Down = { x1: sep3X, y1: branchY, x2: sep3X, y2: sepTopY };
    if (sepCount === 3) {
      // Third separator hangs off the center stem (cramped but works)
      sepFlows.sep1CenterDown = { x1: loadX, y1: stemEndY, x2: loadX, y2: sepTopY };
    }
  }

  const sepNodes = {};
  if (sepCount === 1) {
    sepNodes.sep2 = { left: "84%", top: "62%" };
  } else if (sepCount === 2) {
    sepNodes.sep2 = { left: "72%", top: "62%" };
    sepNodes.sep3 = { left: "92%", top: "62%" };
  } else if (sepCount === 3) {
    sepNodes.sep2 = { left: "72%", top: "62%" };
    sepNodes.sep1 = { left: "84%", top: "62%" }; // center-bottom of branch
    sepNodes.sep3 = { left: "92%", top: "62%" };
  }

  return {
    mode: "short",
    aspectRatio,
    flowViewBox,
    sepCount,
    nodes: {
      grid:      { left: "16%", top: hasAnySep ? "20%" : "30%" },
      generator: { left: "16%", top: hasAnySep ? "82%" : "72%" },
      load:      { left: "84%", top: hasAnySep ? "20%" : "30%" },
      battery:   { left: "50%", top: hasAnySep ? "82%" : "78%" },
      ...sepNodes,
    },
    inverter: { topPercent: hasAnySep ? 20 : 30 },
    flow: {
      gridToInverter:      hasAnySep ? { x1: 124, y1: 70, x2: 206, y2: 70 } : { x1: 124, y1: 80, x2: 206, y2: 80 },
      inverterToLoad:      hasAnySep ? { x1: 294, y1: 70, x2: 376, y2: 70 } : { x1: 294, y1: 80, x2: 376, y2: 80 },
      inverterToBatt:      hasAnySep ? { x1: 250, y1: 95, x2: 250, y2: 320 } : { x1: 250, y1: 124, x2: 250, y2: 200 },
      generatorToInverter: hasAnySep ? { x1: 124, y1: 340, x2: 206, y2: 95 } : { x1: 124, y1: 215, x2: 206, y2: 124 },
      ...sepFlows,
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
// Animated load-separator icons
//
// Each entry is a function (color, on) => SVG string. The `on` flag controls
// whether the animation is rendered; static base shape is shown either way.
// Color is applied to strokes / accent fills; interior fill uses a neutral
// dark slate so the icon reads against the card's dark background.
//
// Icon names are matched case-insensitively against the user's `icon:` config
// value. Anything that doesn't match falls through to ha-icon (`mdi:<name>`),
// preserving the v0.2.x behavior.
// ============================================================================

const ANIMATED_SEP_ICONS = {
  pool: (color, on) => `
    <svg viewBox="0 0 80 56" width="60" height="42">
      <ellipse cx="40" cy="36" rx="32" ry="14" fill="#1e293b" stroke="${color}" stroke-width="1.5"/>
      <ellipse cx="40" cy="34" rx="28" ry="11" fill="${color}" opacity="${on ? 0.45 : 0.15}"/>
      ${on ? `
        <path d="M16 34 Q24 30 32 34 T48 34 T64 34" stroke="${color}" stroke-width="1.2" fill="none" opacity="0.85">
          <animate attributeName="d"
            values="M16 34 Q24 30 32 34 T48 34 T64 34;M16 34 Q24 38 32 34 T48 34 T64 34;M16 34 Q24 30 32 34 T48 34 T64 34"
            dur="2s" repeatCount="indefinite"/>
        </path>` : ""}
      <circle cx="64" cy="14" r="6" fill="#1e293b" stroke="${color}" stroke-width="1.5"/>
      <path d="M60 14 L68 14 M64 10 L64 18" stroke="${color}" stroke-width="1"/>
    </svg>`,

  geyser: (color, on) => `
    <svg viewBox="0 0 60 80" width="42" height="56">
      <rect x="14" y="14" width="32" height="60" rx="6" fill="#1e293b" stroke="${color}" stroke-width="1.5"/>
      <rect x="18" y="10" width="24" height="6" rx="2" fill="${color}" opacity="${on ? 0.6 : 0.25}"/>
      <rect x="18" y="22" width="24" height="48" fill="${color}" opacity="${on ? 0.25 : 0.12}"/>
      <path d="M20 50 Q24 46 28 50 Q32 54 36 50 Q40 46 44 50" stroke="${color}" stroke-width="1.2" fill="none" opacity="${on ? 1 : 0.4}"/>
      ${on ? `
        <g opacity="0.6">
          <circle cx="22" cy="6" r="1.5" fill="${color}">
            <animate attributeName="cy" values="8;-4" dur="1.8s" repeatCount="indefinite"/>
            <animate attributeName="opacity" values="0;0.8;0" dur="1.8s" repeatCount="indefinite"/>
          </circle>
          <circle cx="30" cy="6" r="1.5" fill="${color}">
            <animate attributeName="cy" values="8;-4" dur="1.8s" repeatCount="indefinite" begin="0.6s"/>
            <animate attributeName="opacity" values="0;0.8;0" dur="1.8s" repeatCount="indefinite" begin="0.6s"/>
          </circle>
          <circle cx="38" cy="6" r="1.5" fill="${color}">
            <animate attributeName="cy" values="8;-4" dur="1.8s" repeatCount="indefinite" begin="1.2s"/>
            <animate attributeName="opacity" values="0;0.8;0" dur="1.8s" repeatCount="indefinite" begin="1.2s"/>
          </circle>
        </g>` : ""}
    </svg>`,

  ev: (color, on) => `
    <svg viewBox="0 0 80 56" width="56" height="40">
      <path d="M12 32 L20 22 L52 22 L60 32 L60 42 L12 42 Z" fill="#1e293b" stroke="${color}" stroke-width="1.5"/>
      <circle cx="22" cy="44" r="4" fill="${color}" opacity="0.7"/>
      <circle cx="50" cy="44" r="4" fill="${color}" opacity="0.7"/>
      <path d="M22 32 L26 24 L46 24 L50 32 Z" fill="${color}" opacity="0.3"/>
      <line x1="60" y1="34" x2="68" y2="34" stroke="${color}" stroke-width="2"/>
      <rect x="68" y="30" width="6" height="8" rx="1" fill="${color}" opacity="${on ? 1 : 0.4}"/>
      ${on ? `
        <path d="M40 12 L34 24 L40 24 L34 36" stroke="${color}" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
          <animate attributeName="opacity" values="0.3;1;0.3" dur="1s" repeatCount="indefinite"/>
        </path>` : ""}
    </svg>`,

  washing_machine: (color, on) => `
    <svg viewBox="0 0 60 80" width="42" height="56">
      <rect x="8" y="10" width="44" height="60" rx="4" fill="#1e293b" stroke="${color}" stroke-width="1.5"/>
      <line x1="14" y1="18" x2="46" y2="18" stroke="${color}" stroke-width="0.8" opacity="0.6"/>
      <circle cx="44" cy="22" r="1.5" fill="${color}"/>
      <circle cx="30" cy="44" r="14" fill="#1e293b" stroke="${color}" stroke-width="1.5"/>
      <circle cx="30" cy="44" r="10" fill="${color}" opacity="${on ? 0.3 : 0.15}"/>
      ${on ? `
        <g style="transform-origin:30px 44px;animation:pfc-spin 3s linear infinite;">
          <circle cx="30" cy="36" r="2" fill="${color}" opacity="0.8"/>
          <circle cx="38" cy="44" r="2" fill="${color}" opacity="0.8"/>
          <circle cx="30" cy="52" r="2" fill="${color}" opacity="0.8"/>
          <circle cx="22" cy="44" r="2" fill="${color}" opacity="0.8"/>
        </g>` : ""}
    </svg>`,

  heater: (color, on) => `
    <svg viewBox="0 0 80 80" width="56" height="56">
      <rect x="14" y="40" width="52" height="32" rx="4" fill="#1e293b" stroke="${color}" stroke-width="1.5"/>
      <line x1="20" y1="48" x2="60" y2="48" stroke="${color}" stroke-width="1" opacity="${on ? 1 : 0.4}"/>
      <line x1="20" y1="54" x2="60" y2="54" stroke="${color}" stroke-width="1" opacity="${on ? 1 : 0.4}"/>
      <line x1="20" y1="60" x2="60" y2="60" stroke="${color}" stroke-width="1" opacity="${on ? 1 : 0.4}"/>
      <line x1="20" y1="66" x2="60" y2="66" stroke="${color}" stroke-width="1" opacity="${on ? 1 : 0.4}"/>
      ${on ? `
        <g opacity="0.7">
          <path d="M24 38 Q24 30 28 30 Q32 30 32 22" stroke="${color}" stroke-width="1.2" fill="none">
            <animate attributeName="opacity" values="0;0.9;0" dur="2s" repeatCount="indefinite"/>
          </path>
          <path d="M40 38 Q40 30 44 30 Q48 30 48 22" stroke="${color}" stroke-width="1.2" fill="none">
            <animate attributeName="opacity" values="0;0.9;0" dur="2s" repeatCount="indefinite" begin="0.7s"/>
          </path>
          <path d="M56 38 Q56 30 60 30 Q64 30 64 22" stroke="${color}" stroke-width="1.2" fill="none">
            <animate attributeName="opacity" values="0;0.9;0" dur="2s" repeatCount="indefinite" begin="1.3s"/>
          </path>
        </g>` : ""}
    </svg>`,

  aircon: (color, on) => `
    <svg viewBox="0 0 80 50" width="60" height="38">
      <rect x="8" y="14" width="64" height="22" rx="3" fill="#1e293b" stroke="${color}" stroke-width="1.5"/>
      <line x1="12" y1="20" x2="68" y2="20" stroke="${color}" stroke-width="0.8" opacity="0.5"/>
      <line x1="12" y1="24" x2="68" y2="24" stroke="${color}" stroke-width="0.8" opacity="0.5"/>
      <circle cx="62" cy="30" r="1.5" fill="${color}" opacity="${on ? 1 : 0.3}"/>
      ${on ? `
        <g opacity="0.6">
          <path d="M20 38 Q24 42 20 46" stroke="${color}" stroke-width="1" fill="none" stroke-linecap="round">
            <animate attributeName="opacity" values="0;0.9;0" dur="1.5s" repeatCount="indefinite"/>
          </path>
          <path d="M36 38 Q40 42 36 46" stroke="${color}" stroke-width="1" fill="none" stroke-linecap="round">
            <animate attributeName="opacity" values="0;0.9;0" dur="1.5s" repeatCount="indefinite" begin="0.5s"/>
          </path>
          <path d="M52 38 Q56 42 52 46" stroke="${color}" stroke-width="1" fill="none" stroke-linecap="round">
            <animate attributeName="opacity" values="0;0.9;0" dur="1.5s" repeatCount="indefinite" begin="1s"/>
          </path>
        </g>` : ""}
    </svg>`,

  dishwasher: (color, on) => `
    <svg viewBox="0 0 60 80" width="42" height="56">
      <rect x="8" y="10" width="44" height="60" rx="3" fill="#1e293b" stroke="${color}" stroke-width="1.5"/>
      <line x1="12" y1="18" x2="48" y2="18" stroke="${color}" stroke-width="0.8" opacity="0.5"/>
      <rect x="12" y="22" width="36" height="44" rx="2" fill="#1e293b" stroke="${color}" stroke-width="1"/>
      <line x1="12" y1="40" x2="48" y2="40" stroke="${color}" stroke-width="0.5" opacity="0.4"/>
      ${on ? `
        <g opacity="0.7">
          <path d="M30 30 L26 38 M30 30 L34 38 M30 30 L22 36 M30 30 L38 36"
                stroke="${color}" stroke-width="1" stroke-linecap="round">
            <animate attributeName="opacity" values="0.3;0.95;0.3" dur="1s" repeatCount="indefinite"/>
          </path>
          <path d="M30 56 L26 48 M30 56 L34 48 M30 56 L22 50 M30 56 L38 50"
                stroke="${color}" stroke-width="1" stroke-linecap="round">
            <animate attributeName="opacity" values="0.3;0.95;0.3" dur="1s" repeatCount="indefinite" begin="0.5s"/>
          </path>
        </g>` : ""}
    </svg>`,

  dryer: (color, on) => `
    <svg viewBox="0 0 60 80" width="42" height="56">
      <rect x="8" y="10" width="44" height="60" rx="4" fill="#1e293b" stroke="${color}" stroke-width="1.5"/>
      <line x1="14" y1="18" x2="46" y2="18" stroke="${color}" stroke-width="0.8" opacity="0.6"/>
      <circle cx="30" cy="44" r="14" fill="#1e293b" stroke="${color}" stroke-width="1.5"/>
      <circle cx="30" cy="44" r="10" fill="${color}" opacity="${on ? 0.3 : 0.15}"/>
      <path d="M48 30 L48 38" stroke="${color}" stroke-width="2.5" stroke-linecap="round" opacity="${on ? 1 : 0.3}"/>
      ${on ? `
        <g style="transform-origin:30px 44px;animation:pfc-spin 2s linear infinite;">
          <circle cx="30" cy="36" r="1.5" fill="${color}" opacity="0.7"/>
          <circle cx="38" cy="44" r="1.5" fill="${color}" opacity="0.7"/>
          <circle cx="30" cy="52" r="1.5" fill="${color}" opacity="0.7"/>
          <circle cx="22" cy="44" r="1.5" fill="${color}" opacity="0.7"/>
        </g>
        <path d="M48 22 Q48 16 52 16" stroke="${color}" stroke-width="1" fill="none" opacity="0.5">
          <animate attributeName="opacity" values="0;1;0" dur="1.5s" repeatCount="indefinite"/>
        </path>` : ""}
    </svg>`,

  oven: (color, on) => `
    <svg viewBox="0 0 80 80" width="56" height="56">
      <rect x="10" y="14" width="60" height="60" rx="3" fill="#1e293b" stroke="${color}" stroke-width="1.5"/>
      <line x1="14" y1="22" x2="66" y2="22" stroke="${color}" stroke-width="0.5" opacity="0.5"/>
      <rect x="14" y="26" width="52" height="44" rx="2" fill="#1e293b" stroke="${color}" stroke-width="1"/>
      <rect x="20" y="34" width="40" height="20" rx="1" fill="${color}" opacity="${on ? 0.45 : 0.1}"/>
      <circle cx="20" cy="18" r="1.5" fill="${color}" opacity="0.7"/>
      <circle cx="30" cy="18" r="1.5" fill="${color}" opacity="0.7"/>
      <circle cx="60" cy="18" r="1.5" fill="${color}" opacity="${on ? 1 : 0.4}"/>
      ${on ? `
        <path d="M30 62 Q28 56 30 50 Q32 56 34 48 Q36 56 38 50 Q40 56 38 62 Z" fill="${color}" opacity="0.85">
          <animate attributeName="opacity" values="0.5;1;0.5" dur="0.8s" repeatCount="indefinite"/>
        </path>
        <path d="M44 62 Q42 56 44 50 Q46 56 48 48 Q50 56 52 50 Q54 56 52 62 Z" fill="${color}" opacity="0.7">
          <animate attributeName="opacity" values="0.85;0.4;0.85" dur="0.8s" repeatCount="indefinite"/>
        </path>` : ""}
    </svg>`,

  lights: (color, on) => `
    <svg viewBox="0 0 60 80" width="42" height="56">
      <path d="M30 12 C20 12 14 20 14 30 C14 36 18 40 22 44 L22 52 L38 52 L38 44 C42 40 46 36 46 30 C46 20 40 12 30 12 Z"
            fill="${color}" opacity="${on ? 0.4 : 0.1}" stroke="${color}" stroke-width="1.5"/>
      <path d="M24 26 Q30 22 36 26 Q30 30 24 26" stroke="${color}" stroke-width="1" fill="none" opacity="${on ? 1 : 0.3}"/>
      <rect x="22" y="52" width="16" height="4" fill="${color}" opacity="0.8"/>
      <rect x="24" y="56" width="12" height="3" fill="${color}" opacity="0.6"/>
      <rect x="25" y="59" width="10" height="2" fill="${color}" opacity="0.5"/>
      ${on ? `
        <g opacity="0.7" stroke="${color}" stroke-width="1.5" stroke-linecap="round">
          <line x1="30" y1="2" x2="30" y2="6"/>
          <line x1="6" y1="14" x2="11" y2="18"/>
          <line x1="54" y1="14" x2="49" y2="18"/>
          <line x1="2" y1="32" x2="8" y2="32"/>
          <line x1="58" y1="32" x2="52" y2="32"/>
          <animate attributeName="opacity" values="0.3;0.9;0.3" dur="2s" repeatCount="indefinite"/>
        </g>` : ""}
    </svg>`,

  fridge: (color, on) => `
    <svg viewBox="0 0 60 80" width="42" height="56">
      <rect x="10" y="6" width="40" height="68" rx="3" fill="#1e293b" stroke="${color}" stroke-width="1.5"/>
      <line x1="10" y1="24" x2="50" y2="24" stroke="${color}" stroke-width="1"/>
      <rect x="10" y="6" width="40" height="18" fill="${color}" opacity="0.15"/>
      <rect x="44" y="12" width="2" height="6" fill="${color}" opacity="0.7"/>
      <rect x="44" y="42" width="2" height="14" fill="${color}" opacity="0.7"/>
      <rect x="10" y="24" width="40" height="50" fill="${color}" opacity="${on ? 0.15 : 0.08}"/>
      ${on ? `
        <circle cx="40" cy="32" r="1.5" fill="${color}">
          <animate attributeName="opacity" values="0.3;1;0.3" dur="2s" repeatCount="indefinite"/>
        </circle>` : ""}
    </svg>`,
};

/**
 * Normalise a user-supplied icon name and pick a renderer. Returns a function
 * that produces the icon HTML/SVG given (color, on). If the name matches our
 * animated set (case-insensitive, hyphen/underscore tolerant), uses that.
 * Otherwise returns null — the caller should fall back to <ha-icon>.
 */
function resolveAnimatedIcon(name) {
  if (!name || typeof name !== "string") return null;
  // Normalise: lowercase, swap hyphens for underscores to match keys
  const key = name.toLowerCase().replace(/-/g, "_");
  // Common aliases that map to our animated set
  const aliases = {
    "water_boiler":      "geyser",
    "car_electric":      "ev",
    "ev_station":        "ev",
    "ev_charger":        "ev",
    "washingmachine":    "washing_machine",
    "washer":            "washing_machine",
    "air_conditioner":   "aircon",
    "ac":                "aircon",
    "light":             "lights",
    "lightbulb":         "lights",
    "stove":             "oven",
    "refrigerator":      "fridge",
  };
  const resolved = ANIMATED_SEP_ICONS[key] ? key : aliases[key];
  return resolved ? ANIMATED_SEP_ICONS[resolved] : null;
}

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

    /* Separator node — smaller variant of .pfc-node positioned inline within
       the main flow canvas. Used for downstream sub-loads (pool, EV, geyser). */
    .pfc-sep-node{position:absolute;transform:translate(-50%,-50%);display:flex;
                  flex-direction:column;align-items:center;gap:2px;text-align:center;
                  max-width:20%;box-sizing:border-box;}
    .pfc-sep-node .sn{font-size:8.5px;letter-spacing:.16em;font-weight:700;
                      color:${COLORS.text_muted};white-space:nowrap;
                      overflow:hidden;text-overflow:ellipsis;max-width:100%;}
    .pfc-sep-node .sv{font-size:11px;font-weight:700;white-space:nowrap;}
    .pfc-sep-node.off .sv{color:${COLORS.separator_off};}
    .pfc-sep-node .ss{font-size:8.5px;color:${COLORS.text_dim};line-height:1.2;
                      white-space:nowrap;}
    /* Fallback ha-icon styling (when user picked a non-animated icon) */
    .pfc-sep-node ha-icon.si{color:var(--sep-color);
                             --mdc-icon-size:38px;
                             opacity:var(--sep-icon-opacity,0.4);
                             transition:opacity .3s;}
    .pfc-sep-node.on ha-icon.si{opacity:1;}

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
    @keyframes pfc-spin{from{transform:rotate(0deg);}to{transform:rotate(360deg);}}
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

  // ─── Separator flow lines ──────────────────────────────────────────────
  // Each separator's "on" state is in s.separators[i].on. The order matches
  // the slot allocation in renderSeparatorNodes: index 0 → sep1, etc.
  // Animation direction is reversed because power flows FROM the load TO the
  // sub-loads (visually upward to sep1, downward to sep2/sep3).
  const seps = s.separators || [];
  const tall = layout.mode === "tall";

  // sep1: top-right vertical line (tall mode only)
  const sep1Line = (tall && f.loadToSep1 && seps[0])
    ? flowLine(f.loadToSep1.x1, f.loadToSep1.y1,
               f.loadToSep1.x2, f.loadToSep1.y2,
               seps[0].on, true, seps[0].color)
    : "";

  // sep2/sep3 flow lines depend on count
  let sepBelowLines = "";
  if (f.loadToSep2Straight) {
    // Exactly one separator below load — straight line down
    // Color: the single below-load separator (which is seps[0] in short, seps[1] in tall)
    const targetSep = tall ? seps[1] : seps[0];
    if (targetSep) {
      sepBelowLines = flowLine(
        f.loadToSep2Straight.x1, f.loadToSep2Straight.y1,
        f.loadToSep2Straight.x2, f.loadToSep2Straight.y2,
        targetSep.on, false, targetSep.color
      );
    }
  } else if (f.loadStem && f.branchBar) {
    // Tee/branch: stem + crossbar + per-branch down lines
    // Stem is active if ANY of the below-load separators are on
    // For tall mode: stem connects to sep2 (index 1) and sep3 (index 2)
    // For short mode: stem connects to sep2 (index 0) and sep3 (index 1)
    // [and optionally sep1 center down for 3-in-short]
    const branchSeps = tall ? [seps[1], seps[2]] : [seps[0], seps[1]];
    const stemActive = branchSeps.some((b) => b && b.on);
    // Stem color: average / dominant — pick the first active sep's color, or grey
    const activeSep = branchSeps.find((b) => b && b.on);
    const stemColor = activeSep ? activeSep.color : COLORS.idle;

    const stem = flowLine(f.loadStem.x1, f.loadStem.y1,
                          f.loadStem.x2, f.loadStem.y2,
                          stemActive, false, stemColor);
    const bar = flowLine(f.branchBar.x1, f.branchBar.y1,
                         f.branchBar.x2, f.branchBar.y2,
                         stemActive, false, stemColor);
    const sep2Branch = (f.sep2Down && branchSeps[0])
      ? flowLine(f.sep2Down.x1, f.sep2Down.y1,
                 f.sep2Down.x2, f.sep2Down.y2,
                 branchSeps[0].on, false, branchSeps[0].color)
      : "";
    const sep3Branch = (f.sep3Down && branchSeps[1])
      ? flowLine(f.sep3Down.x1, f.sep3Down.y1,
                 f.sep3Down.x2, f.sep3Down.y2,
                 branchSeps[1].on, false, branchSeps[1].color)
      : "";

    // Center down for 3-in-short mode
    let centerDown = "";
    if (!tall && f.sep1CenterDown && seps[2]) {
      centerDown = flowLine(f.sep1CenterDown.x1, f.sep1CenterDown.y1,
                            f.sep1CenterDown.x2, f.sep1CenterDown.y2,
                            seps[2].on, false, seps[2].color);
    }

    sepBelowLines = stem + bar + sep2Branch + sep3Branch + centerDown;
  }

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
      ${sep1Line}
      ${sepBelowLines}
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

/**
 * Render the separator NODES (positioned absolutely within .pfc-main).
 *
 * Each separator's position comes from the layout object:
 *   - sep1: top-right (alongside solar, tall layout only)
 *   - sep2: below load, left  (or centered if only 2 separators in tall mode)
 *   - sep3: below load, right (only when 3 separators in tall mode)
 *
 * The icon falls back to <ha-icon mdi:...> when the user picks something not
 * in our animated icon set.
 *
 * Returns a fragment of multiple positioned divs (or empty string if no
 * separators configured).
 */
function renderSeparatorNodes(s, layout) {
  if (!s.separators || s.separators.length === 0) return "";
  const slots = ["sep1", "sep2", "sep3"];
  // Map separators to layout slots — order in the user's array is preserved.
  // In tall mode, slot 0 → sep1 (top-right), 1 → sep2 (below-load left), 2 → sep3 (below-load right).
  // In short mode, slot 0 → sep2 (below-load center or left), etc.
  const slotKeys = layout.mode === "tall"
    ? ["sep1", "sep2", "sep3"]
    : (s.separators.length === 1 ? ["sep2"]
      : s.separators.length === 2 ? ["sep2", "sep3"]
      : ["sep2", "sep1", "sep3"]); // 3 in short: order to match flow layout

  return s.separators.map((sep, i) => {
    const slot = slotKeys[i];
    const pos = layout.nodes[slot];
    if (!pos) return ""; // safety: layout didn't allocate a slot
    const resolved = resolveAnimatedIcon(sep.icon);
    const iconHtml = resolved
      ? resolved(sep.color, sep.on)
      : `<ha-icon icon="mdi:${esc(sep.icon)}" class="si" style="--sep-color:${esc(sep.color)};"></ha-icon>`;
    const valueColor = sep.on ? sep.color : COLORS.separator_off;
    return `
      <div class="pfc-sep-node ${sep.on ? "on" : "off"}"
           style="left:${pos.left};top:${pos.top};--sep-color:${esc(sep.color)};">
        ${iconHtml}
        <span class="sn">${esc(sep.name.toUpperCase())}</span>
        <span class="sv" style="color:${valueColor};">${sep.on ? fmtPower(sep.power) : "OFF"}</span>
        ${sep.on && sep.today ? `<span class="ss">TODAY ${fmtEnergy(sep.today)}</span>` : ""}
      </div>
    `;
  }).join("");
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
        ${renderSeparatorNodes(s, layout)}
        ${renderInverterCenter(s)}
      </div>
      ${renderThreePhaseDetail(s, cfg)}
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
          {
            name: "animated_icon",
            selector: {
              select: {
                mode: "dropdown",
                options: [
                  { value: "",                label: "— None (use MDI icon below) —" },
                  { value: "pool",            label: "Pool (animated)" },
                  { value: "geyser",          label: "Geyser / water heater (animated)" },
                  { value: "ev",              label: "EV charger (animated)" },
                  { value: "washing_machine", label: "Washing machine (animated)" },
                  { value: "dryer",           label: "Dryer (animated)" },
                  { value: "dishwasher",      label: "Dishwasher (animated)" },
                  { value: "oven",            label: "Oven (animated)" },
                  { value: "heater",          label: "Heater (animated)" },
                  { value: "aircon",          label: "Aircon (animated)" },
                  { value: "lights",          label: "Lights (animated)" },
                  { value: "fridge",          label: "Fridge (animated)" },
                ],
              },
            },
          },
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
      // If the saved icon matches one of our animated set, surface it in the
      // animated_icon dropdown so the user sees their selection. Otherwise
      // leave animated_icon empty and let the MDI icon field show their value.
      const iconLower = (s?.icon || "").toLowerCase().replace(/-/g, "_");
      const isAnimated = !!ANIMATED_SEP_ICONS[iconLower];
      data[`separator_${i + 1}`] = {
        name: s?.name,
        power_entity: s?.power_entity,
        energy_today_entity: s?.energy_today_entity,
        animated_icon: isAnimated ? iconLower : "",
        icon: isAnimated ? "" : s?.icon,
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
        // animated_icon wins over icon when both are set — that's the user
        // explicitly choosing one of our animated names. Falls back to icon
        // (MDI picker value) when animated_icon is empty/none.
        const chosenIcon = (s.animated_icon && s.animated_icon !== "")
          ? s.animated_icon
          : s.icon;
        seps.push({
          name: s.name || `Load ${n}`,
          power_entity: s.power_entity,
          energy_today_entity: s.energy_today_entity,
          icon: chosenIcon,
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
      icon: "Icon (MDI fallback if no animated icon chosen)",
      animated_icon: "Animated icon",
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
