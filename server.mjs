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
const port = Number(process.env.THREE_ASSISTANT_PORT) || 3000;

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
let settings = { hostClipboardBroadcast: false };

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

// Seed values for a browser with no settings of its own. Settings are stored
// per-browser in localStorage; the server holds no per-user state beyond this.
app.get('/api/settings', async (req, res) => {
  try {
    const settingsData = await fs.readFile(settingsPath, 'utf8');
    res.json(JSON.parse(settingsData));
  } catch (error) {
    console.error('Error reading settings:', error);
    res.status(500).json({ error: 'Unable to read settings' });
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

// General WebSocket server (clipboard, etc.). Speech no longer passes through
// here - the browser calls the STT/TTS services directly.
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log('Client connected');

  ws.on('close', () => {
    console.log('Client disconnected');
  });
});


let lastClipboardContent = '';

// Broadcast the HOST MACHINE's clipboard to every connected browser.
//
// clipboardy reads the clipboard of the machine running this server, and the
// result goes to all clients, so this is only meaningful when the server and
// the browser are the same device. It is not a per-user preference and is not
// exposed in the settings UI: enabling it for a remote client would send them
// whatever is copied on the host, once a second. Turn it on by setting
// "hostClipboardBroadcast": true in settings.json.
const checkClipboard = () => {
  clipboardy.read().then(text => {
    if (text !== lastClipboardContent) {
      console.log('[clipboard] host clipboard changed, broadcasting to clients');
      lastClipboardContent = text;
      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ type: 'clipboard', content: text }));
        }
      });
    }
  }).catch(console.error);
};

// Resolved once at startup - there is no way to change it at runtime, so when
// it is off nothing polls the clipboard at all.
// clipboardAccess is the pre-rename key, still honoured.
if (settings.hostClipboardBroadcast ?? settings.clipboardAccess) {
  console.warn(
    `[clipboard] hostClipboardBroadcast is ON: the clipboard of THIS machine will be `
    + `sent to every browser connected to this server, once a second.`
  );
  setInterval(checkClipboard, 1000);
}

server.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
  console.log(`Settings page available at http://localhost:${port}/settings`);
  open(`http://localhost:${port}`);
});