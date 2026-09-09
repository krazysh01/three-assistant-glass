// Layered settings.
//
// Deployment defaults come from the server (settings.json) and are shared by
// every client. Anything a user changes is stored in this browser as an
// override. Effective settings are the defaults with overrides applied on top.
//
// That means a shared deployment can be configured centrally once and every
// browser picks it up with no setup; a user can still change any value for
// themselves; a deployment with nothing pre-configured works too, with the
// client supplying everything; and changing a server default reaches every
// client that has not overridden that particular key.
//
// hostClipboardBroadcast is deliberately absent: it is a server-side option
// about the host machine, not a per-browser preference. See server.mjs.

const OVERRIDES_KEY = 'three-assistant-glass.overrides';
const LEGACY_SNAPSHOT_KEY = 'three-assistant-glass.settings';

// Server-owned keys, never part of a client's effective settings.
const SERVER_OWNED = ['clipboardAccess', 'hostClipboardBroadcast'];

let defaults = null;    // from the server
let overrides = null;   // from this browser
let effective = null;   // defaults + overrides

function readOverrides() {
  try {
    const raw = localStorage.getItem(OVERRIDES_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    // Private mode, blocked site data, or corrupt JSON
    console.warn('[settings] could not read overrides:', e.message);
    return {};
  }
}

function writeOverrides(next) {
  try {
    localStorage.setItem(OVERRIDES_KEY, JSON.stringify(next));
  } catch (e) {
    console.warn('[settings] could not save overrides:', e.message);
  }
}

async function fetchDefaults() {
  try {
    const res = await fetch('/api/settings');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    for (const key of SERVER_OWNED) delete json[key];
    return json;
  } catch (e) {
    // A deployment need not pre-configure anything; the client can supply it all.
    console.warn('[settings] no deployment defaults available:', e.message);
    return {};
  }
}

// Earlier builds stored a full snapshot of the settings rather than just the
// changed keys, which detached a browser from deployment defaults forever.
// Convert it once: anything that still matches the default is dropped, and only
// genuine differences survive as overrides.
function migrateLegacySnapshot(baseline) {
  let raw;
  try {
    raw = localStorage.getItem(LEGACY_SNAPSHOT_KEY);
  } catch (e) {
    return null;
  }
  if (!raw) return null;

  let snapshot;
  try {
    snapshot = JSON.parse(raw);
  } catch (e) {
    snapshot = {};
  }

  const migrated = {};
  for (const [key, value] of Object.entries(snapshot)) {
    if (SERVER_OWNED.includes(key)) continue;
    if (JSON.stringify(baseline[key]) !== JSON.stringify(value)) migrated[key] = value;
  }

  writeOverrides(migrated);
  try { localStorage.removeItem(LEGACY_SNAPSHOT_KEY); } catch (e) { /* ignore */ }
  console.log(`[settings] migrated ${Object.keys(migrated).length} local override(s) from the previous format`);
  return migrated;
}

function recompute() {
  effective = { ...defaults, ...overrides };
  return effective;
}

// Effective settings: deployment defaults with this browser's overrides on top.
// Pass true to re-read the server defaults.
export async function loadSettings(refresh = false) {
  if (effective && !refresh) return effective;

  defaults = await fetchDefaults();
  overrides = migrateLegacySnapshot(defaults) ?? readOverrides();
  return recompute();
}

// Effective settings as of the last load. Returns {} before the first load.
export function getSettings() {
  return effective || {};
}

// Deployment defaults, without this browser's overrides.
export function getDefaults() {
  return defaults || {};
}

export function isOverridden(key) {
  return Object.prototype.hasOwnProperty.call(overrides || {}, key);
}

export async function saveSetting(key, value) {
  return saveSettings({ [key]: value });
}

export async function saveSettings(patch) {
  await loadSettings();
  overrides = { ...overrides };

  for (const [key, value] of Object.entries(patch)) {
    if (SERVER_OWNED.includes(key)) continue;
    // Matching the deployment default is not an override; dropping it here keeps
    // the browser following that default if it later changes on the server.
    if (JSON.stringify(defaults[key]) === JSON.stringify(value)) delete overrides[key];
    else overrides[key] = value;
  }

  writeOverrides(overrides);
  return recompute();
}

// Drop one override and fall back to the deployment default.
export async function clearOverride(key) {
  await loadSettings();
  overrides = { ...overrides };
  delete overrides[key];
  writeOverrides(overrides);
  return recompute();
}

// Drop every override; this browser follows the deployment defaults again.
export async function clearAllOverrides() {
  await loadSettings();
  overrides = {};
  writeOverrides(overrides);
  return recompute();
}

// Notify other tabs (the settings page and the main view) that settings changed.
// localStorage's storage event fires only in *other* tabs, which is exactly the
// behaviour wanted here.
export function onSettingsChanged(handler) {
  window.addEventListener('storage', (e) => {
    if (e.key !== OVERRIDES_KEY) return;
    overrides = readOverrides();
    handler(recompute());
  });
}
