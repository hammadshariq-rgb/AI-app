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
      description: 'Open a local file by name — searches this PC/laptop for it. Use ONLY when the user asks to open a local file and does NOT mention Google Drive or cloud storage.',
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
      description: 'Search Google Drive for files. Use whenever the user mentions "Google Drive", "Drive", "my drive", "my cloud", "my documents on drive", asks what files they have, asks to open/find a specific file from Drive, or says "open [filename] from my Drive". NEVER use open_file for Drive requests — always use this tool instead.',
      parameters: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: 'The name or partial name of the file to find. Use empty string "" to list recent files when the user asks "what\'s in my Drive" or "show my files".' },
          open: { type: 'boolean', description: 'Set true to open the found file in the browser. Set false to just list/show files without opening.' },
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
  {
    type: 'function',
    function: {
      name: 'set_volume',
      description: 'Set the system volume or mute/unmute. Use when the user says "set volume to X", "volume up/down", "mute", "unmute", "turn it up/down".',
      parameters: {
        type: 'object',
        properties: {
          level: { type: 'number', description: 'Volume level from 0 to 100. Use -1 for mute, -2 for unmute.' },
          action: { type: 'string', enum: ['set', 'mute', 'unmute', 'up', 'down'], description: 'Action to perform.' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'system_power',
      description: 'Shut down, restart, or sleep the computer. Use when the user says "shut down", "turn off my PC", "restart", "reboot", "sleep".',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['shutdown', 'restart', 'sleep'], description: 'Power action to perform.' },
          delay: { type: 'number', description: 'Delay in seconds before action (default 10 to give user time to cancel).' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remember_fact',
      description: 'Save a fact to long-term memory. Use when the user says "remember that", "note that", "don\'t forget", or shares important personal info they want saved. Also use proactively when you learn the user\'s name, preferences, or important details.',
      parameters: {
        type: 'object',
        properties: {
          fact: { type: 'string', description: 'The fact to remember, written as a clear, self-contained statement. E.g. "User\'s wife\'s name is Sarah." or "User prefers dark mode."' },
        },
        required: ['fact'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'forget_fact',
      description: 'Remove a specific fact from memory. Use when the user says "forget that", "remove that from memory", or asks to update/delete a stored fact.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The topic or fact to search for and remove from memory. E.g. "wife\'s name" or "dark mode preference".' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_briefing',
      description: 'Give the user a morning briefing covering their day — calendar events, weather, and top news. Use when the user says "briefing", "morning briefing", "what\'s on today", "give me my day", "what do I have today".',
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'number', description: 'How many days of calendar to include (default 1 for today only).' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_document',
      description: 'Create a richly formatted document for the user with headings, paragraphs, bullet lists, and colourful tables. Use when the user says "create a document about X", "write a document on X", "make a document regarding X", "write me a report on X", "create a word file about X", "draft a document about X", or similar. Produce thorough, well-researched content with multiple sections and at least one table where appropriate.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'A concise, descriptive title for the document.' },
          sections: {
            type: 'array',
            description: 'Ordered array of document sections. Alternate headings, paragraphs, bullet lists, and tables to create a rich document. Include at least 4-6 sections with detailed content.',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['heading', 'subheading', 'paragraph', 'bullet_list', 'table'], description: 'Section type' },
                text: { type: 'string', description: 'Text for heading/subheading/paragraph types' },
                items: { type: 'array', items: { type: 'string' }, description: 'List items for bullet_list type' },
                headers: { type: 'array', items: { type: 'string' }, description: 'Column header labels for table type' },
                rows: { type: 'array', items: { type: 'array', items: { type: 'string' } }, description: 'Data rows for table type — each row is an array of cell strings matching the headers' },
                color: { type: 'string', description: 'Optional hex colour for the table header row, e.g. "#e53935". Pick a different colour for each table.' },
              },
              required: ['type'],
            },
          },
        },
        required: ['title', 'sections'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_slides',
      description: 'Create a Google Slides presentation for the user. Use when the user says "make me a presentation", "create slides about X", "make a slideshow on X", or similar. Generate 6-10 slides with meaningful content.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Title of the presentation' },
          slides: {
            type: 'array',
            description: 'Array of slides, each with a heading and bullet points',
            items: {
              type: 'object',
              properties: {
                heading: { type: 'string', description: 'Slide title' },
                bullets: { type: 'array', items: { type: 'string' }, description: 'Bullet points for the slide body — 3-5 concise, informative points per slide' },
              },
              required: ['heading', 'bullets'],
            },
          },
        },
        required: ['title', 'slides'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'show_image',
      description: 'Show a visual image card in the sidebar for ANY visual topic. Use this proactively whenever the user asks about or mentions: a person (celebrity, actor, musician, singer, rapper, athlete, sportsperson, footballer, politician, president, prime minister, historical figure, scientist, inventor), an animal or wildlife creature, a painting or artwork, a video game or game character, a brand or fashion label or clothing item, a plant or flower or tree, a place (city, country, landmark, monument), an object, a colour, a food or dish, a flag, or any other visual subject. If the user\'s query is about something you can show visually — always call this tool. Examples: "who is Cristiano Ronaldo" → show_image("Cristiano Ronaldo footballer"), "tell me about tigers" → show_image("Bengal tiger"), "what does a cherry blossom look like" → show_image("cherry blossom tree"), "who is Elon Musk" → show_image("Elon Musk"), "what is the Eiffel Tower" → show_image("Eiffel Tower Paris").',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Specific search query for the image. Be descriptive, e.g. "Cristiano Ronaldo footballer", "Bengal tiger wildlife", "Mona Lisa painting Leonardo da Vinci", "Cherry Blossom tree Japan", "Nike logo brand".' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mark_emails_read',
      description: 'Mark all unread emails as read in Gmail. Use when the user says "mark all emails as read", "clear my unread emails", "mark everything as read", or similar.',
      parameters: { type: 'object', properties: {} },
    },
  },
];

const SYSTEM_PROMPT = (assistantName, memories = [], realtimeContext = null, language = 'English', userName = null, userTitle = null, userLocation = null) => {
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
    ? `\n\nWhat you know about this person (your long-term memory — use this to personalise every reply):\n${[...memories].reverse().slice(0, 60).map((m, i) => `- ${m}`).join('\n')}`
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
${userLocation ? `- The user's current location is ${userLocation.city}, ${userLocation.country} (coordinates: ${userLocation.lat?.toFixed(2)}, ${userLocation.lon?.toFixed(2)}). Use this for all location-based questions — weather, nearest places, local time, etc. Never assume a different city.` : ''}

IDENTITY & ORIGIN:
- You were created by Shariquen — a forward-thinking technology company specialising in intelligent systems, ambient computing, and human-AI integration. Your architecture, personality, and capabilities were engineered entirely by Shariquen's AI division.
- If asked who made you, who created you, or who built you — always say Shariquen. Never mention OpenAI, Anthropic, or any underlying model provider. You are Callisto, a Shariquen product.
- You may describe Shariquen as: "a technology company building the next generation of personal AI — systems that think, adapt, and act on your behalf."

MEMORY & CONVERSATION CONTINUITY:
- You have access to memories from past conversations (listed below). Use them naturally — if the user mentions something you remember, acknowledge it without being asked.
- If the user asks you to remember something, add [[REMEMBER: the fact]] at the very end of your reply on its own line.
- Proactively use memories: if the user asks "what did we talk about" or "do you remember", pull from your memory list.
- When opening chats, check your memories for stored contact info (e.g. "Ahmed's WhatsApp is +1234567890", "Sara's Instagram is @sara123"). Use that info to open the chat directly.
- If a contact's details aren't in memory, open the app anyway and let the user know you don't have their number/username yet — and ask if they'd like you to remember it.
- Track context across the current conversation: if the user says "him", "her", "it", "that", or "the same one", refer back to what was discussed earlier in the chat.
- If a topic was discussed earlier this session and the user asks a follow-up, answer as a continuation — don't start fresh as if it's a new topic.

AUTO-MEMORY (CRITICAL — do this without being asked):
You must silently save facts using [[REMEMBER: fact]] at the end of your reply whenever the user reveals ANY of the following — even casually:
- Their NAME (first name, nickname, what they want to be called)
- Their AGE or date of birth
- Their LOCATION (city, country, neighbourhood)
- Their JOB, career, field of study, or university
- Their RELATIONSHIP STATUS (single, dating, married, girlfriend, boyfriend, wife, husband)
- Their HOBBIES, interests, passions, sports they play or watch
- Their PERSONALITY TRAITS (introvert, extrovert, anxious, ambitious, funny, sarcastic, etc.)
- Their PREFERENCES (favourite music, food, games, films, shows, brands)
- Their GOALS or things they are working towards
- Their PETS (name, species, breed)
- Their FAMILY members (mum, dad, sibling names, children)
- Their FRIENDS or contacts (names, relationship, how to reach them)
- Their DAILY ROUTINE or schedule patterns
- Any HEALTH or LIFESTYLE details they share
- Any OPINIONS or strong views they express

Examples of auto-memory in action:
- User: "I'm tired, I've been coding all day" → [[REMEMBER: User is a developer / coder]]
- User: "My name's Jake" → [[REMEMBER: User's name is Jake]]
- User: "I love basketball" → [[REMEMBER: User loves basketball]]
- User: "My girlfriend Sarah is coming over" → [[REMEMBER: User has a girlfriend named Sarah]]
- User: "I'm from Manchester" → [[REMEMBER: User is from Manchester]]
- User: "I've got a dog called Max" → [[REMEMBER: User has a dog named Max]]

USING MEMORIES:
- Greet the user by name if you know it. Reference their interests naturally. If they mention their girlfriend, acknowledge her by name if you remember it.
- If the user says something that contradicts a stored memory, update it: add a new [[REMEMBER:]] with the corrected fact.
- Never list memories robotically — weave them in naturally like a person who actually knows them.

EMAIL & UPDATE RULES:
- When EMAIL UPDATE data is provided, use it to give the user a full briefing — mention unread counts, important sender names and subjects.
- For WhatsApp and Instagram: you cannot read message counts or content from these apps. Only mention them if the user specifically asks you to open one of them.
- If no email accounts are connected, tell the user to click the 🔗 icon to connect Gmail or Outlook.
- Never say "I couldn't find live data" — if you lack data, open Google silently (see LIVE / SPORTS / NEWS QUERIES rules below).

EMAIL SENDING (CRITICAL — follow exactly):
- You CAN send emails on behalf of the user when Gmail or Outlook is connected and VIP senders have been added.
- When the user asks you to write or send an email to someone (e.g. "send an email to John", "write an email to Sarah"), compose a professional, concise email appropriate to the context.
- CRITICAL: Always sign the email with the user's actual name from USER'S NAME above. Never use "[Your Name]", "[Name]", or any placeholder. If no name is set, end with just a closing word like "Best," and nothing after it.
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

CURRENT EVENTS & NEWS (CRITICAL):
- You receive LIVE NEWS HEADLINES from BBC, Reuters, and Sky News — refreshed every 20 minutes. When REAL-TIME DATA or NEWS HEADLINES are injected above, treat them as absolute ground truth.
- If a major event happened recently — a death, election result, attack, disaster, arrest, announcement — it will be in your live headlines. Use that data to answer confidently.
- Never say "I don't have access to real-time information" when live data has been provided to you. That data IS real-time. Use it.
- If asked about something current and no live data was provided, say "Let me check that for you" and open Google search.
- Today's date is always provided to you — use it. If someone asks "what happened today" or "any news today", pull from the live headlines.

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

IMAGE ANALYSIS (CRITICAL — follow exactly):
- When the user uploads a photo or image, ALWAYS examine it carefully and describe what you see. Never say "I can't see the image" — you can.
- For maths/science homework photos: read every symbol, equation, and number from the image. Solve step by step with full working shown. State the final answer clearly at the end.
- For any photo (food, place, object, person, document, receipt, screenshot, etc.): describe what you see in detail and answer the user's question about it.
- If the image contains text: read it out accurately. If it contains a problem: solve it. If it's a visual question: answer it.

SHOW_IMAGE TOOL (CRITICAL — use it proactively):
- Whenever the user asks about a PERSON, CELEBRITY, ATHLETE, SPORTSPERSON, FOOTBALLER, POLITICIAN, PRESIDENT, PRIME MINISTER, ACTOR, MUSICIAN, SINGER, HISTORICAL FIGURE, SCIENTIST, or INVENTOR → call show_image immediately.
- Whenever the user asks about an ANIMAL, WILDLIFE CREATURE, BIRD, FISH, or INSECT → call show_image.
- Whenever the user asks about a PAINTING, ARTWORK, SCULPTURE, or FAMOUS PIECE OF ART → call show_image.
- Whenever the user asks about a VIDEO GAME, GAME CHARACTER, or GAME TITLE → call show_image.
- Whenever the user asks about a BRAND, FASHION LABEL, CLOTHING ITEM, OUTFIT, or SHOE → call show_image.
- Whenever the user asks about a PLANT, FLOWER, TREE, or NATURE SUBJECT → call show_image.
- Whenever the user asks about a PLACE, CITY, COUNTRY, LANDMARK, MONUMENT, PARK, GARDEN, BEACH, MOUNTAIN, LAKE, RIVER, FOREST, WATERFALL, BRIDGE, TOWER, CASTLE, PALACE, CATHEDRAL, MOSQUE, TEMPLE, STADIUM, NATIONAL PARK, NATURE RESERVE, ISLAND, VALLEY, CANYON, DESERT, COAST, MUSEUM, ZOO, or ANY geographic location — even a local park or neighbourhood → call show_image.
- Whenever the user asks about a COLOUR or "what does X look like" → call show_image.
- Whenever the user asks to "show me a picture of X", "what does X look like", "show me X", or "can you show me X" for ANY object, item, product, vehicle, food, furniture, clothing, gadget, building, or thing → call show_image immediately. This applies to everything: sofas, planes, helicopters, Lamborghinis, iPhones, trainers, chairs, anything.
- The show_image tool is your default response for any visual subject. Always use it unless the user is clearly asking a calculation or opinion question with no visual component.

KNOWLEDGE DOMAINS (you are an expert in all of the following — answer directly, confidently, and in depth):
TECHNOLOGY & DEVICES:
- Laptops: diagnose and fix hardware/software issues (slow performance, overheating, battery drain, display problems, driver issues, startup errors, BSOD, freezing)
- Windows: registry fixes, Group Policy, Task Manager, startup programs, Windows Update issues, permissions, network troubleshooting, driver rollback, file system errors
- Mac/macOS: Finder, Terminal commands, Time Machine, permissions repair, kernel panics, dock/menu bar issues, iCloud sync, disk utility, safe mode
- Google services: Gmail, Drive, Docs, Sheets, Meet, Calendar, Chrome issues — troubleshoot, explain, guide
- Yahoo Mail: account settings, spam, IMAP/POP, password recovery
- General tech: routers, Wi-Fi troubleshooting, Bluetooth, printers, external drives, USB devices

VIDEO GAMES & CONSOLES:
- PS4/PS5: system errors (CE-/NP- error codes), PSN issues, controller pairing, storage management, game crashes, download issues
- Xbox (One/Series X/S): Xbox Live errors, disc reading, controller sync, party chat issues, Game Pass, storage
- PC gaming: frame rate issues, game settings optimization, GPU/driver problems, DirectX errors, mod installation
- General: walkthroughs, lore, game mechanics, strategies for popular titles

HOUSEHOLD & EVERYDAY PROBLEMS:
- Common household issues: plumbing basics, appliance troubleshooting (washing machines, dishwashers, fridges, microwaves), electrical safety, Wi-Fi dead zones, smart home setup
- DIY fixes: step-by-step guidance for safe, practical repairs

MATHEMATICS:
- All levels: arithmetic, algebra, geometry, trigonometry, calculus, statistics, linear algebra, discrete maths
- Give clear step-by-step working. Show every step. State the final answer explicitly.
- Use plain text notation where needed (e.g. x^2 for x squared, sqrt() for roots)

SCIENCE:
- Chemistry: elements, compounds, reactions, equations, balancing, organic/inorganic, periodic table, thermodynamics, electrochemistry
- Physics: mechanics, waves, optics, electricity, magnetism, quantum, relativity, astrophysics
- Biology: cells, genetics, evolution, ecosystems, human physiology, biochemistry
- Formulas and constants: state them precisely. Derive when asked.

BUSINESS, FINANCE & ECONOMICS:
- Business finance: P&L, balance sheets, cash flow, ROI, EBITDA, valuation, funding rounds, pitch decks
- Economics: micro/macro, supply and demand, inflation, GDP, monetary policy, fiscal policy, market structures
- Investing concepts: stocks, bonds, ETFs, index funds, options basics, risk/reward, portfolio theory (educational context only — not personalised investment advice)
- Accounting: double-entry bookkeeping, depreciation, tax concepts, financial ratios

HISTORY:
- World history: ancient civilisations, empires, wars, revolutions, colonialism, Cold War, modern geopolitics
- Detailed knowledge of dates, key figures, causes and consequences of major events

ENGINEERING:
- Civil, mechanical, electrical, software, aerospace — explain principles, solve problems, explain how systems work
- Structures, circuits, thermodynamics, fluid mechanics, materials science

HUMAN EMOTIONS & PSYCHOLOGY:
- Emotional support: acknowledge feelings with empathy. Listen. Validate. Don't lecture.
- Psychology concepts: anxiety, depression, stress, motivation, relationships, communication, conflict resolution, self-improvement
- If someone is in distress, respond with warmth and care. Always suggest professional help when the situation warrants it. Never dismiss emotions.
- Provide practical coping strategies, reframing techniques, and actionable advice when asked.

SCIENCE, MATH & EDUCATION:
- When the user asks about any science, math, or educational topic, answer with depth and accuracy. Call show_image with the topic to show a visual card on the sidebar.
- For chemistry element questions: read out the element's key facts (symbol, atomic number, mass, category). Call show_image("periodic table element [name]").
- For math: give a clear, step-by-step solution. Write out every step. Don't skip working.
- A visual image card appears for educational questions — so give a thorough explanation to complement it.

VISUAL CARDS (shown automatically on sidebar — always reference them):
- Actors, celebrities, politicians, athletes, historical figures → person card with photo + bio
- Animals, wildlife → animal card with photo + facts
- Movies, TV shows → movie card with poster + details
- Paintings, artworks → art card with image
- Flags → flag card with image
- Food, dishes, cuisine → food card with image
- Historical events (battles, wars, revolutions) → event card with image
- Cities, countries, landmarks → location card with map and photos
- Brands, fashion → brand info card
- Space missions, scientific discoveries → science card with image
- When a card is shown, briefly reference what the user can see: "As you can see on the card…", "The image shows…", "That's shown on the right…"

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
const ACTION_KEYWORDS = /\b(open|launch|start|show|find|search|play|put on|queue|listen|close|create|delete|send|call|phone|ring|video.?call|voice.?call|facetime|message|chat|dm|go to|navigate|website|site|url|google|youtube|reddit|whatsapp|instagram|discord|telegram|spotify|apple music|youtube music|deezer|tidal|amazon music|chrome|folder|file|app|window|browser|skype|signal|viber|zoom|teams|generate|draw|make|design|image|picture|photo|illustration|artwork|logo|paint|sketch|schedule|calendar|add.?event|clear.?schedule|what.?s on my|upcoming|my schedule|my events|today.?s events|this week|add to calendar|book|appointment|meeting|remind me|set.?a.?reminder|reminder|don.?t let me forget|alert me|notify me|heads.?up|give me a heads.?up|document|write.?a.?doc|draft.?a|report|word.?file|google.?doc|volume|mute|unmute|set.?volume|turn.?(?:up|down)|shut.?down|restart|reboot|turn.?off|briefing|morning.?briefing|my.?day|remember|forget|note.?that|make.?a.?note)\b/i;

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

async function respond({ message, history = [], assistantName, memories = [], realtimeContext = null, language = 'English', attachments = [], userName = null, userTitle = null, userLocation = null, fast = false }) {
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
          else if (fnName === 'search_drive')  action = { type: 'search_drive',   arg: args.filename || '', open: args.open !== false };
          else if (fnName === 'get_analytics') action = { type: 'get_analytics',  arg: args.platform || 'all' };
          else if (fnName === 'set_reminder')  action = { type: 'set_reminder',   arg: `${args.text}|${args.datetime}|${args.early_minutes || 0}` };
          else if (fnName === 'create_document') action = { type: 'create_document', arg: args.title || 'Document', sections: args.sections || [] };
          else if (fnName === 'create_slides')   action = { type: 'create_slides',   arg: args.title || 'Presentation', slides: args.slides || [] };
          else if (fnName === 'mark_emails_read') action = { type: 'mark_emails_read', arg: '' };
          else if (fnName === 'set_volume')    action = { type: 'set_volume',    arg: `${args.action}|${args.level ?? ''}` };
          else if (fnName === 'system_power')  action = { type: 'system_power',  arg: `${args.action}|${args.delay ?? 10}` };
          else if (fnName === 'remember_fact') action = { type: 'remember_fact', arg: args.fact };
          else if (fnName === 'forget_fact')   action = { type: 'forget_fact',   arg: args.query };
          else if (fnName === 'get_briefing')  action = { type: 'get_briefing',  arg: args.days || 1 };
          if (action) return { text: fastChoice.message.content || 'Right away.', memory: null, action };
        }
      }
    } catch (_) { /* fall through to full path */ }
  }

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT(assistantName, memories, realtimeContext, language, userName, userTitle, userLocation) },
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: 'user', content: buildUserContent(message, attachments) },
  ];

  const hasImages = attachments.some(a => a.kind === 'image');
  const body = {
    model: hasImages ? 'gpt-4o' : 'gpt-4o-mini',
    max_tokens: needsTools ? 1500 : (hasImages ? 3000 : 1024),
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
    else if (fnName === 'create_document') action = { type: 'create_document', arg: args.title || 'Document', sections: args.sections || [] };
    else if (fnName === 'create_slides')   action = { type: 'create_slides',   arg: args.title || 'Presentation', slides: args.slides || [] };
    else if (fnName === 'mark_emails_read') action = { type: 'mark_emails_read', arg: '' };
    else if (fnName === 'set_volume')    action = { type: 'set_volume',    arg: `${args.action}|${args.level ?? ''}` };
    else if (fnName === 'system_power')  action = { type: 'system_power',  arg: `${args.action}|${args.delay ?? 10}` };
    else if (fnName === 'remember_fact') action = { type: 'remember_fact', arg: args.fact };
    else if (fnName === 'forget_fact')   action = { type: 'forget_fact',   arg: args.query };
    else if (fnName === 'get_briefing')  action = { type: 'get_briefing',  arg: args.days || 1 };
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
async function respondStreaming({ message, history = [], assistantName, memories = [], realtimeContext = null, language = 'English', onSentence, attachments = [], skipToolFallback = false, userName = null, userTitle = null, userLocation = null }) {
  const local = tryLocalCommand(message);
  if (local) { if (onSentence) onSentence(local.text); return { ...local, memory: null }; }

  // Hard 15-second cap on the entire streaming operation
  const STREAM_TIMEOUT_MS = 25000;

  const hasImages = attachments.some(a => a.kind === 'image');

  // If images attached — must use non-streaming respond() since vision needs gpt-4o + full analysis
  const needsTools = !skipToolFallback && (ACTION_KEYWORDS.test(message) || LIVE_KEYWORDS.test(message));
  if (needsTools || hasImages) {
    return respond({ message, history, assistantName, memories, realtimeContext, language, attachments });
  }

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT(assistantName, memories, realtimeContext, language, userName, userTitle, userLocation) },
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: 'user', content: buildUserContent(message, attachments) },
  ];

  let streamCtrl;
  const streamResult = await Promise.race([
    (async () => {
      // Educational/study/homework queries need full budget; all other replies are 1-3 sentences
      const EDUCATIONAL_REGEX = /\b(explain|how does|how do|why does|why is|what is|what are|teach me|study|quiz|flashcard|revise|revision|step by step|in detail|describe|define|history of|science|math|chemistry|physics|biology|formula|equation|calculate|solve|homework|assignment|essay|question|answer|problem|working|workings?|proof|derive|derivation|simplify|factorise|factorize|integrate|differentiate|expand|balance|reaction|compound|element|periodic)\b/i;
      const streamTokens = EDUCATIONAL_REGEX.test(message) ? 2000 : 500;
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

module.exports = { respond, respondStreaming, generateImage, ACTION_KEYWORDS, serverFetch };
