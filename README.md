# three-assistant-glass

![three-assistant-glass](https://github.com/Maclean-D/three-assistant-glass/raw/main/three-assistant-glass.png)

Customizable 3D conversational AI character

## Features

### Voice Assistant - [Vapi](https://vapi.ai/)

- Custom LLM (OpenAI, Anthropic, Groq, etc.)
- Custom Voice (Cartesia, 11labs, Rime.ai etc.)
- Knowledge Base (Markdown, PDF, Word, jpeg, etc.)
- Live Transcriptions (Deepgram, Talkscriber, Gladia)
- Emotion Detection
- Interuptions
- Background Sound, Filler, & Backchanneling
- Function Calling
- Audio Recording

### Custom Agent

- Local AI via custom endpoints
- OpenAI-compatible speech endpoints for STT (`/v1/audio/transcriptions`) and TTS (`/v1/audio/speech`) — works with [Speaches](https://speaches.ai), Kokoro-FastAPI, LocalAI, or OpenAI itself
- Custom OpenAI-compatible endpoint for LLM
- Replies are streamed and spoken sentence by sentence, so the character starts
  talking while the model is still writing
- On-device voice activity detection ([Silero](https://github.com/ricky0123/vad)),
  with barge-in: start talking and the character stops to listen
- Speech can also run entirely in the browser — Chrome's Web Speech for
  listening, [Kokoro-82M](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX)
  or the OS voices for speaking — so a laptop with a local model needs no speech
  server at all

Everything in this pipeline runs in the browser. The app server only serves the
page, the character files and the clipboard bridge; it never sees the
conversation, the audio or the keys.

#### Speech and language providers

Set these in **Settings → Assistant**. Speech-to-text and text-to-speech are
chosen separately, so you can mix them.

| | Speech to text | Text to speech |
|---|---|---|
| **OpenAI-compatible** | `POST /v1/audio/transcriptions` | `POST /v1/audio/speech` |
| **Browser** | Chrome Web Speech (audio goes to Google) | OS voices via `speechSynthesis` |
| **Kokoro** | — | in-browser Kokoro-82M, free and offline after a one-time 90–330 MB download |

The quick-setup buttons fill in a working combination for OpenAI, Ollama, LM
Studio, Speaches, or fully in-browser speech; every field stays editable
afterwards.

The browser calls the LLM, STT and TTS endpoints directly, so each service must
allow the app's origin via CORS. (The in-browser speech providers need no
endpoint, so they need no CORS either.) On [Speaches](https://speaches.ai) that is the
`ALLOW_ORIGINS` variable, which takes a JSON array — `["http://localhost:3000"]`,
or `["*"]` to allow any origin. A service that isn't configured for CORS will
have its requests blocked by the browser.

### Character - [three-vrm](https://github.com/pixiv/three-vrm)

- Custom 3D model ([vrm](https://hub.vroid.com/en))
- Custom animations (fbx)
- Animated to voice assistant's voice

### Holographic Display - [Looking Glass](https://lookingglassfactory.com/webxr)

- View in 3d on any Looking Glass display

### Experimental

- Plaintext clipboard access

### Possible future features

- Realtime speech-to-speech providers as a third option alongside Vapi and Custom
- Add setting to change size/scale of character
- Add setting to move character backwards or forwards

## Prerequisites

- Desktop operating system (Windows, MacOS, Linux)
- [Node.js](https://nodejs.org/en)
- [npm](https://www.npmjs.com/get-npm) (usually comes with Node.js)

## How to Run

1. Open a terminal and clone this repository
   ```
   git clone https://github.com/Maclean-D/three-assistant-glass.git
   ```

2. Navigate to the project directory.
   ```
   cd three-assistant-glass
   ```

3. Install the required dependencies:
   ```
   npm install
   ```

4. Start the server:
   ```
   node server.mjs
   ```
5. http://localhost:3000/ should open automatically

6. Open Settings and save your [Vapi keys](https://dashboard.vapi.ai/org/api-keys)

7. Pick a character model and voice assistant ([Create an assistant on Vapi](https://dashboard.vapi.ai/assistants) first if you haven't already)

8. Go back to http://localhost:3000/ and press **Start** to begin the assistant

To run on a different port, set `THREE_ASSISTANT_PORT`:

```
THREE_ASSISTANT_PORT=3010 npm start
```

### Tests

```
npm test
```

Covers the assistant pipeline, the speech queue and the streaming chat parser.
No network and no dependencies beyond the ones already installed.

## View on a Looking Glass Display

1. Install [Looking Glass Bridge](https://lookingglassfactory.com/software/looking-glass-bridge)

2. Plug in your Looking Glass Display

3. (Recommended) Turn off `Show Settings Icon` in Settings

4. Click `Enter Looking Glass`

5. Double click the window on the Looking Glass Display or press `f11` to enter full-screen

6. Press the `▶️` button on your looking glass display or computer to start the assistant (Configurable in Settings)

## FAQ

### How do I add a new character model?

1. Download a .vrm file, ([VRoid Hub](https://hub.vroid.com/en) has lots of models or make your own in [VRoid Studio](https://vroid.com/en/studio))
2. From the characters tab in settings, click the `+` button and select the .vrm or .zip file
3. Click the model to set it as the active model

### How do I change the character's card in settings?

1. Prepare a 270x480 .png file that has the same name as your vrm file
2. From the characters tab in settings, click the `+` button and select the .png file

### Can I bundle character models and cards?

1. Zip the character's .vrm & .png files together (make sure they have the same name)
2. From the characters tab in settings, click the `+` button and select the .zip file

### How do I change a character's name?

1. Open the `characters` folder
2. Rename the .vrm & .png files (make sure they have the same name)

### How do I delete characters?

1. Open the `characters` folder
2. Delete the desired .vrm & .png files

### How do I add custom animations?

1. Open the `animations` folder
2. Drag and drop your .fbx files into the folder

### I turned off the Settings Icon, how do I get it back?

1. Go back to http://localhost:3000/settings
2. Turn on `Show Settings Icon`

## Troubleshooting

- For 2d displays [Arc](https://arc.net/gift/friend-of-maclean) browser is recommended
- For Looking Glass Displays [Chrome](https://www.google.com/chrome/) is recommended

## Star History

<a href="https://www.star-history.com/?repos=Maclean-D%2Fthree-assistant-glass&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=Maclean-D/three-assistant-glass&type=date&theme=dark&legend=top-left&sealed_token=ZdRVvXf5rpSemWCkQJWj7KNRMNyB5nifpNNMnImrGWyHtS_9H8unaq2YuuPmV5FL-sAFfYnh4ekfizb5AFCBNoOHH-6eAK8W11scAY3va4TUI5uue3aYReauGSRpAbNkuTYFBgBwIoandxqKJ2ukmE1tupA6e3NkWwZmoUeQqqhTs8qAUT0JCp4D_1tu" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=Maclean-D/three-assistant-glass&type=date&legend=top-left&sealed_token=ZdRVvXf5rpSemWCkQJWj7KNRMNyB5nifpNNMnImrGWyHtS_9H8unaq2YuuPmV5FL-sAFfYnh4ekfizb5AFCBNoOHH-6eAK8W11scAY3va4TUI5uue3aYReauGSRpAbNkuTYFBgBwIoandxqKJ2ukmE1tupA6e3NkWwZmoUeQqqhTs8qAUT0JCp4D_1tu" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=Maclean-D/three-assistant-glass&type=date&legend=top-left&sealed_token=ZdRVvXf5rpSemWCkQJWj7KNRMNyB5nifpNNMnImrGWyHtS_9H8unaq2YuuPmV5FL-sAFfYnh4ekfizb5AFCBNoOHH-6eAK8W11scAY3va4TUI5uue3aYReauGSRpAbNkuTYFBgBwIoandxqKJ2ukmE1tupA6e3NkWwZmoUeQqqhTs8qAUT0JCp4D_1tu" />
 </picture>
</a>

## Contributors

<a href="https://github.com/Maclean-D/three-assistant-glass/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=Maclean-D/three-assistant-glass" />
</a>
