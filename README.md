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

Settings are layered. `settings.json` on the server holds the deployment's
defaults, shared by every client; anything a user changes is saved in their own
browser as an override, and effective settings are the defaults with those
overrides on top.

So a shared private deployment can be configured centrally once and every browser
picks it up with no setup, while any user can still change values for themselves.
A deployment with nothing pre-configured works too — the client supplies
everything. Changing a default on the server reaches every client that hasn't
overridden that particular key, and the settings page has a reset that drops a
browser's overrides so it follows the defaults again.

Because `settings.json` is served to every client as the defaults, only put
credentials there that you're happy for all of them to use; otherwise leave those
fields empty and let each user enter their own.

`hostClipboardBroadcast` is the exception, and is not in the settings UI. It makes
the server read the clipboard of **the machine it runs on** and send it to every
connected browser once a second — so it only makes sense when the server and the
browser are the same device. Enable it by setting `"hostClipboardBroadcast": true`
in `settings.json`. It is off by default, and when off nothing polls the clipboard
at all.

The settings page suggests models and voices from each endpoint's `/v1/models`.
How much it can offer depends on the server: `task` and `voices` are extensions
that [Speaches](https://speaches.ai) provides and the OpenAI API does not, so
against Speaches you get filtered model lists and every voice a model supports,
against OpenAI you get the model list plus the documented voices for known TTS
models, and against anything else the fields stay plain text. Suggestions are
never a constraint — any value can still be typed, since a bundled list goes
stale as soon as a provider adds a voice.

The browser calls the LLM, STT and TTS endpoints directly, so each service must
allow the app's origin via CORS. On [Speaches](https://speaches.ai) that is the
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

- Show current time
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

8. Go back to http://localhost:3000/settings and click ▶️ to start the assistant

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
