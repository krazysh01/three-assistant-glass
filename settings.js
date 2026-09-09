import { loadSettings, saveSetting, saveSettings, clearAllOverrides, getDefaults, getSettings }
  from './settings-store.mjs';
import { fetchModels, sttModels, ttsModels, voicesFor, describeVoice, describeLanguages, fillDatalist }
  from './model-catalog.mjs';

document.querySelectorAll('.settings-tab-button').forEach(button => {
    button.addEventListener('click', () => {
        document.querySelectorAll('.settings-tab-button, .tab-content, .settings-tab-item').forEach(el => el.classList.remove('active'));
        
        button.classList.add('active');
        button.closest('.settings-tab-item').classList.add('active');
        
        const tabId = button.getAttribute('data-tab');
        document.getElementById(tabId).classList.add('active');
    });
});

document.querySelectorAll('.toggle-visibility').forEach(button => {
    button.addEventListener('click', () => {
        const input = document.getElementById(button.getAttribute('data-target'));
        const isPassword = input.type === 'password';
        input.type = isPassword ? 'text' : 'password';
        button.querySelector('img').src = isPassword ? 'icons/eye.svg' : 'icons/eye-off.svg';
    });
});

// Function to load animations
async function loadAnimations() {
    const response = await fetch('/animations');
    const animations = await response.json();
    const select = document.getElementById('idleAnimationSelect');
    select.innerHTML = '<option value="">Select an animation</option>';
    animations.forEach(animation => {
        const option = document.createElement('option');
        option.value = animation;
        option.textContent = animation;
        select.appendChild(option);
    });
}

// Function to load characters
async function loadCharacters() {
    const response = await fetch('/api/characters');
    const characters = await response.json();
    const grid = document.getElementById('characterGrid');
    grid.innerHTML = ''; // Clear existing content

    characters.forEach(character => {
        const card = document.createElement('div');
        card.className = 'character-card';
        card.innerHTML = `
            <img src="${character.imagePath}" alt="${character.name}">
            <span class="character-name">${character.name}</span>
        `;
        card.addEventListener('click', () => selectCharacter(character.name));
        grid.appendChild(card);
    });

    // Add the "Add Character" card
    const addCard = document.createElement('div');
    addCard.className = 'character-card add-character';
    addCard.innerHTML = '<img src="images/Add_Character_Card.png" alt="Add Character Card">';
    addCard.addEventListener('click', () => document.getElementById('characterUpload').click());
    grid.appendChild(addCard);
}

// Function to select a character
async function selectCharacter(name) {
    try {
        await saveSetting('characterName', name);
        document.getElementById('characterName').textContent = name;
    } catch (error) {
        console.error('Error selecting character:', error);
        alert('Failed to select character. Please try again.');
    }
}

// Function to show/hide provider-specific UI sections
function updateProviderUI(provider) {
    const vapiSection = document.getElementById('vapiAssistantSection');
    const customSection = document.getElementById('customAssistantSection');
    if (provider === 'custom') {
        vapiSection.style.display = 'none';
        customSection.style.display = 'block';
    } else {
        vapiSection.style.display = 'block';
        customSection.style.display = 'none';
    }
}

// Populate the form fields from the stored settings
async function populateSettingsForm() {
    const settings = await loadSettings(true);
    document.getElementById('publicKey').value = settings.vapiPublicKey || '';
    document.getElementById('privateKey').value = settings.vapiPrivateKey || '';
    
    // Load other settings
    document.getElementById('showTimeToggle').checked = settings.showTime;
    document.getElementById('timeFormatSelect').value = settings.timeFormat;
    document.getElementById('freeCameraToggle').checked = settings.freeCamera;
    document.getElementById('sceneDebugToggle').checked = settings.sceneDebug;
    document.getElementById('dragDropToggle').checked = settings.dragDropSupport;
    document.getElementById('vrmDebugToggle').checked = settings.vrmDebug;
    document.getElementById('animationPickerToggle').checked = settings.animationPicker;
    document.getElementById('settingsIconToggle').checked = settings.settingsIconToggle; // Add this line

    // Set the selected idle animation
    const idleAnimationSelect = document.getElementById('idleAnimationSelect');
    if (settings.idleAnimation && idleAnimationSelect.querySelector(`option[value="${settings.idleAnimation}"]`)) {
        idleAnimationSelect.value = settings.idleAnimation;
    }

    // Set the character name
    if (settings.characterName) {
        document.getElementById('characterName').textContent = settings.characterName;
    }

    // Load the assistant shortcut
    const shortcutInput = document.getElementById('assistantShortcut');
    shortcutInput.value = settings.assistantShortcut || '';

    // Load provider setting
    const provider = settings.assistantProvider || 'vapi';
    document.getElementById('assistantProviderSelect').value = provider;
    updateProviderUI(provider);

    // Load custom provider settings
    document.getElementById('customLLMBaseUrl').value = settings.customLLMBaseUrl || '';
    document.getElementById('customLLMApiKey').value = settings.customLLMApiKey || '';
    document.getElementById('customLLMModel').value = settings.customLLMModel || '';
    document.getElementById('customSystemPrompt').value = settings.customSystemPrompt || '';
    document.getElementById('customFirstMessage').value = settings.customFirstMessage || '';

    // Load OpenAI-compatible speech endpoint settings
    document.getElementById('sttBaseUrl').value = settings.sttBaseUrl || '';
    document.getElementById('sttModel').value = settings.sttModel || '';
    document.getElementById('sttApiKey').value = settings.sttApiKey || '';
    document.getElementById('ttsBaseUrl').value = settings.ttsBaseUrl || '';
    document.getElementById('ttsModel').value = settings.ttsModel || '';
    document.getElementById('ttsVoice').value = settings.ttsVoice || '';
    document.getElementById('ttsApiKey').value = settings.ttsApiKey || '';
}


// Function to load assistants from Vapi
async function loadAssistants() {
    try {
        const settings = await loadSettings(true);

        // Only load VAPI assistants when using the VAPI provider
        if ((settings.assistantProvider || 'vapi') !== 'vapi') return;

        const vapiPrivateKey = settings.vapiPrivateKey;

        if (!vapiPrivateKey) {
            console.error('Vapi private key not found in settings');
            return;
        }

        const options = {
            method: 'GET',
            headers: { Authorization: `Bearer ${vapiPrivateKey}` }
        };

        const response = await fetch('https://api.vapi.ai/assistant', options);
        const assistants = await response.json();

        const select = document.getElementById('assistantIDSelect');
        select.innerHTML = '<option value="">Select an assistant</option>';
        assistants.forEach(assistant => {
            const option = document.createElement('option');
            option.value = assistant.id;
            option.textContent = assistant.name;
            select.appendChild(option);
        });

        // Load the selected assistant from settings
        if (settings.assistantID) {
            select.value = settings.assistantID;
            await updateAssistantInfo(settings.assistantID, vapiPrivateKey);
        }
    } catch (err) {
        console.error('Error loading assistants:', err);
    }
}

// Function to update assistant information
async function updateAssistantInfo(assistantID, vapiPrivateKey) {
    if (!assistantID) return;

    const options = {
        method: 'GET',
        headers: { Authorization: `Bearer ${vapiPrivateKey}` }
    };

    try {
        const response = await fetch(`https://api.vapi.ai/assistant/${assistantID}`, options);
        const assistant = await response.json();

        document.querySelector('#modelName .model-text').textContent = assistant.model.model;
        document.querySelector('#voiceInfo .voice-text').textContent = `${assistant.voice.provider} (${assistant.voice.voiceId})`;
        document.getElementById('systemMessage').textContent = assistant.model.messages.find(m => m.role === 'system')?.content || 'No system message found';
        document.getElementById('firstMessage').textContent = assistant.firstMessage || 'No first message found';
    } catch (error) {
        console.error('Error fetching assistant details:', error);
    }
}

// Event listener for assistant selection
document.getElementById('assistantIDSelect').addEventListener('change', async (e) => {
    const assistantID = e.target.value;
    const settings = await loadSettings();
    await updateAssistantInfo(assistantID, settings.vapiPrivateKey);
});

// Modify the initializePage function
async function initializePage() {
    await loadAnimations();
    await populateSettingsForm();
    await loadCharacters();
    await loadAssistants();
}

// ─── Form fields ─────────────────────────────────────────────────────────────
// Every setting the page edits, in one place. Changing an endpoint usually means
// changing its model and voice too, so the page collects edits and commits them
// with a single save rather than a button per field.

const FIELDS = [
    { key: 'settingsIconToggle', id: 'settingsIconToggle',   type: 'checkbox' },
    { key: 'showTime',           id: 'showTimeToggle',       type: 'checkbox' },
    { key: 'timeFormat',         id: 'timeFormatSelect',     type: 'value' },
    { key: 'freeCamera',         id: 'freeCameraToggle',     type: 'checkbox' },
    { key: 'sceneDebug',         id: 'sceneDebugToggle',     type: 'checkbox' },
    { key: 'dragDropSupport',    id: 'dragDropToggle',       type: 'checkbox' },
    { key: 'vrmDebug',           id: 'vrmDebugToggle',       type: 'checkbox' },
    { key: 'animationPicker',    id: 'animationPickerToggle', type: 'checkbox' },
    { key: 'idleAnimation',      id: 'idleAnimationSelect',  type: 'value' },
    { key: 'assistantShortcut',  id: 'assistantShortcut',    type: 'value' },
    { key: 'assistantProvider',  id: 'assistantProviderSelect', type: 'value' },
    { key: 'assistantID',        id: 'assistantIDSelect',    type: 'value' },
    { key: 'vapiPublicKey',      id: 'publicKey',            type: 'value' },
    { key: 'vapiPrivateKey',     id: 'privateKey',           type: 'value' },
    { key: 'customLLMBaseUrl',   id: 'customLLMBaseUrl',     type: 'value', validate: validateBaseUrl },
    { key: 'customLLMApiKey',    id: 'customLLMApiKey',      type: 'value' },
    { key: 'customLLMModel',     id: 'customLLMModel',       type: 'value' },
    { key: 'customSystemPrompt', id: 'customSystemPrompt',   type: 'value' },
    { key: 'customFirstMessage', id: 'customFirstMessage',   type: 'value' },
    { key: 'sttBaseUrl',         id: 'sttBaseUrl',           type: 'value', validate: validateBaseUrl },
    { key: 'sttModel',           id: 'sttModel',             type: 'value' },
    { key: 'sttApiKey',          id: 'sttApiKey',            type: 'value' },
    { key: 'ttsBaseUrl',         id: 'ttsBaseUrl',           type: 'value', validate: validateBaseUrl },
    { key: 'ttsModel',           id: 'ttsModel',             type: 'value' },
    { key: 'ttsVoice',           id: 'ttsVoice',             type: 'value' },
    { key: 'ttsApiKey',          id: 'ttsApiKey',            type: 'value' },
];

// Empty is allowed everywhere - the client falls back to a default endpoint -
// but a non-empty base URL that cannot be parsed would fail silently at request
// time, so it is worth catching here.
function validateBaseUrl(value) {
    if (!value.trim()) return null;
    let url;
    try {
        url = new URL(value);
    } catch (e) {
        return 'Not a valid URL - include the scheme, e.g. http://localhost:8000/v1';
    }
    if (!/^https?:$/.test(url.protocol)) return 'Must be an http:// or https:// URL';
    if (location.protocol === 'https:' && url.protocol === 'http:') {
        return 'The page is served over HTTPS, so the browser will block this http:// endpoint';
    }
    return null;
}

const fieldEl = (f) => document.getElementById(f.id);
const readField = (f) => {
    const el = fieldEl(f);
    if (!el) return undefined;
    return f.type === 'checkbox' ? el.checked : el.value;
};

// ─── Model and voice suggestions ─────────────────────────────────────────────
// Populated from each configured endpoint's /v1/models. Everything here is
// best-effort: if a server offers nothing, the datalist stays empty and the
// field behaves exactly as it did before, a plain text input.

let ttsCatalog = [];

function noteSuggestions(id, count, what) {
    const input = document.getElementById(id);
    if (!input) return;
    const noun = count === 1 ? what.replace(/s$/, '') : what;
    input.title = count
        ? `${count} ${noun} suggested by the server - you can still type any value`
        : `No ${what} advertised by this endpoint - type the value manually`;
}

async function refreshSpeechSuggestions() {
    const s = await loadSettings();

    const stt = await fetchModels(s.sttBaseUrl, s.sttApiKey);
    noteSuggestions('sttModel', fillDatalist(
        document.getElementById('sttModelList'),
        sttModels(stt).map(m => ({ value: m.id, label: describeLanguages(m.language) })),
    ), 'models');

    ttsCatalog = s.ttsBaseUrl === s.sttBaseUrl ? stt : await fetchModels(s.ttsBaseUrl, s.ttsApiKey);
    noteSuggestions('ttsModel', fillDatalist(
        document.getElementById('ttsModelList'),
        ttsModels(ttsCatalog).map(m => ({ value: m.id, label: m.sample_rate ? `${m.sample_rate} Hz` : '' })),
    ), 'models');

    refreshVoiceSuggestions();
}

// Voices depend on the selected TTS model: Kokoro carries dozens, each Piper
// model exactly one, so this reruns whenever the model field changes.
function refreshVoiceSuggestions() {
    const modelId = document.getElementById('ttsModel')?.value;
    const voices = voicesFor(ttsCatalog, modelId);
    noteSuggestions('ttsVoice', fillDatalist(
        document.getElementById('ttsVoiceList'),
        voices.map(v => ({ value: v.name, label: describeVoice(v) })),
    ), 'voices');
}

async function refreshLlmSuggestions() {
    const s = await loadSettings();
    const models = await fetchModels(s.customLLMBaseUrl, s.customLLMApiKey);
    noteSuggestions('customLLMModel', fillDatalist(
        document.getElementById('customLLMModelList'),
        models.map(m => ({ value: m.id, label: m.owned_by || '' })),
    ), 'models');
}

async function refreshAllSuggestions() {
    await Promise.all([refreshSpeechSuggestions(), refreshLlmSuggestions()]);
}

document.getElementById('ttsModel')?.addEventListener('change', () => {
    // A voice belongs to a model: Kokoro's af_heart means nothing to a Piper
    // model. Clear it so the refreshed suggestions drive the next choice rather
    // than leaving a value that will fail at synthesis time.
    const voice = document.getElementById('ttsVoice');
    if (voice) voice.value = '';
    refreshVoiceSuggestions();
});

// ─── Validation, dirty tracking and saving ───────────────────────────────────

let savedSnapshot = {};   // field values as last loaded or saved

function setFieldError(f, message) {
    const el = fieldEl(f);
    if (!el) return;
    el.classList.toggle('invalid', Boolean(message));
    el.setAttribute('aria-invalid', message ? 'true' : 'false');

    const errorId = `${f.id}Error`;
    let note = document.getElementById(errorId);
    if (!message) {
        note?.remove();
        return;
    }
    if (!note) {
        note = document.createElement('span');
        note.id = errorId;
        note.className = 'field-error';
        (el.closest('.input-wrapper') || el).insertAdjacentElement('afterend', note);
    }
    note.textContent = message;
}

// Returns the fields that are currently invalid.
function validateForm() {
    const invalid = [];
    for (const f of FIELDS) {
        if (!f.validate || !fieldEl(f)) continue;
        const message = f.validate(String(readField(f) ?? ''));
        setFieldError(f, message);
        if (message) invalid.push(f);
    }
    return invalid;
}

function changedKeys() {
    return FIELDS.filter((f) => fieldEl(f))
        .filter((f) => JSON.stringify(readField(f)) !== JSON.stringify(savedSnapshot[f.key]))
        .map((f) => f.key);
}

// Save is enabled only when there is something to save and nothing is invalid.
function refreshSaveState() {
    const button = document.getElementById('saveAll');
    const status = document.getElementById('saveStatus');
    if (!button || !status) return;

    const invalid = validateForm();
    const changed = changedKeys();
    button.disabled = invalid.length > 0 || changed.length === 0;
    status.classList.toggle('error', invalid.length > 0);

    if (invalid.length) {
        status.textContent = `${invalid.length} field${invalid.length === 1 ? '' : 's'} need${invalid.length === 1 ? 's' : ''} fixing`;
    } else if (changed.length) {
        status.textContent = `${changed.length} unsaved change${changed.length === 1 ? '' : 's'}`;
    } else {
        status.textContent = '';
    }
}

function snapshotForm() {
    savedSnapshot = {};
    for (const f of FIELDS) {
        if (fieldEl(f)) savedSnapshot[f.key] = readField(f);
    }
}

async function saveAll() {
    if (validateForm().length) return;

    const patch = {};
    for (const key of changedKeys()) {
        const f = FIELDS.find((x) => x.key === key);
        patch[key] = readField(f);
    }
    if (Object.keys(patch).length === 0) return;

    await saveSettings(patch);
    snapshotForm();
    refreshSaveState();
    refreshOverrideSummary();

    const status = document.getElementById('saveStatus');
    if (status) {
        status.textContent = 'Saved';
        setTimeout(() => { if (status.textContent === 'Saved') refreshSaveState(); }, 2000);
    }

    // A changed endpoint or key means a different catalogue
    if (['sttBaseUrl', 'sttApiKey', 'ttsBaseUrl', 'ttsApiKey'].some((k) => k in patch)) refreshSpeechSuggestions();
    if (['customLLMBaseUrl', 'customLLMApiKey'].some((k) => k in patch)) refreshLlmSuggestions();
}

document.getElementById('saveAll')?.addEventListener('click', saveAll);

// Any edit re-evaluates validity and what is unsaved.
for (const f of FIELDS) {
    const el = fieldEl(f);
    if (!el) continue;
    el.addEventListener('input', refreshSaveState);
    el.addEventListener('change', refreshSaveState);
}

// Show how many settings this browser has overridden, and offer a way back to
// the deployment's defaults.
function refreshOverrideSummary() {
    const label = document.getElementById('overrideCount');
    if (!label) return;
    const defaults = getDefaults();
    const effective = getSettings();
    const count = Object.keys(effective)
        .filter(k => JSON.stringify(defaults[k]) !== JSON.stringify(effective[k])).length;
    label.textContent = count === 0
        ? 'Nothing is overridden here - this browser follows the deployment defaults.'
        : `${count} setting${count === 1 ? '' : 's'} overridden in this browser.`;
}

document.getElementById('resetOverrides')?.addEventListener('click', async () => {
    await clearAllOverrides();
    await populateSettingsForm();
    snapshotForm();
    refreshSaveState();
    refreshOverrideSummary();
});

// Call initializePage when the page loads
// Snapshot after everything has populated - loadAssistants fills a select
// asynchronously, and taking the baseline earlier would look like a pending edit.
initializePage()
    .then(snapshotForm)
    .then(refreshSaveState)
    .then(refreshOverrideSummary)
    .then(refreshAllSuggestions);


// Provider selector
document.getElementById('assistantProviderSelect').addEventListener('change', (e) => {
    const provider = e.target.value;
    updateProviderUI(provider);
    if (provider === 'vapi') loadAssistants();
});

// Event listeners for all toggles and selects
// Event listener for idle animation select
// Add this function to handle file uploads
async function uploadCharacterFiles(files) {
    const formData = new FormData();
    for (let i = 0; i < files.length; i++) {
        formData.append('characters', files[i]);
    }

    try {
        const response = await fetch('/api/upload-characters', {
            method: 'POST',
            body: formData
        });

        if (!response.ok) {
            throw new Error('Upload failed');
        }

        await loadCharacters(); // Refresh the character display
    } catch (error) {
        console.error('Error uploading files:', error);
        alert('Failed to upload files. Please try again.');
    }
}

// Add event listener for file input changes
document.getElementById('characterUpload').addEventListener('change', (event) => {
    uploadCharacterFiles(event.target.files);
});

// Add this event listener for settingsIconToggle
// Add this new function to handle keyboard shortcut input
function handleShortcutInput(event) {
    event.preventDefault();
    const shortcutInput = document.getElementById('assistantShortcut');
    
    const key = event.key;
    const ctrl = event.ctrlKey ? 'Ctrl+' : '';
    const alt = event.altKey ? 'Alt+' : '';
    const shift = event.shiftKey ? 'Shift+' : '';
    
    if (key === 'Control' || key === 'Alt' || key === 'Shift') return;
    
    const shortcut = `${ctrl}${alt}${shift}${key}`;
    shortcutInput.value = shortcut;
    refreshSaveState();
}

// Add event listeners after the page loads
document.addEventListener('DOMContentLoaded', () => {
    const shortcutInput = document.getElementById('assistantShortcut');
    shortcutInput.addEventListener('keydown', handleShortcutInput);
});