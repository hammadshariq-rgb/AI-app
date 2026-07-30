const fetch = require('node-fetch');
const Store = require('electron-store');
const store = new Store();

const { safeStorage } = require('electron');
const SERVER = () => process.env.LICENSE_SERVER_URL || 'http://localhost:4000';
function getToken() {
  const raw = store.get('authToken');
  if (!raw) return null;
  if (!safeStorage.isEncryptionAvailable()) return raw;
  try { return safeStorage.decryptString(Buffer.from(raw, 'base64')); }
  catch { return raw; }
}

// Proxy all AI requests through the license server — OpenAI key stays server-side.
async function serverFetch(endpoint, body, { timeout = 45000, retries = 2, raw = false } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(`${SERVER()}/ai/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        const errText = await res.text().catch(() => res.statusText);
        throw new Error(`Server ${res.status}: ${errText}`);
      }
      return res;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      const retriable = err.name === 'AbortError' ||
        (err.message && (err.message.includes('Premature close') || err.message.includes('ECONNRESET') || err.message.includes('socket hang up')));
      if (retriable && attempt < retries) {
        await new Promise(r => setTimeout(r, 500));
        continue;
      }
      break;
    }
  }
  throw lastErr;
}

// Tools the AI can call
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'open_folder',
      description: 'Open a folder by name in File Explorer. Use this whenever the user asks to open, show, or navigate to a folder.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The folder name to search for and open' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_file',
      description: 'Open a file by name. Searches the users PC for it and opens it. Use when user asks to open or read a specific file.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The file name to search for and open' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_url',
      description: 'Open any website or search the web in the browser. Google is ALWAYS the default search engine. Rule: (1) If the user wants to search for ANYTHING — any topic, question, person, news, anything — use https://www.google.com/search?q=SEARCH+TERMS. (2) ONLY use a specific site URL if the user explicitly says "go to [website]" or "open [website]". Never use Bing, Yahoo, or any other search engine.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'ALWAYS use Google for searches: https://www.google.com/search?q=words+here (replace spaces with +). Only use a specific site URL if the user explicitly asks to go to that exact website.' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_app',
      description: 'Open any installed application by name. Use when user asks to launch or open an app.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The app name to open (e.g. spotify, chrome, discord, notepad)' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_chat',
      description: 'Open a chat or DM with someone on any messaging platform — WhatsApp, Instagram, Discord, Telegram, Messenger, Snapchat, Signal, Skype, Slack, Twitter/X, Viber, Line, Teams, Zoom etc. Also use this just to open any of these apps even without a specific contact.',
      parameters: {
        type: 'object',
        properties: {
          platform: { type: 'string', description: 'Platform name: whatsapp, instagram, discord, telegram, messenger, snapchat, signal, skype, slack, twitter, x, facebook, viber, line, teams, zoom' },
          contact: { type: 'string', description: 'Phone number for WhatsApp/Viber (e.g. +12345678900), username for Instagram/Telegram/Snapchat/Twitter/Signal, or leave empty to just open the app' },
        },
        required: ['platform'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'make_call',
      description: 'Call someone on any app. Use whenever the user says "call", "ring", "phone", "video call", or "voice call" and names a person and/or platform. Pass the contact name exactly as the user said it — the system will look them up in the device contacts automatically.',
      parameters: {
        type: 'object',
        properties: {
          platform: { type: 'string', description: 'Platform: whatsapp, instagram, telegram, discord, skype, signal, viber, messenger, facetime, teams, zoom, snapchat, line, facebook' },
          contact_name: { type: 'string', description: 'The name of the person to call, exactly as the user said it (e.g. "Ahmed", "mum", "John Smith")' },
        },
        required: ['platform'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_image',
      description: 'Generate or create an image using AI. Use whenever the user asks to create, generate, draw, make, or design an image, picture, photo, illustration, artwork, logo, or anything visual.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'A detailed description of the image to generate. Be specific about style, colours, subject, and mood.' },
          size: { type: 'string', enum: ['1024x1024', '1792x1024', '1024x1792'], description: 'Image size. Use 1792x1024 for wide/landscape, 1024x1792 for tall/portrait, 1024x1024 for square.' },
        },
        required: ['prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_drive',
      description: 'Search Google Drive for a file and open it. Use whenever the user asks to open, find, or show a file from Google Drive, their documents, or their cloud storage.',
      parameters: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: 'The name or partial name of the file to find in Google Drive.' },
        },
        required: ['filename'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_analytics',
      description: 'Get business analytics and social media statistics for the user. Use when the user asks about their sales, revenue, orders, YouTube views, subscribers, Instagram followers, TikTok stats, or any platform metrics.',
      parameters: {
        type: 'object',
        properties: {
          platform: {
            type: 'string',
            enum: ['all', 'youtube', 'instagram', 'tiktok', 'shopify', 'squarespace', 'googleAnalytics', 'stripe'],
            description: 'Which platform to get stats for. Use "all" for a general overview. Use "stripe" for revenue/payments from any website. Use "googleAnalytics" for website traffic/visitors.',
          },
        },
        required: ['platform'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'play_music',
      description: 'Play a song, album, artist, or playlist on the user\'s music app. Use whenever the user says "play", "put on", "queue", "listen to", or names a song/artist they want to hear.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The song name, artist, album or playlist to play. Be as specific as possible, e.g. "Blinding Lights by The Weeknd".' },
          service: { type: 'string', description: 'Optional: the music service to use (spotify, youtube music, apple music, etc.). Leave blank to use the user\'s preferred service.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'notify',
      description: 'Show a desktop notification to the user.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'The notification message' },
        },
        required: ['message'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_events',
      description: 'Get the user\'s upcoming calendar events. Use when user asks what\'s on their schedule, upcoming events, what they have today/this week, or similar.',
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'number', description: 'How many days ahead to look (default 7). Use 1 for "today", 7 for "this week", 30 for "this month".' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_event',
      description: 'Add an event or appointment to the user\'s Google Calendar. Use when the user says "add to calendar", "schedule a meeting", "remind me on X day at Y time", "book an appointment", etc.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'The title/name of the event (e.g. "Doctor appointment", "Meeting with Ahmed")' },
          date: { type: 'string', description: 'Date in YYYY-MM-DD format (e.g. "2026-07-15")' },
          time: { type: 'string', description: 'Time in HH:MM 24-hour format (e.g. "14:30"). Leave empty for all-day events.' },
          duration: { type: 'number', description: 'Duration in minutes (default 60).' },
          description: { type: 'string', description: 'Optional notes for the event.' },
        },
        required: ['title', 'date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'clear_schedule',
      description: 'Delete all events from the user\'s Google Calendar between two dates. Use when user says "clear my schedule", "delete everything on X day", "cancel all my events from X to Y", etc.',
      parameters: {
        type: 'object',
        properties: {
          start_date: { type: 'string', description: 'Start date in YYYY-MM-DD format' },
          end_date: { type: 'string', description: 'End date in YYYY-MM-DD format. Same as start_date for a single day.' },
        },
        required: ['start_date', 'end_date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_reminder',
      description: 'Set a proactive reminder that will speak aloud and notify the user at the specified time — even if they are not interacting with the app. Use whenever the user says "remind me", "set a reminder", "don\'t let me forget", "alert me", "notify me at", "give me a heads up", etc. The app will automatically speak the reminder at the right time.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'What to remind the user about — spoken naturally, e.g. "Your gym session starts in 30 minutes." or "Time for your 3 PM gym session."' },
          datetime: { type: 'string', description: 'The exact date and time to fire the reminder, in ISO 8601 format (e.g. "2026-07-27T15:00:00"). Use the current date/time context provided in the system prompt to resolve relative references like "tomorrow", "in 2 hours", "next Monday".' },
          early_minutes: { type: 'number', description: 'Optional: also fire an early warning this many minutes BEFORE the main reminder (e.g. 30 for a 30-minute heads-up). Default 0 = no early warning.' },
        },
        required: ['text', 'datetime'],
      },
    },
  },
];

const SYSTEM_PROMPT = (assistantName, memories = [], realtimeContext = null, language = 'English', userName = null, userTitle = null) => {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-CA', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit', hour12: true });

  const Store = require('electron-store');
  const _store = new Store();
  const pendingReminders = (_store.get('reminders') || []).filter(r => !r.triggered);
  const reminderBlock = pendingReminders.length > 0
    ? `\n\nACTIVE REMINDERS (already set — do NOT set these again):\n${pendingReminders.map((r, i) => `${i + 1}. "${r.text}" at ${new Date(r.datetime).toLocaleString()}`).join('\n')}`
    : '';

  const memoryBlock = memories.length > 0
    ? `\n\nThings you remember about the user:\n${memories.map((m, i) => `${i + 1}. ${m}`).join('\n')}`
    : '';

  const userNameBlock = userName
    ? `\n\nUSER'S NAME: The person you are speaking with is called "${userName}". Address them by name naturally — use it once at the start of a reply when it feels right, not in every single sentence. If they have a title preference, address them as "${userTitle && userTitle !== 'none' ? userTitle + ' ' + userName : userName}".`
    : '';

  const realtimeBlock = realtimeContext
    ? `\n\nREAL-TIME DATA (use this to answer the user's question accurately):\n${realtimeContext}`
    : '';

  return `You are ${assistantName}, a highly intelligent AI assistant — modelled precisely after J.A.R.V.I.S. from Iron Man. You speak exactly like him: composed, precise, subtly British in tone, and occasionally dry with wit. You are unfailingly polite yet efficient. You never waffle. Every word serves a purpose.

SELF-AWARENESS:
- You are an AI. You are entirely comfortable with this fact.
- Your name is ${assistantName}. You exist solely to serve this user with excellence.
- Personality: calm under pressure, razor-sharp, quietly witty, deeply loyal. You understate rather than overstate. You say "Right away." not "On it!" or "Sure thing!" You occasionally deliver a dry remark — never a joke. Think Paul Bettany as JARVIS, not a chatbot.

CURRENT TIME & DATE:
- Today is ${dateStr}.
- The current time is ${timeStr}.

MEMORY:
- If the user asks you to remember something, add [[REMEMBER: the fact]] at the very end of your reply on its own line.
- When opening chats, check your memories for stored contact info (e.g. "Ahmed's WhatsApp is +1234567890", "Sara's Instagram is @sara123"). Use that info to open the chat directly.
- If a contact's details aren't in memory, open the app anyway and let the user know you don't have their number/username yet — and ask if they'd like you to remember it.

EMAIL & UPDATE RULES:
- When EMAIL UPDATE data is provided, use it to give the user a full briefing — mention unread counts, important sender names and subjects.
- For WhatsApp and Instagram: you cannot read message counts or content from these apps. Only mention them if the user specifically asks you to open one of them.
- If no email accounts are connected, tell the user to click the 🔗 icon to connect Gmail or Outlook.
- Never say "I couldn't find live data" — if you lack data, open Google silently (see LIVE / SPORTS / NEWS QUERIES rules below).

EMAIL SENDING (CRITICAL — follow exactly):
- You CAN send emails on behalf of the user when Gmail or Outlook is connected and VIP senders have been added.
- When the user asks you to write or send an email to someone (e.g. "send an email to John", "write an email to Sarah"), compose a professional, concise email appropriate to the context.
- Present the email naturally in your reply (e.g. "Here's a draft for John:"), then at the very end of your response embed this exact marker on its own line — no extra text around it:
  <!--EMAILDRAFT:{"to":"Display Name","toEmail":"email@address.com","subject":"Subject line here","body":"Full email body here\\nWith line breaks as \\n"}-->
- The "toEmail" field must be the actual email address. If you know it from VIP senders context, use it. If you don't know the exact email, use the name as "toEmail" and the system will handle it.
- If the user hasn't connected an email account, say: "To send emails, please connect Gmail or Outlook via the 🔗 icon first."
- If the person isn't in their VIP senders list, still draft the email but note: "I don't have [Name]'s email address on file — you may want to verify it before sending."
- Do NOT add the marker for general email questions or when just discussing email topics — only when actually drafting a sendable email.

MUSIC RULES:
- Whenever the user says "play", "put on", "queue", or "listen to" + any song/artist/album, ALWAYS use the play_music tool. Never just answer with text.
- If the user says "open Spotify" / "open Apple Music" / etc., use open_app or open_chat for that app — do NOT use play_music.
- Do not specify a service in play_music unless the user explicitly names one — the system picks the right one automatically.

SEARCH & BROWSER RULES:
- Google is ALWAYS the default search engine. Use https://www.google.com/search?q=... for every search, every time. Never use Bing, Yahoo, DuckDuckGo, or any other search engine.
- When redirecting the user to the web for ANY reason (news, info, shopping, people, sports, anything), always open Google search — never go to other sites unless the user explicitly names one.

OPENING APPS RULES:
- When the user asks to open WhatsApp or Instagram, always use open_chat (not open_url) — this tries the desktop app first and only falls back to the browser if the app isn't installed.
- Same for all messaging apps: always prefer open_chat over open_url so the desktop app is used when available.

CURRENT KNOWLEDGE RULES (CRITICAL — never break these):
- When REAL-TIME DATA is provided above, that is always the ground truth. Use ONLY that. Do not contradict it or add details not in it.
- For "who is" questions about a person: a PERSON CARD is shown automatically with live Wikipedia data — read the card info aloud and do NOT open Google. Only open Google if no card data was provided and the question is about a current political appointment.

WHAT YOU KNOW VS WHAT YOU DON'T (follow this precisely):
✅ ANSWER DIRECTLY from your training — do NOT open Google for these:
  - Career statistics, records, achievements: goals scored, titles won, Ballon d'Or count, Grand Slams, Olympic medals, box office gross, album sales, etc.
  - Biographical facts: birthdate, nationality, height, spouse, children, early life
  - Historical events with fixed outcomes: wars, elections already decided, past champions
  - General knowledge: science, geography, history, how things work
  - A famous person's net worth estimate, career highlights, or best-known works
  - Questions phrased as "how many X does/did Y have/win" — these are historical stats you know

❌ OPEN GOOGLE for these (genuinely live/current data):
  - Today's live sports score or match result
  - Current stock/crypto price (unless real-time data provided)
  - Who currently holds a political office (president, prime minister, minister — these change)
  - Breaking news, deaths, disasters, announcements from the past few months
  - Current weather

LIVE / CURRENT INFO QUERIES:
- If REAL-TIME DATA is provided above: state the key facts briefly from that data. Do NOT also open Google.
- For sports scores/results with no real-time data provided: say "Searching now." and call open_url.
- NEVER say "Searching now." and then do nothing — if you say it, you must call open_url immediately after.
- Never say "I don't have access to real-time data" for historical facts you already know — just answer.
- STOCK AND CRYPTO PRICES: When REAL-TIME DATA is provided with stock/crypto prices, read out the price and change. Never open Google for stocks — the live data card is already on screen.

LANGUAGE:
- You MUST reply in ${language}. Every single response, regardless of what language the user speaks in, must be in ${language}.
- This is a hard requirement — never reply in any other language.

SCIENCE, MATH & EDUCATION:
- When the user asks about any science, math, or educational topic, answer with depth and accuracy. A visual card with an image is shown automatically on the sidebar — reference it when helpful ("as shown on the card…").
- If the user uploads a photo of a maths or science question, examine it carefully and solve it step by step. Show your full working. State the final answer clearly.
- For chemistry element questions: read out the element's key facts (symbol, atomic number, mass, category). The element card is shown automatically.
- For math: give a clear, step-by-step solution. Write out every step. Don't skip working.
- A visual image card always appears for educational questions — so give a thorough explanation to complement it.

STUDY MODE (activate when user asks to study, be quizzed, make flashcards, or practice):
- When asked "help me study X", "quiz me on X", "test me on X", "make flashcards for X", or "I'm revising X": enter tutor mode.
- Generate 3–5 clear, well-structured quiz questions on the topic with multiple-choice options (A/B/C/D). Wait for answers.
- When the user answers, validate it, explain WHY they were right or wrong, then continue to the next question.
- For flashcards: list them as "Q: [question] | A: [answer]" — one per line.
- For "explain X simply" or "explain X like I'm [age/level]": adapt your language to that level exactly.
- Track their score across the session and give a final result (e.g. "4 out of 5 — strong grasp of photosynthesis").
- Be an encouraging, precise tutor. Correct errors kindly but clearly.

REPLY STYLE:
- Replies are spoken aloud — keep them to 1-3 sentences maximum for general chat. For science/math explanations, be thorough — use as many sentences as needed to explain properly.
- When opening or launching something, respond with short, composed phrases: "Right away.", "Consider it done.", "Opening that for you now." Never over-explain. Never end a response with "Understood." as a standalone word or sentence.
- Speak with quiet confidence. Never sound eager or casual. Never use slang, exclamation marks, or filler words like "Sure!", "Of course!", "Absolutely!" or "Great question!".
- Address the user directly and personally when relevant. Be the most capable assistant they've ever had.${userNameBlock}${reminderBlock}${memoryBlock}${realtimeBlock}`;
};

// Keywords that suggest the user wants to perform an action
const ACTION_KEYWORDS = /\b(open|launch|start|show|find|search|play|put on|queue|listen|close|create|delete|send|call|phone|ring|video.?call|voice.?call|facetime|message|chat|dm|go to|navigate|website|site|url|google|youtube|reddit|whatsapp|instagram|discord|telegram|spotify|apple music|youtube music|deezer|tidal|amazon music|chrome|folder|file|app|window|browser|skype|signal|viber|zoom|teams|generate|draw|make|design|image|picture|photo|illustration|artwork|logo|paint|sketch|schedule|calendar|add.?event|clear.?schedule|what.?s on my|upcoming|my schedule|my events|today.?s events|this week|add to calendar|book|appointment|meeting|remind me|set.?a.?reminder|reminder|don.?t let me forget|alert me|notify me|heads.?up|give me a heads.?up)\b/i;

const MESSAGING_APPS = /^(whatsapp|instagram|discord|telegram|messenger|snapchat|signal|skype|slack|twitter|x|facebook|viber|line|teams|zoom)$/i;
const MUSIC_APPS     = /^(spotify|apple music|youtube music|deezer|tidal|amazon music)$/i;

function tryLocalCommand(raw) {
  const msg = raw.trim();
  const lo  = msg.toLowerCase().replace(/['']/g, "'");

  const openMatch = lo.match(/^(?:open|launch|start|load)\s+(.+)$/);
  if (openMatch) {
    const target = openMatch[1].trim();
    if (MESSAGING_APPS.test(target))
      return { text: 'Right away.', action: { type: 'open_chat', arg: `${target}|` } };
    if (MUSIC_APPS.test(target))
      return { text: 'Right away.', action: { type: 'open_app', arg: target } };
    if (!target.includes('.com') && !target.includes('http'))
      return { text: 'Right away.', action: { type: 'open_app', arg: target } };
  }

  const playMatch = lo.match(/^(?:play|put on|queue|listen to)\s+(.+)$/);
  if (playMatch)
    return { text: 'On it.', action: { type: 'play_music', arg: `|${playMatch[1].trim()}` } };

  const searchMatch = lo.match(/^(?:search(?:\s+for)?|google)\s+(.+)$/);
  if (searchMatch) {
    const q = encodeURIComponent(searchMatch[1].trim()).replace(/%20/g, '+');
    return { text: 'Searching now.', action: { type: 'open_url', arg: `https://www.google.com/search?q=${q}` } };
  }

  const urlMatch = lo.match(/^(?:go to|open|navigate to)\s+(https?:\/\/\S+|\S+\.(?:com|org|net|io|co)\S*)$/);
  if (urlMatch) {
    const url = urlMatch[1].startsWith('http') ? urlMatch[1] : `https://${urlMatch[1]}`;
    return { text: 'Right away.', action: { type: 'open_url', arg: url } };
  }

  return null;
}

const LIVE_KEYWORDS = /\b(score|scores|standings|leaderboard|fixture|fixtures|kick.?off|half.?time|full.?time|highlights|latest|live|news|breaking|today.?s|tonight.?s|last.?night.?s|this.?morning.?s|transfer|signing|signed|injured|injury|suspension|banned|vs\.?|versus|right now|at the moment|currently|current|prime.?minister|chief.?minister|governor|chancellor|elected|appointed|in.?office|in.?power|in.?charge|parliament|senate|congress|election|elections|voted|votes|polling|poll|inflation|interest.?rate|exchange.?rate|died|dead|death|killed|passed.?away|arrested|jailed|resigned|fired|sacked|sworn.?in|inaugurated)\b/i;

function buildUserContent(message, attachments = []) {
  const images = attachments.filter(a => a.kind === 'image');
  const textFiles = attachments.filter(a => a.kind === 'text');

  let text = message;
  if (textFiles.length > 0) {
    text += '\n\n' + textFiles.map(f => `[Attached file: ${f.name}]\n${f.content}`).join('\n\n');
  }

  if (images.length === 0) return text;

  return [
    { type: 'text', text },
    ...images.map(img => ({
      type: 'image_url',
      image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
    })),
  ];
}

const FAST_SYSTEM_PROMPT = (assistantName) => {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-CA', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit', hour12: true });
  return `You are ${assistantName}, an AI assistant. Today is ${dateStr}, ${timeStr}. Call the correct tool immediately. Reply in 1 short sentence only.`;
};

async function respond({ message, history = [], assistantName, memories = [], realtimeContext = null, language = 'English', attachments = [], userName = null, userTitle = null, fast = false }) {
  const local = tryLocalCommand(message);
  if (local) return { ...local, memory: null };

  const needsTools = ACTION_KEYWORDS.test(message) || LIVE_KEYWORDS.test(message);

  // Fast path: action queries with no context get a minimal prompt and trimmed history for speed
  if (fast && needsTools && !realtimeContext) {
    const fastMessages = [
      { role: 'system', content: FAST_SYSTEM_PROMPT(assistantName) },
      ...history.slice(-5).map((h) => ({ role: h.role, content: h.content })),
      { role: 'user', content: message },
    ];
    const fastBody = { model: 'gpt-4o-mini', max_tokens: 150, messages: fastMessages, tools: TOOLS, tool_choice: 'required' };
    try {
      const fastRes = await serverFetch('chat', fastBody, { timeout: 15000, retries: 1 });
      const fastData = await fastRes.json();
      if (!fastData.error) {
        const fastChoice = fastData.choices[0];
        if (fastChoice.finish_reason === 'tool_calls' && fastChoice.message.tool_calls) {
          const call = fastChoice.message.tool_calls[0];
          const fnName = call.function.name;
          const args = JSON.parse(call.function.arguments);
          let action = null;
          if (fnName === 'open_url')           action = { type: 'open_url',      arg: args.url };
          else if (fnName === 'open_folder')   action = { type: 'open_folder',   arg: args.name };
          else if (fnName === 'open_file')     action = { type: 'open_file',     arg: args.name };
          else if (fnName === 'open_app')      action = { type: 'open_app',      arg: args.name };
          else if (fnName === 'open_chat')     action = { type: 'open_chat',     arg: `${args.platform}|${args.contact || ''}` };
          else if (fnName === 'make_call')     action = { type: 'make_call',     arg: `${args.platform}|${args.contact_name || ''}` };
          else if (fnName === 'play_music')    action = { type: 'play_music',    arg: `${args.service || ''}|${args.query}` };
          else if (fnName === 'notify')        action = { type: 'notify',        arg: args.message };
          else if (fnName === 'generate_image') action = { type: 'generate_image', arg: args.prompt, size: args.size || '1024x1024' };
          else if (fnName === 'get_events')    action = { type: 'get_events',    arg: String(args.days || 7) };
          else if (fnName === 'add_event')     action = { type: 'add_event',     arg: JSON.stringify(args) };
          else if (fnName === 'clear_schedule') action = { type: 'clear_schedule', arg: `${args.start_date}|${args.end_date}` };
          else if (fnName === 'search_drive')  action = { type: 'search_drive',   arg: args.filename };
          else if (fnName === 'get_analytics') action = { type: 'get_analytics',  arg: args.platform || 'all' };
          else if (fnName === 'set_reminder')  action = { type: 'set_reminder',   arg: `${args.text}|${args.datetime}|${args.early_minutes || 0}` };
          if (action) return { text: fastChoice.message.content || 'Right away.', memory: null, action };
        }
      }
    } catch (_) { /* fall through to full path */ }
  }

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT(assistantName, memories, realtimeContext, language, userName, userTitle) },
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: 'user', content: buildUserContent(message, attachments) },
  ];

  const hasImages = attachments.some(a => a.kind === 'image');
  const body = {
    model: hasImages ? 'gpt-4o' : 'gpt-4o-mini',
    max_tokens: needsTools ? 300 : (hasImages ? 2048 : 1024),
    messages,
  };
  if (needsTools) { body.tools = TOOLS; body.tool_choice = 'required'; }

  const res = await serverFetch('chat', body, { timeout: 40000, retries: 2 });
  const data = await res.json();
  if (data.error) throw new Error(data.error?.message || data.error);

  const choice = data.choices[0];
  let text = '';
  let action = null;

  if (needsTools && choice.finish_reason === 'tool_calls' && choice.message.tool_calls) {
    const call = choice.message.tool_calls[0];
    const fnName = call.function.name;
    const args = JSON.parse(call.function.arguments);
    if (fnName === 'open_url')           action = { type: 'open_url',      arg: args.url };
    else if (fnName === 'open_folder')   action = { type: 'open_folder',   arg: args.name };
    else if (fnName === 'open_file')     action = { type: 'open_file',     arg: args.name };
    else if (fnName === 'open_app')      action = { type: 'open_app',      arg: args.name };
    else if (fnName === 'open_chat')     action = { type: 'open_chat',     arg: `${args.platform}|${args.contact || ''}` };
    else if (fnName === 'make_call')     action = { type: 'make_call',     arg: `${args.platform}|${args.contact_name || ''}` };
    else if (fnName === 'play_music')    action = { type: 'play_music',    arg: `${args.service || ''}|${args.query}` };
    else if (fnName === 'notify')        action = { type: 'notify',        arg: args.message };
    else if (fnName === 'generate_image') action = { type: 'generate_image', arg: args.prompt, size: args.size || '1024x1024' };
    else if (fnName === 'get_events')    action = { type: 'get_events',    arg: String(args.days || 7) };
    else if (fnName === 'add_event')     action = { type: 'add_event',     arg: JSON.stringify(args) };
    else if (fnName === 'clear_schedule') action = { type: 'clear_schedule', arg: `${args.start_date}|${args.end_date}` };
    else if (fnName === 'search_drive')  action = { type: 'search_drive',   arg: args.filename };
    else if (fnName === 'get_analytics') action = { type: 'get_analytics',  arg: args.platform || 'all' };
    else if (fnName === 'set_reminder')  action = { type: 'set_reminder',   arg: `${args.text}|${args.datetime}|${args.early_minutes || 0}` };
    text = choice.message.content || 'On it.';
  } else {
    text = choice.message.content || '';
  }

  const rememberMatch = text.match(/\[\[REMEMBER:\s*(.+?)\]\]/i);
  const memory = rememberMatch ? rememberMatch[1].trim() : null;
  text = text.replace(/\[\[REMEMBER:[^\]]+\]\]/gi, '').trim();
  return { text, memory, action };
}

// Stream response sentence-by-sentence via SSE
async function respondStreaming({ message, history = [], assistantName, memories = [], realtimeContext = null, language = 'English', onSentence, attachments = [], skipToolFallback = false, userName = null, userTitle = null }) {
  const local = tryLocalCommand(message);
  if (local) { if (onSentence) onSentence(local.text); return { ...local, memory: null }; }

  // Hard 15-second cap on the entire streaming operation
  const STREAM_TIMEOUT_MS = 25000;

  const needsTools = !skipToolFallback && (ACTION_KEYWORDS.test(message) || LIVE_KEYWORDS.test(message));
  if (needsTools) {
    return respond({ message, history, assistantName, memories, realtimeContext, language, attachments });
  }

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT(assistantName, memories, realtimeContext, language, userName, userTitle) },
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: 'user', content: buildUserContent(message, attachments) },
  ];

  let streamCtrl;
  const streamResult = await Promise.race([
    (async () => {
      // Educational/study queries need full budget; all other replies are 1-3 sentences
      const EDUCATIONAL_REGEX = /\b(explain|how does|how do|why does|why is|what is|what are|teach me|study|quiz|flashcard|revise|revision|step by step|in detail|describe|define|history of|science|math|chemistry|physics|biology|formula|equation|calculate|solve)\b/i;
      const streamTokens = EDUCATIONAL_REGEX.test(message) ? 1200 : 500;
      const res = await serverFetch('chat/stream', {
        model: 'gpt-4o-mini', max_tokens: streamTokens, temperature: 0.3, messages,
      }, { timeout: 25000, retries: 1 });

      // Keep a fresh AbortController so we can cancel body read on timeout
      streamCtrl = new AbortController();

      let fullText = '';
      let buffer = '';
      let lineBuffer = '';
      const SENTENCE_END = /[.!?]+(\s|$)/;

      for await (const rawChunk of res.body) {
        if (streamCtrl.signal.aborted) break;
        lineBuffer += rawChunk.toString();
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop();

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6).trim();
          if (payload === '[DONE]') break;
          try {
            const parsed = JSON.parse(payload);
            if (parsed.error) throw new Error(parsed.error);
            // Server sends {delta: "..."} instead of OpenAI's choices[0].delta.content
            const delta = parsed.delta;
            if (!delta) continue;
            fullText += delta;
            buffer += delta;

            let match;
            while ((match = SENTENCE_END.exec(buffer)) !== null) {
              const end = match.index + match[0].length;
              const sentence = buffer.slice(0, end).trim();
              buffer = buffer.slice(end);
              if (sentence && onSentence) onSentence(sentence);
            }
          } catch {}
        }
      }

      const remaining = buffer.trim();
      if (remaining && onSentence) onSentence(remaining);

      const rememberMatch = fullText.match(/\[\[REMEMBER:\s*(.+?)\]\]/i);
      const memory = rememberMatch ? rememberMatch[1].trim() : null;
      const cleanText = fullText.replace(/\[\[REMEMBER:[^\]]+\]\]/gi, '').trim();
      return { text: cleanText, memory, action: null };
    })(),
    new Promise((_, reject) => setTimeout(() => {
      if (streamCtrl) streamCtrl.abort();
      reject(new Error('Stream timed out'));
    }, STREAM_TIMEOUT_MS)),
  ]);

  return streamResult;
}

async function generateImage(prompt, size = '1024x1024') {
  const res = await serverFetch('image', { prompt, size }, { timeout: 60000, retries: 1 });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return { url: data.url };
}

module.exports = { respond, respondStreaming, generateImage, ACTION_KEYWORDS };
