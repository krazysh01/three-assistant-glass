// Client-side settings store.
//
// Settings live in localStorage, so each browser owns its own configuration and
// its own credentials. The server is used only to seed a browser that has none
// yet, which keeps existing single-user installs working unchanged.
//
// hostClipboardBroadcast is deliberately absent: it is a server-side option
// about the host machine, not a per-browser preference. See server.mjs.

const STORAGE_KEY = 'three-assistant-glass.settings';

let cache = null;

function readStore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    // Private mode, blocked site data, or corrupt JSON
    console.warn('[settings] could not read localStorage:', e.message);
    return null;
  }
}

function writeStore(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    return true;
  } catch (e) {
    console.warn('[settings] could not write localStorage:', e.message);
    return false;
  }
}

// Server-held settings, used only as the seed for a browser with no local copy.
async function fetchSeed() {
  try {
    const res = await fetch('/api/settings');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    console.warn('[settings] could not seed from server:', e.message);
    return {};
  }
}

// Resolve settings for this browser, seeding from the server on first run.
// Subsequent calls are served from cache; pass true to bypass it.
export async function loadSettings(refresh = false) {
  if (cache && !refresh) return cache;

  const local = readStore();
  if (local) {
    cache = local;
    return cache;
  }

  const seed = await fetchSeed();
  delete seed.clipboardAccess;          // legacy server-owned key
  delete seed.hostClipboardBroadcast;   // server-owned, never mirrored locally
  cache = seed;
  writeStore(cache);
  console.log('[settings] seeded this browser from the server');
  return cache;
}

// Settings as of the last load. Returns {} before the first loadSettings().
export function getSettings() {
  return cache || readStore() || {};
}

export async function saveSetting(key, value) {
  return saveSettings({ [key]: value });
}

export async function saveSettings(patch) {
  const settings = { ...(await loadSettings()), ...patch };
  cache = settings;
  writeStore(settings);
  return settings;
}

// Notify other tabs (the settings page and the main view) that settings changed.
// localStorage's own storage event only fires in *other* tabs, which is exactly
// the behaviour we want here.
export function onSettingsChanged(handler) {
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY) return;
    cache = readStore();
    handler(cache || {});
  });
}
