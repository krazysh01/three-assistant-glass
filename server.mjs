import express from 'express';
import path from 'path';
import fs from 'fs/promises';
import open from 'open';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import clipboardy from 'clipboardy';
import { fileURLToPath } from 'url';
import { promises as fsPromises } from 'fs';
import multer from 'multer';
import AdmZip from 'adm-zip';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Express app
const app = express();
const port = 3000;

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
fs.mkdir(uploadsDir, { recursive: true }).catch(console.error);

// Set up multer for file uploads
const upload = multer({ dest: uploadsDir });

// Serve static files from the current directory
app.use(express.static(__dirname));

// Serve index.html for the root route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// New route to get animation files
app.get('/animations', async (req, res) => {
  const animationsDir = path.join(__dirname, 'animations');
  try {
    const files = await fs.readdir(animationsDir);
    const fbxFiles = files.filter(file => file.endsWith('.fbx'));
    res.json(fbxFiles);
  } catch (err) {
    console.error('Error reading animations directory:', err);
    res.status(500).json({ error: 'Unable to read animations directory' });
  }
});

// Serve Vapi UMD bundle
app.get('/vapi-web-bundle.min.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules', '@vapi-ai', 'web', 'dist', 'vapi-web-bundle.min.js'));
});

// Load or create settings.json
const settingsPath = path.join(__dirname, 'settings.json');
const exampleSettingsPath = path.join(__dirname, 'settings.example.json');
let settings = { clipboardAccess: false };

async function loadOrCreateSettings() {
  try {
    await fs.access(settingsPath);
    const data = await fs.readFile(settingsPath, 'utf8');
    settings = JSON.parse(data);
  } catch (error) {
    if (error.code === 'ENOENT') {
      // settings.json is gitignored, so seed fresh installs from the committed example
      try {
        const exampleData = await fs.readFile(exampleSettingsPath, 'utf8');
        settings = JSON.parse(exampleData);
      } catch (_) {}
      await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));
    } else {
      console.error('Error accessing settings file:', error);
    }
  }
}

// Call this function before setting up routes
await loadOrCreateSettings();

// Modify the /settings route
app.get('/settings', (req, res) => {
  res.sendFile(path.join(__dirname, 'settings.html'));
});

// Add a new route to get and set the clipboard access setting
app.get('/api/settings/clipboard', (req, res) => {
  res.json({ clipboardAccess: settings.clipboardAccess });
});

app.post('/api/settings/clipboard', express.json(), async (req, res) => {
  settings.clipboardAccess = req.body.clipboardAccess;
  try {
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));
    res.json({ success: true });
  } catch (error) {
    console.error('Error writing settings:', error);
    res.status(500).json({ error: 'Unable to update settings' });
  }
});

// Modify the /api/settings route
app.get('/api/settings', async (req, res) => {
  try {
    const settingsData = await fs.readFile(settingsPath, 'utf8');
    res.json(JSON.parse(settingsData));
  } catch (error) {
    console.error('Error reading settings:', error);
    res.status(500).json({ error: 'Unable to read settings' });
  }
});

app.post('/api/settings', express.json(), async (req, res) => {
  try {
    const currentSettings = { ...settings };
    
    // Update all possible settings
    const possibleSettings = [
      'clipboardAccess', 'vapiPublicKey', 'vapiPrivateKey',
      'showTime', 'timeFormat', 'freeCamera', 'sceneDebug',
      'dragDropSupport', 'vrmDebug', 'animationPicker', 'idleAnimation',
      'characterName', 'assistantID', 'settingsIconToggle', 'assistantShortcut',
      'assistantProvider', 'customLLMBaseUrl', 'customLLMApiKey', 'customLLMModel',
      'customSystemPrompt', 'customFirstMessage',
      'sttBaseUrl', 'sttApiKey', 'sttModel',
      'ttsBaseUrl', 'ttsApiKey', 'ttsModel', 'ttsVoice',
    ];

    possibleSettings.forEach(setting => {
      if (req.body[setting] !== undefined) {
        currentSettings[setting] = req.body[setting];
      }
    });
    
    await fs.writeFile(settingsPath, JSON.stringify(currentSettings, null, 2));
    settings = currentSettings;
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating settings:', error);
    res.status(500).json({ error: 'Unable to update settings' });
  }
});

// Add a new route to get character information
app.get('/api/characters', async (req, res) => {
  const charactersDir = path.join(__dirname, 'characters');
  try {
    const files = await fsPromises.readdir(charactersDir);
    const characters = files
      .filter(file => file.endsWith('.vrm'))
      .map(file => {
        const name = path.parse(file).name;
        const imagePath = files.includes(`${name}.png`) 
          ? `/characters/${name}.png` 
          : '/images/Character_Card_Background.png';
        return { name, imagePath };
      });
    res.json(characters);
  } catch (err) {
    console.error('Error reading characters directory:', err);
    res.status(500).json({ error: 'Unable to read characters directory' });
  }
});

// Add a new route to handle character uploads
app.post('/api/upload-characters', upload.array('characters'), async (req, res) => {
  try {
    for (const file of req.files) {
      const oldPath = file.path;
      const fileExtension = path.extname(file.originalname).toLowerCase();
      
      if (fileExtension === '.zip') {
        // Extract zip file
        const zip = new AdmZip(oldPath);
        zip.extractAllTo(path.join(__dirname, 'characters'), true);
      } else if (['.png', '.vrm'].includes(fileExtension)) {
        // Move png and vrm files
        const newPath = path.join(__dirname, 'characters', file.originalname);
        await fs.rename(oldPath, newPath);
      }
      
      // We're no longer attempting to delete the temporary file
    }
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error processing uploaded files:', error);
    res.status(500).json({ error: 'Failed to process uploaded files' });
  }
});

const server = http.createServer(app);

// General WebSocket server (clipboard, etc.) — noServer so we route manually
const wss = new WebSocketServer({ noServer: true });
const wssSTT = new WebSocketServer({ noServer: true });
const wssTTS = new WebSocketServer({ noServer: true });

// Route WebSocket upgrade requests by path
server.on('upgrade', (req, socket, head) => {
  if (req.url === '/stt') {
    wssSTT.handleUpgrade(req, socket, head, (ws) => wssSTT.emit('connection', ws, req));
  } else if (req.url === '/tts') {
    wssTTS.handleUpgrade(req, socket, head, (ws) => wssTTS.emit('connection', ws, req));
  } else {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  }
});

wss.on('connection', (ws) => {
  console.log('Client connected');

  ws.on('close', () => {
    console.log('Client disconnected');
  });
});

// ─── Speech helpers (OpenAI-compatible audio API) ──────────────────────────

// Build a minimal 44-byte WAV header for raw PCM audio
function buildWavHeader(dataLen, sampleRate = 16000, channels = 1, bitDepth = 16) {
  const byteRate = sampleRate * channels * (bitDepth / 8);
  const blockAlign = channels * (bitDepth / 8);
  const buf = Buffer.alloc(44);

  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);           // fmt chunk size
  buf.writeUInt16LE(1, 20);            // PCM format
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitDepth, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataLen, 40);

  return buf;
}

function speechAuthHeaders(apiKey) {
  return apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {};
}

// Calculate RMS amplitude of a 16-bit LE PCM buffer
function pcmRMS(buf) {
  let sum = 0;
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const s = buf.readInt16LE(i);
    sum += s * s;
  }
  return Math.sqrt(sum / (buf.length / 2));
}

// ─── STT handler (/stt → POST {sttBaseUrl}/audio/transcriptions) ────────────

wssSTT.on('connection', (ws) => {
  // VAD config
  const SPEECH_THRESHOLD = 500;   // RMS level to count as speech (0–32767)
  const SILENCE_FRAMES   = 3;     // consecutive silent frames before triggering (~768ms at 256ms/frame)
  const MIN_SPEECH_FRAMES = 2;    // ignore very short bursts (< ~512ms)
  const PRE_ROLL_FRAMES  = 2;     // silent frames kept before speech so the first syllable isn't clipped

  let speaking = false;
  let silenceCount = 0;
  let speechCount = 0;
  let waitingForTranscript = false;
  let utterance = [];   // PCM buffers of the current utterance
  let preRoll = [];     // rolling buffer of recent silent frames

  console.log(`[STT] Browser connected → ${settings.sttBaseUrl || 'http://localhost:8000/v1'}`);

  async function transcribe(pcm) {
    const baseUrl = (settings.sttBaseUrl || 'http://localhost:8000/v1').replace(/\/+$/, '');
    const wav = Buffer.concat([buildWavHeader(pcm.length, 16000, 1, 16), pcm]);

    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
    form.append('model', settings.sttModel || 'whisper-1');

    const res = await fetch(`${baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: speechAuthHeaders(settings.sttApiKey),
      body: form,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const json = await res.json();
    return (json.text || '').trim();
  }

  // Receive binary audio frames from browser
  // Frame format: [4 bytes LE: metaLen][metaLen bytes JSON][PCM bytes]
  let frameCount = 0;
  ws.on('message', (data, isBinary) => {
    if (!isBinary) return;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length < 4) return;

    const metaLen = buf.readUInt32LE(0);
    if (buf.length < 4 + metaLen) return;
    const pcm = buf.slice(4 + metaLen);
    if (pcm.length === 0) return;

    frameCount++;
    if (frameCount === 1 || frameCount % 50 === 0) {
      console.log(`[STT] frame #${frameCount} rms:${Math.round(pcmRMS(pcm))} speaking:${speaking} silence:${silenceCount}`);
    }

    // While the previous utterance is still transcribing, don't start a new one,
    // but keep the pre-roll fed so speech resuming right after isn't clipped.
    if (waitingForTranscript) {
      preRoll.push(pcm);
      if (preRoll.length > PRE_ROLL_FRAMES) preRoll.shift();
      return;
    }

    const rms = pcmRMS(pcm);

    if (rms >= SPEECH_THRESHOLD) {
      // Active speech — start the utterance with the pre-roll so onset isn't clipped
      if (!speaking) {
        utterance = [...preRoll];
        preRoll = [];
      }
      speaking = true;
      silenceCount = 0;
      speechCount++;
      utterance.push(pcm);
    } else if (speaking) {
      // Silence after speech
      silenceCount++;
      utterance.push(pcm);

      if (silenceCount >= SILENCE_FRAMES) {
        if (speechCount >= MIN_SPEECH_FRAMES) {
          // End of utterance — send buffered audio for transcription
          console.log(`[STT] end of utterance (${speechCount} speech frames), transcribing`);
          waitingForTranscript = true;
          const audio = Buffer.concat(utterance);
          transcribe(audio)
            .then((text) => {
              console.log(`[STT] transcript: "${text}"`);
              if (text && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'fullSentence', text }));
              }
            })
            .catch((err) => console.error('[STT] transcription error:', err.message))
            .finally(() => { waitingForTranscript = false; });
        } else {
          // Too short — likely noise, reset quietly
          console.log('[STT] burst too short, ignoring');
        }
        speaking = false;
        silenceCount = 0;
        speechCount = 0;
        utterance = [];
      }
    } else {
      // Pure silence before any speech — keep a short pre-roll
      preRoll.push(pcm);
      if (preRoll.length > PRE_ROLL_FRAMES) preRoll.shift();
    }
  });

  ws.on('close', () => {
    console.log('[STT] Browser disconnected');
    utterance = [];
    preRoll = [];
  });
});

// ─── TTS handler (/tts → POST {ttsBaseUrl}/audio/speech) ────────────────────

wssTTS.on('connection', (ws) => {
  console.log('[TTS] Browser connected');

  // Serialize requests per connection so sentences play back in order
  let queue = Promise.resolve();

  async function synthesize(text) {
    const baseUrl = (settings.ttsBaseUrl || 'http://localhost:8000/v1').replace(/\/+$/, '');

    const res = await fetch(`${baseUrl}/audio/speech`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...speechAuthHeaders(settings.ttsApiKey),
      },
      body: JSON.stringify({
        model: settings.ttsModel || 'tts-1',
        voice: settings.ttsVoice || 'alloy',
        input: text,
        response_format: 'wav',
      }),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }

    const audio = Buffer.from(await res.arrayBuffer());
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ audioOutput: { audio: audio.toString('base64') } }));
    }
    console.log(`[TTS] Sent ${audio.length} bytes of audio`);
  }

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    const text = data.toString('utf8').trim();
    if (!text) return;

    queue = queue
      .then(() => synthesize(text))
      .catch((err) => console.error('[TTS] synthesis error:', err.message));
  });

  ws.on('close', () => {
    console.log('[TTS] Browser disconnected');
  });
});

let lastClipboardContent = '';

// Modify the clipboard checking interval
const checkClipboard = () => {
  if (settings.clipboardAccess) {
    clipboardy.read().then(text => {
      if (text !== lastClipboardContent) {
        console.log('Clipboard changed:', text);
        lastClipboardContent = text;
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'clipboard', content: text }));
          }
        });
      }
    }).catch(console.error);
  }
};

setInterval(checkClipboard, 1000);

server.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
  console.log(`Settings page available at http://localhost:${port}/settings`);
  open(`http://localhost:${port}`);
});