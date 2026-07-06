# Jarvis Desktop — v1

A Windows desktop AI assistant: tray app, push-to-talk overlay, OpenAI-powered conversation,
voice in/out, a customer-chosen name and wake phrase, a few safe OS actions, gated behind a
$10/month Stripe subscription that you (the owner) bill through your own OpenAI account.

## What's here

- `app/` — the Electron desktop app users download and run.
- `server/` — the billing backend: Stripe Checkout + webhook, issues license keys, the
  desktop app checks against it on launch and before every chat request.

## What v1 actually does

- **First run**: a setup screen asks the customer to name their AI and choose a wake phrase
  (e.g. "Wake up, daddy's home"). Stored locally via `electron-store`.
- Tray icon + global hotkey `Ctrl+Shift+J` opens the assistant overlay, showing a PS4-style
  pulsing-ring splash screen with the AI's name before the chat panel appears.
- After the splash, the assistant waits for the wake phrase (spoken or typed) before it will
  talk to the AI model — this keeps you from paying for OpenAI usage on accidental activations.
- Hold the mic button to talk → Whisper transcribes → GPT-4o-mini replies → OpenAI TTS speaks it.
- Safe actions only: open a whitelisted app (notepad/calculator/chrome/etc.), open a file via
  a picker the user controls, show a desktop notification. The model cannot read files, chats,
  or arbitrary app content — it can only trigger actions the user explicitly asked for.
- Subscription gate: no valid license key → chat is blocked with a prompt to subscribe.
- **WhatsApp**: deliberately not automated. Reading/sending WhatsApp messages programmatically
  via unofficial libraries violates WhatsApp's Terms of Service and risks account bans; the only
  compliant path is the official WhatsApp Business API (requires business verification). Not
  wired in — add it later only via that official API if you want it.

## Run it locally

### 1. Billing server

```
cd server
npm install
cp .env.example .env       # fill in your Stripe test keys + price ID
npm start                  # listens on :4000
```

You need a Stripe account (test mode is fine to start):
1. Create a recurring Product/Price of **$10/month** in the Stripe dashboard, copy its `price_...` id into `STRIPE_PRICE_ID`.
2. Create a webhook endpoint pointing at `http://<your-public-url>/webhook` (use the Stripe CLI's
   `stripe listen --forward-to localhost:4000/webhook` for local testing) and put its signing secret in `STRIPE_WEBHOOK_SECRET`.
3. Visit `http://localhost:4000/account` to test the full checkout → license key flow.

### 2. Desktop app

```
cd app
npm install
cp .env.example .env        # add your OpenAI API key
npm start
```

Click the tray icon (or `Ctrl+Shift+J`) to open the overlay. First time: name your AI and set a
wake phrase. Then paste the license key from the `/success` page, say/type your wake phrase, and
talk.

## Packaging an installer

```
cd app
npm run dist
```

This uses `electron-builder` to produce a Windows `.exe` installer (NSIS) in `app/dist/`.
You'll want a real `tray.png`/app icon (your logo) and code-signing certificate before shipping
publicly — unsigned Windows installers get a SmartScreen warning.

## Billing model

You provide the AI; customers don't need their own OpenAI key. Your OpenAI usage cost comes out
of the $10/mo, so keep an eye on heavy users — `gpt-4o-mini` + `tts-1`/`whisper-1` is intentionally
the cheap tier to protect margin. If usage patterns later justify it, consider rate-limiting chat
turns per subscriber server-side.

## Roadmap / known gaps before this is sellable

- **True wake-word ("Hey Jarvis")**: the wake phrase is currently checked against transcribed
  text after the hotkey opens the overlay, not via always-listening hotword detection. A native
  engine like Picovoice Porcupine would enable always-on listening, but that's a deliberate
  privacy/store-policy decision, not a default.
- **License storage**: `server/store.js` is a flat JSON file — fine for testing, move to
  Postgres/SQLite before real traffic so you don't lose licenses on redeploy.
- **Auto-update**: wire up `electron-updater` so subscribers get fixes without manually reinstalling.
- **Per-customer usage limits**: nothing currently caps how much OpenAI usage one subscriber can
  rack up against your account — worth adding before a public launch.
- **Deeper OS access** (reading files/chats on request) was deliberately left out of v1 — it's
  a major privacy/security surface and will get the app flagged by antivirus if done carelessly.
  Add it feature-by-feature with explicit per-action user consent, not as a blanket capability.
- **Logo**: `app/assets/tray.png` is a placeholder — swap in your real branding before shipping.
- **macOS build**: `electron-builder` can target `mac` too; you'll need an Apple Developer
  account to notarize it or Gatekeeper will block it.
