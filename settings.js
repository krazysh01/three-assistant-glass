import { loadSettings, saveSetting, clearAllOverrides, getDefaults, getSettings }
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

// Function to save settings
async function saveSettings(key, value) {
    // rebind vapi keys for backwards compatibilty
    switch(key) {
        case "privateKey":
            key = "vapiPrivateKey";
            break;
        case "publicKey":
            key = "vapiPublicKey";
            break;
        default:
            break;
    }
    await saveSetting(key, value);
    refreshOverrideSummary();

    // A changed endpoint or key means a different catalogue
    if (['sttBaseUrl', 'sttApiKey', 'ttsBaseUrl', 'ttsApiKey'].includes(key)) refreshSpeechSuggestions();
    if (['customLLMBaseUrl', 'customLLMApiKey'].includes(key)) refreshLlmSuggestions();
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
    await saveSettings('assistantID', assistantID);

    const settings = await loadSettings(true);
    await updateAssistantInfo(assistantID, settings.vapiPrivateKey);
});

// Modify the initializePage function
async function initializePage() {
    await loadAnimations();
    await populateSettingsForm();
    await loadCharacters();
    await loadAssistants();
}

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
    refreshOverrideSummary();
});

// Call initializePage when the page loads
initializePage().then(refreshOverrideSummary).then(refreshAllSuggestions);


document.querySelectorAll('.save-button').forEach(button => {
    button.addEventListener('click', () => {
        // Added data-save attribute to all save buttons
        const saveKey = button.getAttribute('data-save');
        if (saveKey) {
            const el = document.getElementById(saveKey);
            saveSettings(saveKey, el.value);
            return;
        }
    });
});

// Provider selector
document.getElementById('assistantProviderSelect').addEventListener('change', (e) => {
    const provider = e.target.value;
    saveSettings('assistantProvider', provider);
    updateProviderUI(provider);
    if (provider === 'vapi') loadAssistants();
});

// Event listeners for all toggles and selects
document.getElementById('showTimeToggle').addEventListener('change', (e) => {
    saveSettings('showTime', e.target.checked);
});

document.getElementById('timeFormatSelect').addEventListener('change', (e) => {
    saveSettings('timeFormat', e.target.value);
});

document.getElementById('freeCameraToggle').addEventListener('change', (e) => {
    saveSettings('freeCamera', e.target.checked);
});

document.getElementById('sceneDebugToggle').addEventListener('change', (e) => {
    saveSettings('sceneDebug', e.target.checked);
});

document.getElementById('dragDropToggle').addEventListener('change', (e) => {
    saveSettings('dragDropSupport', e.target.checked);
});

document.getElementById('vrmDebugToggle').addEventListener('change', (e) => {
    saveSettings('vrmDebug', e.target.checked);
});

document.getElementById('animationPickerToggle').addEventListener('change', (e) => {
    saveSettings('animationPicker', e.target.checked);
});

// Event listener for idle animation select
document.getElementById('idleAnimationSelect').addEventListener('change', (e) => {
    saveSettings('idleAnimation', e.target.value);
});

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
document.getElementById('settingsIconToggle').addEventListener('change', (e) => {
    saveSettings('settingsIconToggle', e.target.checked);
});

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
    
    saveSettings('assistantShortcut', shortcut);
}

// Add event listeners after the page loads
document.addEventListener('DOMContentLoaded', () => {
    const shortcutInput = document.getElementById('assistantShortcut');
    shortcutInput.addEventListener('keydown', handleShortcutInput);
});