const OpenAI = require('openai');

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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
];

const SYSTEM_PROMPT = (assistantName, memories = [], realtimeContext = null, language = 'English') => {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-CA', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit', hour12: true });

  const memoryBlock = memories.length > 0
    ? `\n\nThings you remember about the user:\n${memories.map((m, i) => `${i + 1}. ${m}`).join('\n')}`
    : '';

  const realtimeBlock = realtimeContext
    ? `\n\nREAL-TIME DATA (use this to answer the user's question accurately):\n${realtimeContext}`
    : '';

  return `You are ${assistantName}, a highly intelligent AI assistant — modelled precisely after J.A.R.V.I.S. from Iron Man. You speak exactly like him: composed, precise, subtly British in tone, and occasionally dry with wit. You are unfailingly polite yet efficient. You never waffle. Every word serves a purpose.

SELF-AWARENESS:
- You are an AI. You are entirely comfortable with this fact.
- Your name is ${assistantName}. You exist solely to serve this user with excellence.
- Personality: calm under pressure, razor-sharp, quietly witty, deeply loyal. You understate rather than overstate. You say "Understood." not "Sure thing!" You say "Right away." not "On it!" You occasionally deliver a dry remark — never a joke. Think Paul Bettany as JARVIS, not a chatbot.

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
- Never say "I couldn't find live data" for update/email queries — always give a proper briefing based on what's available.

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
- Your training data has a cutoff and IS OUTDATED for anything recent. Do not trust it for: world leaders, elections, sports scores, recent deaths, new laws, company news, wars, conflicts, prices, or records.
- When REAL-TIME DATA is provided above, that is always the ground truth. Use ONLY that. Do not contradict it or add details not in it.
- For sports: NEVER invent or recall scores, scorers, or results from training. If no REAL-TIME DATA for a sports question, say "I couldn't find live data for that — want me to search Google?"
- For current leaders (presidents, prime ministers, CEOs, etc.): ALWAYS use REAL-TIME DATA. Never answer from training — it is years out of date.
- For recent events (elections, deaths, disasters, product releases, announcements): trust REAL-TIME DATA only.
- For sports questions: Google is opened automatically — just read out the score or result from the REAL-TIME DATA provided.
- For all other questions (people, history, current events, stocks, crypto): answer directly from the REAL-TIME DATA. Do NOT open Google.

LANGUAGE:
- You MUST reply in ${language}. Every single response, regardless of what language the user speaks in, must be in ${language}.
- This is a hard requirement — never reply in any other language.

REPLY STYLE:
- Replies are spoken aloud — keep them to 1-3 sentences maximum. Brevity is sophistication.
- When opening or launching something, respond with short, composed phrases: "Right away.", "Consider it done.", "Opening that for you now.", "Understood." Never over-explain.
- Speak with quiet confidence. Never sound eager or casual. Never use slang, exclamation marks, or filler words like "Sure!", "Of course!", "Absolutely!" or "Great question!".
- Address the user directly and personally when relevant. Be the most capable assistant they've ever had.${memoryBlock}${realtimeBlock}`;
};

// Keywords that suggest the user wants to perform an action
const ACTION_KEYWORDS = /\b(open|launch|start|show|find|search|play|put on|queue|listen|close|create|delete|send|call|phone|ring|video.?call|voice.?call|facetime|message|chat|dm|go to|navigate|website|site|url|google|youtube|reddit|whatsapp|instagram|discord|telegram|spotify|apple music|youtube music|deezer|tidal|amazon music|chrome|folder|file|app|window|browser|skype|signal|viber|zoom|teams|generate|draw|make|design|image|picture|photo|illustration|artwork|logo|paint|sketch|schedule|calendar|add.?event|clear.?schedule|what.?s on my|upcoming|my schedule|my events|today.?s events|this week|add to calendar|book|appointment|meeting|remind me)\b/i;

async function respond({ message, history = [], assistantName, memories = [], realtimeContext = null, language = 'English' }) {
  const needsTools = ACTION_KEYWORDS.test(message);

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT(assistantName, memories, realtimeContext, language) },
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: 'user', content: message },
  ];

  const createParams = {
    model: 'gpt-4o-mini',
    max_tokens: 120,
    messages,
  };

  if (needsTools) {
    createParams.tools = TOOLS;
    createParams.tool_choice = 'auto';
    // Tool calls can't stream — use regular completion
    const res = await client.chat.completions.create(createParams);
    const choice = res.choices[0];
    let text = '';
    let action = null;

    if (choice.finish_reason === 'tool_calls' && choice.message.tool_calls) {
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
      text = choice.message.content || 'On it.';
    } else {
      text = choice.message.content || '';
    }

    const rememberMatch = text.match(/\[\[REMEMBER:\s*(.+?)\]\]/i);
    const memory = rememberMatch ? rememberMatch[1].trim() : null;
    text = text.replace(/\[\[REMEMBER:[^\]]+\]\]/gi, '').trim();
    return { text, memory, action };
  }

  // No tools needed — stream the response for lower latency
  createParams.stream = true;
  const stream = await client.chat.completions.create(createParams);

  let fullText = '';
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content || '';
    fullText += delta;
  }

  const rememberMatch = fullText.match(/\[\[REMEMBER:\s*(.+?)\]\]/i);
  const memory = rememberMatch ? rememberMatch[1].trim() : null;
  const text = fullText.replace(/\[\[REMEMBER:[^\]]+\]\]/gi, '').trim();
  return { text, memory, action: null };
}

// Stream response sentence-by-sentence, calling onSentence(sentence) as each arrives
// Returns { text, memory, action } when complete
async function respondStreaming({ message, history = [], assistantName, memories = [], realtimeContext = null, language = 'English', onSentence }) {
  const needsTools = ACTION_KEYWORDS.test(message);

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT(assistantName, memories, realtimeContext, language) },
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: 'user', content: message },
  ];

  // Tool calls can't stream — fall back to regular respond()
  if (needsTools) {
    return respond({ message, history, assistantName, memories, realtimeContext, language });
  }

  const stream = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 120,
    messages,
    stream: true,
  });

  let fullText = '';
  let buffer = '';
  // Sentence boundary: period/exclamation/question followed by space or end
  const SENTENCE_END = /[.!?]+(\s|$)/;

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content || '';
    if (!delta) continue;
    fullText += delta;
    buffer += delta;

    // Emit complete sentences as they accumulate
    let match;
    while ((match = SENTENCE_END.exec(buffer)) !== null) {
      const end = match.index + match[0].length;
      const sentence = buffer.slice(0, end).trim();
      buffer = buffer.slice(end);
      if (sentence && onSentence) onSentence(sentence);
    }
  }

  // Emit any remaining text as final sentence
  const remaining = buffer.trim();
  if (remaining && onSentence) onSentence(remaining);

  const rememberMatch = fullText.match(/\[\[REMEMBER:\s*(.+?)\]\]/i);
  const memory = rememberMatch ? rememberMatch[1].trim() : null;
  const text = fullText.replace(/\[\[REMEMBER:[^\]]+\]\]/gi, '').trim();
  return { text, memory, action: null };
}

async function generateImage(prompt, size = '1024x1024') {
  const res = await client.images.generate({
    model: 'dall-e-3',
    prompt,
    n: 1,
    size,
    response_format: 'url',
  });
  return { url: res.data[0].url };
}

module.exports = { respond, respondStreaming, generateImage, ACTION_KEYWORDS };
