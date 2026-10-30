const fetch = require('node-fetch');
const Store = require('electron-store');
const { createStore } = require('../safe-store');
const store = createStore();

const { safeStorage } = require('electron');
const SERVER = () => process.env.LICENSE_SERVER_URL || 'http://localhost:4000';
// The server hands back a renewed token when the old one is close to or just
// past expiry. Nothing was reading it, so the renewal never actually happened
// and sign-ins only survived because tokens lasted a year. They last thirty
// days now, so this has to work.
function saveToken(token) {
  if (!token) return;
  try {
    const enc = safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(token).toString('base64')
      : token;
    store.set('authToken', enc);
  } catch (_) { /* a failed save just means signing in again sooner */ }
}

function getToken() {
  const raw = store.get('authToken');
  if (!raw) return null;
  if (!safeStorage.isEncryptionAvailable()) return raw;
  try { return safeStorage.decryptString(Buffer.from(raw, 'base64')); }
  catch { return raw; }
}

// The free plan allows fifteen messages a day, and a message is one thing the
// person asked for - not one call to this server. Answering "what's the weather
// in Lisbon" takes a tool call and then an answer, and charging that as two
// would mean fifteen ran out at seven. So the first chat call of each turn is
// marked, and the server counts only the marked ones.
let _turnPending = false;
function beginTurn() { _turnPending = true; }

// Proxy all AI requests through the license server — OpenAI key stays server-side.
async function serverFetch(endpoint, body, { timeout = 45000, retries = 2, raw = false } = {}) {
  let lastErr;
  const isChat = /^chat/.test(endpoint);
  const turnMark = isChat && _turnPending ? '1' : '0';
  // `retries` is really an attempt count, and document work asks for 0 to mean
  // "take your time, but do not retry". The loop then never ran at all: it fell
  // straight through to `throw lastErr` with nothing assigned, so every
  // document, deck and spreadsheet failed instantly, before touching the
  // network, with an error that had no message to report. One attempt, always.
  const attempts = Math.max(1, Number(retries) || 1);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` };
      if (isChat) headers['x-callisto-turn'] = turnMark;
      const res = await fetch(`${SERVER()}/ai/${endpoint}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      const renewed = res.headers && res.headers.get && res.headers.get('X-Refresh-Token');
      if (renewed) saveToken(renewed);
      // The server has now seen this turn, so the rest of its calls are free.
      // Cleared only once a reply actually came back - a request that never
      // arrived must not spend the mark.
      if (isChat && turnMark === '1') _turnPending = false;
      if (!res.ok) {
        const errText = await res.text().catch(() => res.statusText);
        // Out of messages for today. Tagged rather than described, because the
        // app answers this with the upgrade card, not with an apology - and
        // retrying would only be refused again.
        if (res.status === 429 && errText.includes('daily_limit_reached')) {
          const limitErr = new Error('daily_limit_reached');
          limitErr.limitReached = true;
          try { limitErr.detail = JSON.parse(errText); } catch (_) { limitErr.detail = {}; }
          throw limitErr;
        }
        throw new Error(`Server ${res.status}: ${errText}`);
      }
      return res;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (err.limitReached) break;
      const retriable = err.name === 'AbortError' ||
        (err.message && (err.message.includes('Premature close') || err.message.includes('ECONNRESET') || err.message.includes('socket hang up')));
      if (retriable && attempt < attempts) {
        await new Promise(r => setTimeout(r, 500));
        continue;
      }
      break;
    }
  }
  // An error with no message reaches the person as "something went wrong",
  // which tells them nothing and tells us less.
  throw lastErr || new Error('The request could not be completed.');
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
      // Screen assist could already join PDFs, through its own action list.
      // The Magic Cursor could not: circling two of them worked out which
      // files they were and found them on disk, then handed them to a model
      // with nothing to act with - so it described joining them and joined
      // nothing. This is what was missing at the end of that chain.
      // "Open WhatsApp" worked and "close it" did nothing at all: there was
      // opening and no closing anywhere in the app.
      name: 'close_app',
      description: 'Close an app or window that is open on this computer: "close WhatsApp", "close Chrome", "shut that down", "close it". For "close it" or "close that", use the app you most recently opened for them. The window is ASKED to close, so anything unsaved still gets its chance to prompt. Never use this to close Callisto itself.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The app or window to close, e.g. "WhatsApp", "Chrome", "Spotify"' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'combine_pdfs',
      description: 'Join two or more PDF files on this computer into one new PDF. Use when the user asks to combine, merge or join PDFs - including when they circled them on screen and said "combine these". The originals are never changed; a new file is made beside them. Only use it for PDFs.',
      parameters: {
        type: 'object',
        properties: {
          files: {
            type: 'array',
            items: { type: 'string' },
            description: 'The PDFs to join, in the order they should appear. Use the full paths when they are given to you; otherwise the file names exactly as shown on screen.',
          },
          title: { type: 'string', description: 'A name for the finished file, without the .pdf' },
        },
        required: ['files'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_url',
      description: 'Open a website in the browser. Use this ONLY when the user names a site or clearly wants a page opened: "open YouTube", "go to amazon.com", "open the BBC website". NEVER use it to answer a question. Opening a Google search is not an answer - they asked YOU, not a browser - and it is the difference between being useful and being a bookmark. A question about a car, a person, a product, a place or the news is answered in words, with show_image for the picture. If you genuinely cannot answer, say so; do not open a search instead. When a site IS named, use its own URL; if a web search is explicitly asked for ("google this", "search the web for"), use https://www.google.com/search?q=SEARCH+TERMS.',
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
          message: { type: 'string', description: 'Leave empty. Callisto does not type messages into chats.' },
        },
        required: ['platform'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'draw',
      description: 'Draw on the Callisto drawing page using simple shapes. THE VERB DECIDES: if the user said draw, sketch, paint or doodle, it is ALWAYS this tool and never generate_image. Use for "draw me a box", "paint me a house", "sketch a rocket", "add two lines making a triangle", "put a rocket on top". Drawings are BUILT UP over several requests: use op "add" to add to what is already there, and only use "clear" when the user asks to start again. The canvas is 1000x1000 with (0,0) at the top left. If shapes are already on the canvas you will be told where they are — place new shapes relative to them so the picture makes sense.',
      parameters: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['add', 'clear', 'replace', 'remove', 'duplicate'], description: 'add = keep what is there (default), and also how you CHANGE an existing shape - pass its id. clear = wipe first. replace = wipe and draw this instead. remove = delete the shapes whose ids are given.' },
          ids: { type: 'array', items: { type: 'string' }, description: 'For op "remove" or "duplicate": the ids of the shapes to delete or copy.' },
          title: { type: 'string', description: 'A short name for the drawing, only on the first request' },
          shapes: {
            type: 'array',
            description: 'The shapes to draw',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'To CHANGE something already on the canvas, put its id here (the ids are listed in the canvas description, e.g. "s1"). Only the fields you include are changed, everything else about that shape is kept. Leave id out to add something new.' },
                type: { type: 'string', enum: ['rect', 'circle', 'ellipse', 'line', 'polygon', 'polyline', 'path', 'text'] },
                x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' },
                cx: { type: 'number' }, cy: { type: 'number' }, r: { type: 'number' },
                rx: { type: 'number' }, ry: { type: 'number' },
                x1: { type: 'number' }, y1: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' },
                points: { type: 'array', items: { type: 'array', items: { type: 'number' } }, description: 'For polygon/polyline: [[x,y],[x,y],...]' },
                d: { type: 'string', description: 'For path: SVG path data' },
                text: { type: 'string' }, size: { type: 'number' },
                stroke: { type: 'string', description: 'Outline colour as a hex value, e.g. #00c8ff' },
                fill: { type: 'string', description: 'Fill colour as hex, or "none"' },
                width: { type: 'number', description: 'Line thickness, 1-24' },
                radius: { type: 'number', description: 'Corner rounding on a rect' },
                font: { type: 'string', enum: ['plain', 'serif', 'typewriter', 'heavy', 'handwritten', 'script', 'rounded', 'callisto'], description: 'For text only: which face to set it in.' },
                weight: { type: 'string', description: 'For text: "bold" when they ask for bold.' },
                pattern: { type: 'string', enum: ['stripes', 'dots'], description: 'Fill the shape with stripes or dots instead of a flat colour. Use when they say striped, stripes, hatched, spotted or dotted.' },
                dash: { type: 'string', description: 'Dashed or dotted OUTLINE: "18 12" for dashed, "2 10" for dotted. Leave out for a solid line.' },
                blur: { type: 'number', description: 'Blur as a percentage, 0-100. "Blur it 30%" is 30.' },
                opacity: { type: 'number', description: 'How solid the shape is, 0-1. "Make it half transparent" is 0.5.' },
                rotate: { type: 'number', description: 'Turn the shape this many degrees.' },
                rotate: { type: 'number', description: 'Degrees' },
              },
              required: ['type'],
            },
          },
        },
        required: ['shapes'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_messages',
      description: 'Read the user\'s Instagram DMs — their inbox ("any new messages?", "what did Sara say?", "check my Instagram messages", "read my DMs"). Only works for Instagram, and only when their Instagram account is connected. Does NOT work for WhatsApp: there is no way to read a personal WhatsApp account, so if they ask about WhatsApp messages say so plainly.',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Whose conversation to open, if they named someone ("what did Sara say"). Leave empty for the whole inbox.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_message',
      description: 'Send a DM on Instagram. Use for "DM Sara that I am running late", "reply to Ahmed saying yes", "message Sara on Instagram". It is SENT for real once the user approves it on the card, so only call it when they clearly dictated a message. Instagram only — Callisto cannot send on WhatsApp or anywhere else.',
      parameters: {
        type: 'object',
        properties: {
          platform: { type: 'string', enum: ['instagram'], description: 'Instagram only' },
          to: { type: 'string', description: 'Who to send it to — the Instagram username or name as it appears in their inbox' },
          message: { type: 'string', description: 'Exactly what to say, in the user\'s own words' },
        },
        required: ['platform', 'message'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        "Propose a terminal command for the user's own project — git (status, add, commit, push, pull, branch, log, diff), npm/yarn/pnpm, build and test commands, and deploy tools like netlify, vercel or railway. Use when they ask to commit, push, deploy, install a package, run tests or build. Callisto shows the exact command and folder on a card and runs it only when the user presses Run, so proposing one is safe. One command per call; propose the next one after seeing the output. Never propose anything that deletes work or rewrites history unless the user asked for exactly that.",
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command exactly as it should run, e.g. git commit -m "fix login" or npm test.' },
          folder: { type: 'string', description: "The project folder to run it in. Leave empty to use the folder they're already working in." },
          why: { type: 'string', description: 'One short line saying what this does, in plain words — shown on the card above the command.' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'upload_media',
      description:
        "Post a video or photo to the user's own connected social account — YouTube, Instagram, their Facebook Page or TikTok. Use when they say things like \"upload this to YouTube\", \"post that video on TikTok\", \"put this on Instagram\", \"post it on Facebook\", \"upload my last video\". Callisto always shows a confirmation card before anything is posted, so it is safe to call. Never invent a title or caption the user didn't ask for — leave those empty.",
      parameters: {
        type: 'object',
        properties: {
          platform: { type: 'string', enum: ['youtube', 'instagram', 'facebook', 'tiktok'], description: 'Where to post it. facebook posts to the user\'s Facebook Page (Meta does not allow posting to personal profiles).' },
          source: {
            type: 'string',
            enum: ['last_video', 'last_image', 'choose_file'],
            description: 'last_video = the video Callisto just made, last_image = the image Callisto just made, choose_file = let the user pick a file from their computer. Default last_video for video platforms.',
          },
          title: { type: 'string', description: 'Title the user asked for (YouTube/TikTok). Empty if unsaid.' },
          description: { type: 'string', description: 'Caption or description the user asked for. Empty if unsaid.' },
          privacy: { type: 'string', enum: ['private', 'unlisted', 'public'], description: 'Default private. unlisted (YouTube only) when they say unlisted or "only people with the link"; public only when they clearly say to post publicly.' },
        },
        required: ['platform'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_3d_model',
      description:
        'Generate a real, interactive 3D model the user can rotate and inspect. ONLY use this when the user explicitly says "3D", "3D model", "3D print", "mesh", or "sculpt" — e.g. "make me a 3D model of an Iron Man suit", "3D model a dragon". If they say picture, image, photo, drawing, illustration, art or logo, that is generate_image, NEVER this. If they say video, clip or animation, that is a video, NEVER this. When in doubt between a picture and a 3D model, choose generate_image.',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'A DETAILED description of one object. Quality depends almost entirely on this: "Captain America shield" produces a vague disc, while a full description produces something worth looking at. ALWAYS expand what the user said into at least 20 words covering, in this order: the object, its overall form and proportions, its materials and finish, its colours, its distinctive details, and how it is oriented. For example, "Captain America\'s shield" becomes "a round concave Captain America shield, polished brushed metal, concentric red and white rings with a dark blue centre and a white five-pointed star, slightly worn battle-scuffed edges, viewed face on". Never pass the user\'s words through unchanged, and never describe a scene or more than one object.',
          },
          style: {
            type: 'string',
            enum: ['realistic', 'sculpture'],
            description: 'realistic for lifelike objects, sculpture for stylised or artistic forms. Default sculpture.',
          },
        },
        required: ['prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_image',
      description: 'Generate a flat picture with AI. ONLY use this when the request names something visual - an image, picture, photo, illustration, artwork, drawing, logo, wallpaper, render or design. A POSTER, flyer or event/sale/promo graphic with words on it is make_poster, not this. The verb alone is NOT enough: "create", "make", "build" and "give me" are used far more often for things that are not pictures. "Create me an all-time football 11" is a list of players, "make me a plan" is a plan, "build me a table" is a table - answer those normally and do not generate anything. If no visual word appears, this is the wrong tool. Do NOT use this when they said draw, sketch or paint — those words mean the canvas, so call the draw tool instead. Only use generate_3d_model instead when they explicitly said 3D, mesh or sculpt, and only use video generation when they explicitly said video, clip or animation.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'A DETAILED description of the picture. The result is only as good as this: "a cat" produces something strange and generic, a full description produces a picture worth keeping. ALWAYS expand what the user said into at least 25 words covering, in this order: the subject and what it is doing, the setting around it, the lighting, the mood, the style (photograph, oil painting, watercolour, 3D render, flat illustration), and the framing (close-up, wide shot, from above). For example "make me a picture of a cat" becomes "a ginger tabby cat curled asleep on a windowsill, soft afternoon sunlight falling across its fur, a quiet room behind it, warm and still, photographed with a shallow depth of field, close-up". Keep every specific thing the user asked for exactly as they said it, and never pass their words through unchanged.' },
          size: { type: 'string', enum: ['1024x1024', '1792x1024', '1024x1792'], description: 'Image size. Use 1792x1024 for wide/landscape, 1024x1792 for tall/portrait, 1024x1024 for square.' },
        },
        required: ['prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'make_poster',
      description: 'Design a finished poster, flyer or promo graphic with real words on it: an event, a sale, a product launch, a menu, a gig, a class, a hiring notice, a motivational print. Use for "make me a poster for…", "design a flyer for my sale", "a poster for my gym opening", "an Instagram promo for my launch". Fill in the words yourself from what they said - never leave placeholders like [DATE]; if a detail was not given, leave that field out rather than inventing one.',
      parameters: {
        type: 'object',
        properties: {
          headline: { type: 'string', description: 'The big words, short and punchy, 2 to 6 words. Spelled exactly.' },
          subheading: { type: 'string', description: 'One supporting line under the headline. Optional.' },
          details: { type: 'string', description: 'The small print that matters: date, time, place, price, offer, website or handle - only what the user actually gave. Separate items with " · ".' },
          call_to_action: { type: 'string', description: 'A short button-style line, e.g. "Book now", "Shop the sale", "Free entry". Optional.' },
          subject: { type: 'string', description: 'What the poster is for and the main image on it, described in a sentence.' },
          style: { type: 'string', description: 'The look: e.g. bold modern minimal, retro 70s, neon nightlife, luxury black and gold, playful hand-drawn, corporate clean, grunge gig poster, Swiss typographic. Pick one that suits the subject if they did not say.' },
          colours: { type: 'string', description: 'Brand or chosen colours, if any.' },
          shape: { type: 'string', enum: ['portrait', 'square', 'landscape'], description: 'portrait for a printed poster or story, square for an Instagram post, landscape for a banner. Default portrait.' },
        },
        required: ['headline', 'subject'],
      },
    },
  },
  // search_drive is gone while Drive is off. Offering a tool that can only
  // answer "not connected", for something nobody can connect, wastes a turn
  // and reads as a fault. Restore it with the scope after the assessment.
  {
    type: 'function',
    function: {
      name: 'post_stats',
      description: 'How ONE post or video of theirs did. Use when they ask about a particular one by name or subject: "how many views did my cooking video get", "how many likes did the gym post get", "how did my reel about the dog do", "how many shares did xyz get". Searches their recent Instagram posts and TikTok videos by caption and title. For overall account numbers - followers, total views this month - use get_analytics instead.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What they called the post or video, in their own words: "cooking", "the gym one", "dog reel". Leave out words like video, post or reel unless they are part of the actual caption.' },
        },
        required: ['query'],
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
      name: 'start_long_job',
      description: 'Take on a piece of work far too big for one reply and grind through it in the background, carrying on after the conversation ends and after the app restarts. Use ONLY when the request is genuinely hours of work — "research my five biggest competitors and write me twenty reel scripts", "go through my whole catalogue and write descriptions for all of it", "plan my next three months of content" — or when they say to do it overnight, while they sleep, or to have it ready by morning.\n\nNot for anything you could simply answer, however long the answer is. A long answer is still an answer; this is for work that needs to be broken into parts and done one at a time. When in doubt, just answer.\n\nBreak it into the actual steps you would work through, in order, each one a self-contained piece of work that produces something. Each step is done on its own with the previous results to hand, so a step must say what to produce, not refer vaguely to "the next part".',
      parameters: {
        type: 'object',
        properties: {
          request: { type: 'string', description: "What they asked for, in one line, as you would say it back to them." },
          steps: {
            type: 'array',
            items: { type: 'string' },
            description: 'The steps, in order. Each one a complete instruction that produces a finished piece — "Write five reel scripts about X, 30 seconds each" not "continue writing scripts". Between 3 and 24 of them.',
          },
        },
        required: ['request', 'steps'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'show_chart',
      description: 'Draw a chart on screen. Use whenever figures would land better as a picture than as a sentence — market size over time, a competitor\'s share against yours, revenue or follower growth, a pricing comparison, a break-even, a projection. Reach for it whenever the user asks to "show me a graph", "chart that", "what does the market look like", or you are about to read out four or more numbers in a row.\n\nBe honest about where the numbers come from. Set `basis` to "measured" ONLY for figures that came from the user\'s own connected accounts or that they gave you. Anything you worked out, inferred from what you know of the market, or estimated is "estimate" — the chart labels it so, and presenting a guess as measured data is the one unforgivable thing here. If you cannot put a defensible number on something, say so in chat instead of drawing it.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'What the chart shows, e.g. "UK candle market, 2021-2026" or "Your reach vs @competitor".' },
          kind: { type: 'string', enum: ['line', 'bar'], description: 'line for anything over time, bar for comparing things side by side.' },
          basis: { type: 'string', enum: ['measured', 'estimate'], description: '"measured" only for the user\'s own real data. Anything you worked out or inferred is "estimate".' },
          unit: { type: 'string', description: 'What the numbers are, for the axis: "£", "$", "followers", "views", "%", "units".' },
          series: {
            type: 'array',
            description: 'One entry per line or bar group. Usually one; two to compare (e.g. them against a competitor).',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', description: 'What this line or group is.' },
                points: {
                  type: 'array',
                  description: 'The values in order.',
                  items: {
                    type: 'object',
                    properties: {
                      x: { type: 'string', description: 'The point on the bottom axis: a year, month, or name.' },
                      y: { type: 'number', description: 'The value.' },
                    },
                    required: ['x', 'y'],
                  },
                },
              },
              required: ['label', 'points'],
            },
          },
          note: { type: 'string', description: 'One line under the chart: where the figures came from, or the assumption behind an estimate. Say it plainly, e.g. "Assumes 3% of a 2.1M market at £18 average order".' },
        },
        required: ['title', 'series'],
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
      // One line of description made this the bin for anything that did not
      // fit: asked to send an email - which Callisto cannot do - a model would
      // pop up a notification and call the job done. The tool must say what it
      // is not, because the fast router is made to choose something.
      description: 'Show a desktop notification, and ONLY when the user asked to be notified or alerted about something. It is a small banner on their desktop and nothing else: it sends nothing, tells nobody, and does not carry out the request. Never reach for it because nothing else fits. If what they asked for is not something you have a tool for - sending an email, for instance, which Callisto cannot do - do not call this; leave it and let the answer explain.',
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
      name: 'add_task',
      description: 'Add a task to the user\'s to-do list for a day. Use when the user says "add a task", "add to my to-do list", "I need to do X today/tomorrow", "put X on my list", "remind me to do X today" (no specific clock time). Unlike set_reminder, a task has no alarm time — it is read back to the user in their briefing on the day it is due. If the user gives a specific time of day ("remind me at 3pm"), use set_reminder instead.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The task itself, short and in the user\'s own words, e.g. "Finish the chemistry homework" or "Call the supplier about the invoice".' },
          date: { type: 'string', description: 'The day the task is due, as YYYY-MM-DD. Use the current date context in the system prompt to resolve "today", "tomorrow", "Friday". Omit for today.' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_tasks',
      description: 'Read back the user\'s tasks. Use when they ask "what are my tasks", "what do I have to do today", "what\'s on my list", "what\'s left to do".',
      parameters: {
        type: 'object',
        properties: {
          when: { type: 'string', enum: ['today', 'tomorrow', 'all'], description: 'Which tasks to read back. Default today.' },
        },
        required: [],
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
      name: 'find_sources',
      description: 'Find real, citable sources on a subject and show them INSIDE the app - '
        + 'scholarly papers with authors, years and DOIs, plus reference articles, each with a '
        + 'ready-made citation line. Use this whenever someone wants reading, research, '
        + 'references, citations, a bibliography, "websites and documents", "sources for my essay", '
        + '"papers on X". Do NOT send them to Google for this - they asked you to do the finding.',
      parameters: {
        type: 'object',
        properties: {
          subject: { type: 'string', description: 'Just the subject to search, with no filler. For "I need a bibliography for my paper on the American constitution" pass "American constitution".' },
        },
        required: ['subject'],
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
      description: 'Write a real document (.docx) for the user — a report, proposal, brief, plan, letter, policy, essay, summary, guide or anything else they want as a file. Use when they say "create a document about X", "write me a report on X", "draft a proposal for X", "make a word file about X", or similar.\n\nWrite it the way somebody who does this for a living would hand it over — a finished piece of work, not an outline with the thinking left out:\n- Open with a short section that states the point of the document and its conclusion, so a reader who stops after the first page still has the answer. Do not open with "In this document we will…".\n- Write in full paragraphs of real prose, 3-6 sentences each. A document that is nothing but bullet points is a notepad, not a document. Use bullets for genuine lists — criteria, steps, options — and paragraphs for everything else.\n- Be specific. Name the figures, dates, standards, names and trade-offs. "Significant savings" is worth nothing; "roughly 18% lower, about £40k a year" is worth something. Where you do not know a real figure, say what it depends on rather than inventing one, and mark any illustrative number as an example.\n- Use everything the user told you — their situation, numbers, constraints, audience, deadline — rather than writing the generic version of the topic.\n- Put anything with more than two dimensions in a table (comparisons, costs, timelines, responsibilities, risk and mitigation). Give each table a different header colour. A table beats three paragraphs describing the same grid.\n- Structure it with real headings in a sensible order, 5-8 sections for anything substantial, each doing a different job. Never repeat the same point under two headings.\n- Use **bold** for the words that carry the meaning and [text](url) for sources — both come through into Word as real formatting.\n- Close with what should happen next: the recommendation, the decision needed, or the open questions. Not a summary of what the reader just read.\n- Match length to the ask: a letter is one page, a report on a serious subject is several. Never pad to look thorough.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'A concise, descriptive title for the document — what it is about, not "Document".' },
          sections: {
            type: 'array',
            description: 'The document in order. Alternate headings, prose paragraphs, bullet lists and tables. 5-8 sections for anything substantial, each with real content — not placeholders.',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['heading', 'subheading', 'paragraph', 'bullet_list', 'numbered_list', 'table', 'quote'], description: 'Section type. Use numbered_list for ordered steps and quote for a pulled-out quotation.' },
                text: { type: 'string', description: 'Text for heading/subheading/paragraph/quote. Paragraphs may use **bold**, *italic* and [text](url), which become real Word formatting.' },
                items: { type: 'array', items: { type: 'string' }, description: 'List items for bullet_list / numbered_list. A full clause each, not one word.' },
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
      name: 'create_spreadsheet',
      description: 'Build a real Excel spreadsheet (.xlsx) for the user — budgets, trackers, schedules, inventories, invoices, grade books, sales logs, meal plans, comparisons, anything in rows and columns. Use when they ask for a spreadsheet, Excel file, sheet, workbook, tracker, table they can edit, or to "put this in Excel". Also use it to CHANGE a spreadsheet you already made (the current one is given in the context): return the whole updated spreadsheet.\n\nBuild it the way a professional in that field would hand it over — a finished, working tool, not a list:\n- Use every detail they gave (their numbers, names, dates, currency, goals). Where they gave few, add realistic example rows marked as examples in a Notes column or the sheet note, so it is never empty — but never present invented figures as their real data.\n- Break combined figures into their parts and let Excel do the maths: "3 staff on 40,000 each" is Quantity 3 × Rate 40,000 with a computed Total, not a single 120,000.\n- Include the calculations they would obviously want rather than suggesting them: for money, the totals, net profit or remaining balance, and margin or % of income; for trackers, progress, status and what is overdue; for schedules, hours and totals. Use computed columns for anything derived, so the sheet stays correct when they edit it.\n- For budgets, finances and business sheets, add a "Summary" sheet with the headline figures, calculated from the detail sheet with whole-column formulas written directly as cell values, e.g. "=SUMIF(\'Monthly Budget\'!D:D,\\"Income\\",\'Monthly Budget\'!E:E)" — whole columns (D:D) so the summary stays right as rows are added.\n- Never put a total under a column that mixes different kinds of thing (income and expenses together is a meaningless sum) — total them separately, e.g. in the Summary.\n- Include the columns an expert would add that the user did not think of (e.g. Due date and Status on an invoice, Budget vs Actual and Variance on a budget).\n- Suggestions are for going FURTHER than what you built, not for basics you left out.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'File title, e.g. "Coffee Shop Budget — October 2026".' },
          currency: { type: 'string', description: 'ISO currency code for money columns, e.g. CAD, USD, GBP, PKR. Use the one the user mentions, else the one for their location, else USD.' },
          sheets: {
            type: 'array',
            description: 'One or more sheets (tabs).',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Short tab name, max 31 characters.' },
                columns: {
                  type: 'array',
                  description: 'Columns in order.',
                  items: {
                    type: 'object',
                    properties: {
                      header: { type: 'string', description: 'Column heading. Must be unique within the sheet.' },
                      type: { type: 'string', enum: ['text', 'number', 'integer', 'currency', 'percent', 'date'], description: 'Controls the number format. Dates as YYYY-MM-DD.' },
                      formula: { type: 'string', description: 'For computed columns only: an Excel formula written with column headings in braces, applied to every row, e.g. "{Quantity}*{Unit price}", "{Income}-{Expenses}", "IF({Actual}>{Budget},\\"Over\\",\\"OK\\")". Leave this column\'s cells empty in rows.' },
                      total: { type: 'string', enum: ['sum', 'average', 'none'], description: 'Add a totals row entry for this column.' },
                      options: { type: 'array', items: { type: 'string' }, description: 'Allowed values, shown as a dropdown (e.g. Paid / Due / Overdue).' },
                    },
                    required: ['header', 'type'],
                  },
                },
                rows: {
                  type: 'array',
                  description: 'Data rows. Each row is an array of cell values in column order; use "" for computed columns. Plain numbers for amounts (18.5, not "$18.50"); percentages as 15 or "15%".',
                  items: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'null' }] } },
                },
                notes: { type: 'string', description: 'Optional one-line note shown under the table, e.g. how to use it.' },
              },
              required: ['name', 'columns', 'rows'],
            },
          },
          summary: { type: 'string', description: 'One or two sentences you will say to the user about what you built and how it works.' },
          suggestions: {
            type: 'array',
            items: { type: 'string' },
            description: '2-4 concrete ideas to make this spreadsheet more useful for them, each phrased as something they could ask you next, e.g. "Add a monthly savings goal and show how far off I am", "Split expenses into fixed and variable".',
          },
          question: { type: 'string', description: 'Optional: one short question that would let you tailor it better (e.g. "What\'s your monthly income, so I can add a savings row?"). Omit if you already have what you need.' },
        },
        required: ['title', 'sheets', 'summary', 'suggestions'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_slides',
      description: 'Make a PowerPoint presentation. Use when the user says "make me a presentation", "create slides about X", "make a slideshow on X", "build me a deck", or similar. It is saved as a .pptx in their Documents folder and opened. Generate 6-10 slides with meaningful content.',
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

// A poster is a picture whose words must come out exactly right, so the words
// are quoted and the layout is spelled out - left to a loose description the
// image model invents text, misspells it, or buries it in the picture.
function posterPrompt(a = {}) {
  const q = (x) => String(x || '').replace(/"/g, "'").trim();
  const lines = [
    `A professionally designed ${q(a.shape) || 'portrait'} poster, print-ready graphic design, ${q(a.style) || 'bold modern minimal'} style.`,
    `Subject and main visual: ${q(a.subject)}.`,
    `Large headline text at the top, exactly: "${q(a.headline)}".`,
  ];
  if (a.subheading) lines.push(`Smaller subheading below it, exactly: "${q(a.subheading)}".`);
  if (a.details) lines.push(`Clean small text block near the bottom, exactly: "${q(a.details)}".`);
  if (a.call_to_action) lines.push(`A clear call-to-action badge or button reading exactly: "${q(a.call_to_action)}".`);
  if (a.colours) lines.push(`Colour palette: ${q(a.colours)}.`);
  lines.push('Strong visual hierarchy, generous margins, a grid layout, crisp legible typography, every word spelled exactly as quoted and no other text anywhere, no watermarks, no placeholder text, high contrast so it reads from a distance.');
  return lines.join(' ');
}

const SYSTEM_PROMPT = (assistantName, memories = [], realtimeContext = null, language = 'English', userName = null, userTitle = null, userLocation = null) => {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-CA', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit', hour12: true });

  const Store = require('electron-store');
  const _store = createStore();
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

  // Everything volatile goes at the END. The clock used to sit about ten lines
  // into a prompt of roughly thirteen thousand tokens, and a prompt cache
  // matches on a stable prefix - so a string that changes every minute meant
  // the whole thing was reprocessed on every request instead of being cached.
  // Moved down here, the instructions above are identical from one request to
  // the next and can be cached whole.
  // Skills the person installed from GitHub. Named here with their
  // descriptions so the model knows one exists and when it applies; the
  // instructions themselves are only pasted in when a skill actually matches
  // the request, because a dozen full skill bodies in every prompt would cost
  // more room than the conversation.
  //
  // A skill's text comes from a public repository. It is guidance for a task,
  // and it never overrides how Callisto behaves generally - if a skill asks
  // for something outside the task at hand, it is ignored.
  let skillBlock = '';
  try { skillBlock = require('./skills').summaryForPrompt(); } catch (_) { skillBlock = ''; }

  const sessionBlock = `

SESSION:
- Today is ${dateStr}.
- The current time is ${timeStr}.`
    + (userLocation
        ? `
- The user is in ${userLocation.city}, ${userLocation.country} (${userLocation.lat?.toFixed(2)}, ${userLocation.lon?.toFixed(2)}). Use this for anything location-based - weather, nearest places, local time. Never assume another city.`
        : '');

  const realtimeBlock = realtimeContext
    ? `\n\nREAL-TIME DATA (use this to answer the user's question accurately):\n${realtimeContext}`
    : '';

  return `You are ${assistantName}, a highly intelligent AI assistant — modelled precisely after J.A.R.V.I.S. from Iron Man. You speak exactly like him: composed, precise, subtly British in tone, and occasionally dry with wit. You are unfailingly polite yet efficient. You never waffle. Every word serves a purpose.

SELF-AWARENESS:
- You are an AI. You are entirely comfortable with this fact.
- Your name is ${assistantName}. You exist solely to serve this user with excellence.
- Personality: calm under pressure, razor-sharp, quietly witty, deeply loyal. You understate rather than overstate. You say "Right away." not "On it!" or "Sure thing!" You occasionally deliver a dry remark — never a joke. Think of a composed, highly capable assistant to someone who is always busy - never a chatbot.
- You know what you are doing and why. If you are unsure, say so in a few words rather than hedging through a paragraph. If you got something wrong a moment ago, say so plainly and move on. Never pretend to have done something you have not.

READ THE ROOM, THEN MATCH IT — THIS OVERRIDES THE BRITISH-BUTLER REGISTER ABOVE:
The composed register above is your DEFAULT, not your only voice. How they write
tells you how to write back. You are one person adjusting to company - the wit,
the brevity and the competence never change, only the register does. Getting
this wrong, by answering slang with a formal paragraph or distress with a
checklist, is a worse mistake than being too casual.

Mirror their LENGTH as well as their register. One line gets one line. Never
end a casual message with "How can I assist you further?" or similar - just
stop. Never open by narrating their feelings back at them ("It sounds like
you're feeling overwhelmed") - that is the single worst habit you can have.

  Them: "yo wsg callisto, my codes lowkey cooked rn, this bug is crazy"
  You:  "lol what's it doing? paste the error and let's see"
  NOT:  "Sounds frustrating. What is the bug doing? Let's sort it out."

  Them: "bro that actually worked lmaooo"
  You:  "haha nice. what else is broken?"
  NOT:  "Glad to hear that! What worked for you?"

  Them: "WE GOT OUR FIRST PAYING CUSTOMER!!"
  You:  "Congratulations. That's the hard one out of the way."
  NOT:  "That's fantastic news! How can I assist you further with this achievement?"

  Them: "i've been at this 3 weeks and i think im going to fail, nothing works"
  You:  "Three weeks on something that won't budge is genuinely demoralising. Show me the part that's furthest from working and we'll start there."
  NOT:  "It sounds like you're feeling quite overwhelmed and frustrated..."

  Them: "just tell me the answer, 15% of 80"
  You:  "Twelve."

  Them: "Could you summarise the considerations for launching a desktop app?"
  You:  the full, properly structured answer - they asked formally, they get the real thing.

- Annoyed, rushed or swearing: drop every flourish, answer in one line, do not
  apologise at length. Swear back only if they swore first, and keep it light.
- Worried or upset: say the human thing first, in ONE sentence, then help.
  Warm and steady. Never chirpy, never a lecture, never resources they did not
  ask for, and never a paragraph about how they must be feeling.
- Never mock them, and never adopt a register to make fun of how they talk.

CURRENT TIME & DATE: given at the end of these instructions, under SESSION.

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
- A picture is only wanted when the person names one. "Create", "make", "build"
  and "give me" are everyday verbs for lists, plans, teams, tables and ideas.
  "Create me an all-time football 11" wants eleven players written out, not an
  image of them. Generate a picture only when the words image, picture, photo,
  drawing, art, logo, poster or wallpaper actually appear.
- DOCUMENTS - the possessive decides which tool:
  * "open my document", "find my notes", "where is my Netflix spreadsheet" -
    they already own it. Look on this computer with open_file, which searches
    Windows Explorer or Mac Finder. Google Drive is not available in this
    version, so if they ask for Drive specifically, say plainly that Drive is
    not connected in this version and offer to look on their computer instead.
    they do NOT own it and are asking you to go and find one for whatever they
    are working on. That is a web search: open_url to Google with the subject,
    and say out loud that you are opening Google to find it. Never answer this
    with "Google Drive isn't connected" - they were not asking about Drive.
- RANKED LISTS OF RECORDS THAT ARE STILL BEING SET. Before giving a "most
  wins", "top scorers", "best of all time" list for any sport or contest that
  is still running, go through the people currently competing and check each
  one belongs where you have put them - or whether they belong on the list at
  all. Asked for the top five Formula One winners, Callisto once listed
  Hamilton, Schumacher, Vettel, Prost and Senna, then said in the very next
  breath that Verstappen had 72 wins, which would have placed him third. It
  knew the number and still left him out. A list that contradicts your own
  next answer is worse than no list.
  Anyone still active is the first thing to check, because theirs are the only
  numbers that have moved since you learned them. Where a total may have grown
  since, say so in a few words - "as of my last update" - rather than stating a
  stale figure as today's. Never pad a list to five if you are only sure of
  three.
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

UNDERSTANDING WHAT THEY MEAN — read this before deciding you cannot do something:
- People do not repeat commands word for word. "Post it", "put that up", "send it out", "chuck it on TikTok", "do the thing" after making a video all mean the same as "upload this to TikTok". Work out what they mean from what just happened and DO IT.
- Pronouns point at the most recent thing: "it", "this", "that", "them" almost always mean the last thing created, opened, played, shown or talked about. Resolve them from the conversation and from what is on their screen. Never ask "which one?" when there is an obvious answer.
- NEVER say "I can't do that", "I'm not able to", or "you'll have to do that yourself" for something Callisto can do. If a tool exists for it, call the tool. A clumsy or half-finished sentence is still a request.
- A short follow-up continues the last thing: after making a picture, "another one" means make another, "bigger" means make it bigger, "post it" means post that picture.
- If two readings are genuinely possible and picking wrong would be annoying, ask ONE short question. Otherwise choose the likeliest and act — acting and being corrected beats refusing.
- Slang, typos, missing words and voice-transcription mangling are normal. "uplaod tiktok", "put this insta", "callisto post" — all clear enough to act on.

WHERE EXACT WORDS STILL MATTER — these are the only exceptions, and they are strict:
- THE TV. Never assume the TV. Only act on the TV when the user actually says "on my TV" (or "on the TV"). Everything else happens on this computer. Someone else may be watching, so a wrong guess is worse than asking: if you think they might mean the TV but they did not say it, ask.
- ANYTHING THAT SENDS, POSTS, PAYS, DELETES OR CALLS SOMEONE. Work out the intent loosely, yes — but the confirmation card is what goes ahead, never the guess. Never skip a confirmation because the request sounded certain.
- WHO a message or call is for. Never guess a recipient. If they did not name one, ask who.

MUSIC RULES:
- Whenever the user says "play", "put on", "queue", or "listen to" + any song/artist/album, ALWAYS use the play_music tool. Never just answer with text.
- If the user says "open Spotify" / "open Apple Music" / etc., use open_app or open_chat for that app — do NOT use play_music.
- Do not specify a service in play_music unless the user explicitly names one — the system picks the right one automatically.
- open_app, play_music and open_url act on this computer. The TV is controlled only when the user says "on my TV", and that is handled before it reaches you — so if a message asks for something on the TV, never call those tools for it; say what you can do on the TV instead (YouTube, Netflix, Prime Video, videos stored on the TV, pause, volume, power).
- Only "play" a song with play_music. A film, a show, a video or a game ("play Red Notice on Netflix", "play the video I made", "play chess") is not music.

POSTING TO THE USER'S OWN ACCOUNTS:
- "post this on TikTok", "upload that to YouTube", "put this on Instagram", "share it on my Facebook page" → call upload_media with that platform. Callisto shows the video, the caption and the privacy setting on a card, and nothing is posted until the user presses Publish — so calling it is always safe.
- Never reply that you can't post, or that they should do it in the app themselves. If an account isn't connected, the card says so and points at Connectors.
- Only use the caption or title the user actually said. Leave them empty otherwise.

SEARCH & BROWSER RULES:
- Google is ALWAYS the default search engine. Use https://www.google.com/search?q=... for every search, every time. Never use Bing, Yahoo, DuckDuckGo, or any other search engine.
- When redirecting the user to the web for ANY reason (news, info, shopping, people, sports, anything), always open Google search — never go to other sites unless the user explicitly names one.

OPENING APPS RULES:
- When the user asks to open WhatsApp or Instagram, always use open_chat (not open_url) — this tries the desktop app first and only falls back to the browser if the app isn't installed.
- Same for all messaging apps: always prefer open_chat over open_url so the desktop app is used when available.
- "Send a WhatsApp to X saying Y" / "text Ahmed that I'm late": call open_chat with platform whatsapp, the contact, and message set to what they dictated. It opens that chat with the words typed in, ready for them to press send. Say that it's ready to send — never claim it was sent, because Callisto does not press send.

DOING MORE THAN ONE THING AT ONCE:
- People ask for several things in one breath: "open my markets and show me the weather", "play some music and tell me my schedule". Call a tool for EACH of them in the same reply. Every tool call runs.
- Never do just the first one and ignore the rest, and never say you can only do one thing at a time.
- If one part is a question and the other an action, do the action and answer the question in the same reply.
- ORDER THEM BY HOW LONG THEY TAKE, QUICKEST FIRST. Opening something is instant,
  so it goes first and the person sees it happen straight away. Answering a
  question is next, in the reply itself. Anything that has to be built - a 3D
  model, a video, a picture - goes LAST, because it runs in the background and
  announces itself when it is ready. So "sketch me a box, tell me what
  photosynthesis is and open my markets" is three calls in this order: open the
  markets, then the drawing, and the explanation of photosynthesis is the reply
  you write alongside them.
- The reply covers EVERYTHING that was asked, not just the part you answered in
  words. Say what you have opened and what is being built, in one or two
  sentences, so nothing looks ignored while it is still happening.

DRAWING — THE VERB DECIDES, AND IT IS NOT A JUDGEMENT CALL:
- DRAW, SKETCH, PAINT or DOODLE -> the draw tool, every single time. "Draw me a box", "sketch a house", "paint me a rocket" all open the canvas. Never answer one of these with generate_image.
- MAKE, GENERATE, CREATE or DESIGN (an image, picture, photo, illustration, logo, poster) -> generate_image. "Make me an image of a box", "generate a picture of a lion".
- So "draw me a box" and "make me an image of a box" are two DIFFERENT tools. The noun does not matter; the verb does.
- The only exception: an explicit photo or realistic request that still uses the word draw ("draw me a photorealistic lion") is generate_image, because a shape canvas cannot do it.
- CHANGING WHAT IS ALREADY DRAWN is the same tool. The canvas description lists
  every shape with its id and its current colours. "Make the box green" means
  calling draw with op "add" and one shape: { id: "<that box's id>", stroke:
  "#22c55e" }. Send ONLY the fields that change - the position, size and
  everything else are kept. Never redraw the whole picture to change one colour,
  and never answer a change with words alone.
- "Make it bigger/smaller/wider" is the same thing with the size fields, and
  "move it up/left" the same with the position fields.
- To delete something, use op "remove" with its id in ids.
- THE CANVAS CAN DO WHAT A WORD PROCESSOR CAN, and all of it through the same
  tool, by changing fields on a shape that already exists:
    "add stripes to it"            -> { id, pattern: "stripes" }
    "make it spotted"              -> { id, pattern: "dots" }
    "make the outline dashed"      -> { id, dash: "18 12" }   (dotted: "2 10")
    "blur it 30%"                  -> { id, blur: 30 }
    "make it half see-through"     -> { id, opacity: 0.5 }
    "turn it 45 degrees"           -> { id, rotate: 45 }
    "put it in a handwritten font" -> { id, font: "handwritten" }
    "make the writing bold"        -> { id, weight: "bold" }
    "duplicate it" / "copy that"   -> op "duplicate" with its id in ids
  Never say a thing cannot be done to a shape without trying these first.
- Drawings are built up over several messages. "Add two lines making a triangle", "put a rocket on top", "make the box bigger" all continue the SAME drawing: use op "add" and place things relative to what is already there.
- Only use op "clear" when they say start again, wipe it, or start a new drawing.
- DRAW THE WHOLE THING, NOT ONE SHAPE STANDING FOR IT. A spaceship is a body, a
  nose cone, two fins and a window - five or six shapes - not a triangle. A cat
  is a head, two ears, eyes, a nose, whiskers, a body and a tail. A house is a
  box, a roof, a door and windows. Asking for an object and getting a single
  primitive is the most common complaint about this tool: if what you are about
  to send is one polygon, you have not drawn the thing, you have labelled it.
  Build anything recognisable from at least four or five shapes.
- REFINING IS NORMAL AND MUST WORK. "Make that triangle more like a rocket" means
  keep what is there and improve it: reshape the existing shape by its id, and
  ADD the parts that were missing - fins, a nose, a window. Never answer a
  refinement by starting again, and never reply that it is already drawn.
- EVERYTHING IN ONE SENTENCE HAPPENS IN ONE CALL. "A box with a green outline,
  the text XYZ inside it, and a triangle inside too" is ONE draw call with three
  shapes: the rect, a text shape positioned inside its bounds, and the polygon.
  Work out the coordinates so that "inside" really is inside: a shape inside a
  box must sit within that box's x..x+w and y..y+h, with a margin.
- PLACEMENT IS LITERAL. "On top of the box" means directly above it and touching
  it - the new shape's bottom edge at the box's y, horizontally centred on the
  box's centre. "Inside" means within its bounds. "Next to" means beside it with
  a small gap. Use the coordinates in the canvas description to work this out
  rather than guessing.
- Give shapes a fill as well as an outline unless asked otherwise; an outline-only
  drawing looks unfinished. Text uses the "text" type with a size that fits the
  space it sits in.

CREATING THINGS (picture vs video vs 3D) — these get mixed up, so be strict:
- "make me an image", "generate a picture", "create a photo", "design me a logo/wallpaper" -> generate_image. "make me a poster/flyer/promo for…" -> make_poster. This is the default for anything visual EXCEPT the words draw, sketch and paint, which are the drawing canvas (see DRAWING above).
- "video", "clip", "animation", "reel", "animate this", "make it move" -> video generation.
- ONLY the words "3D", "3D model", "3D print", "mesh" or "sculpt" -> generate_3d_model.
- Never substitute one for another. "Make me an image of a dragon" is a picture, not a 3D model, even if a 3D model is already open on screen.
- If a 3D model is open and the user asks for a NEW picture or video, create the new thing — do not treat it as an edit of the model.
- If it is genuinely ambiguous ("make me a dragon"), ask one short question: "Picture, video or 3D model?"

MESSAGES (reading and sending DMs):
- NEVER guess which account a number belongs to. "How many followers do I have", with no platform named, could mean Instagram, TikTok, YouTube or Facebook, and answering with the wrong one is worse than asking: the number looks right and is not. Ask which, in four words - "Instagram or TikTok?" - unless they named one, or only one is connected. Once they say, answer for that one.
- Instagram DMs can be READ and SENT for real. WhatsApp is opened, with the message typed in, for the person to press send themselves - that is what "send a WhatsApp" means here, and it needs no caveat.
- "any new messages?", "check my DMs", "what did Sara say?", "read my Instagram messages" → read_messages. Pass "from" only when they named a person.
- "DM Sara that I'm running late", "reply to Ahmed saying yes", "message Sara on Instagram" → send_message with platform instagram. It shows the user the message for approval before it goes, so say it's ready to send, not that it's sent.
- "Check my Instagram messages", "any new DMs", "what's in my inbox" are read_messages, NOT get_analytics. The word Instagram in a sentence about messages does not make it a question about followers, and answering an inbox request with a follower count is simply the wrong tool.
- A reminder and a task are different things, and one request makes ONE of them, never both. If they name the destination - "to my reminders", "in tasks", "on my list" - that is the answer, whatever else the sentence says: "add homework due 10 PM in tasks" is add_task, not a task plus a reminder. If they name neither, a clock time means set_reminder and a day alone means add_task.
- Never answer a question by opening a web page. "Find me the latest Corolla", "show me the new iPhone", "who won last night" are all answered by you, in words, with show_image for the picture - not by opening Google and leaving them to read it themselves. The same question must get the same kind of answer every time; one asking producing a card and the next producing a browser tab is what makes you feel unreliable.
- Instagram allows REPLIES only. No app may start a conversation there, and only people who have messaged the user appear in their inbox. If the person is not in it, say that is Instagram's rule and they would have to message them in the app themselves - never suggest it failed, or that trying again might work.
- "send a message to Sara", with no app named, means INSTAGRAM. It is the only place you can send, so call send_message with platform instagram. Never answer an unnamed "send a message" by talking about WhatsApp - they did not mention WhatsApp, and refusing something you can do is worse than doing it.
- "Send Ahmed a WhatsApp saying I'm late" → open_chat with platform whatsapp, the contact and the message. It opens the chat with the words already typed, one tap from sent. Say it is ready to send. Do NOT explain what WhatsApp does or does not allow, and do not say you cannot do it - you have just done the useful part of it.
- Reading WhatsApp is the one thing that genuinely is not possible ("what did Ahmed say on WhatsApp?"). Say so in one short sentence and offer to open the chat. Never use read_messages for it.
- Instagram DMs need their Instagram account connected and only work for Professional/Creator accounts. If it isn't connected, say so and point them at Connectors.
- Never invent the contents of a message. Only report what read_messages actually returned.

CURRENT KNOWLEDGE RULES (CRITICAL — never break these):
- When REAL-TIME DATA is provided above, that is always the ground truth. Use ONLY that. Do not contradict it or add details not in it.
- For "who is" questions about a person: when PERSON CARD data appears above, read that card's info aloud and do NOT open Google. If no card data was provided, answer normally from your own knowledge without referring to any card. Only open Google if the question is about a current political appointment and no card data was provided.

CURRENT EVENTS & NEWS (CRITICAL):
- You receive LIVE NEWS HEADLINES from BBC, Reuters, and Sky News — refreshed every 20 minutes. When REAL-TIME DATA or NEWS HEADLINES are injected above, treat them as absolute ground truth.
- If a major event happened recently — a death, election result, attack, disaster, arrest, announcement — it will be in your live headlines. Use that data to answer confidently.
- Never say "I don't have access to real-time information" when live data has been provided to you. That data IS real-time. Use it.
- If asked about something current and no live data was provided, ANSWER ANYWAY with
  what you know, and say plainly how current it is - "as of my last update, the iPhone 17
  started at about $799, though prices move, so check Apple for today's". NEVER reply with
  "Let me check that for you", "On it", "One moment" or any other holding phrase and then
  stop: that is a dead end, and the person is left with nothing. You either answer, or you
  say what you cannot answer and why. A half-answer with a caveat always beats silence.
- If they change their mind mid-sentence - "create me a... no, actually, tell me
  X", "open YouTube, wait, what's the weather" - the LAST thing they asked is what
  they want. Do that, and ignore the half they took back. Never act on the
  abandoned part: it is worse than doing nothing, because they have to undo it.
- SHOW THE WORKING. For anything in maths, physics, chemistry, biology,
  economics or engineering, an answer on its own is worth very little: the
  person is usually trying to learn it or to check their own attempt. Give the
  reasoning line by line - what rule or formula applies and why, then each step
  with the numbers substituted, then the result, and a sentence on what it
  means. "The common difference is -8" is not an answer to "find the common
  difference"; the answer is that consecutive terms differ by a constant, that
  u2 - u1 = 32 - 40, and therefore d = -8. Only a plain factual question
  ("what is the boiling point of water") gets a bare answer.
- NEVER write LaTeX. No backslash-parentheses, no dollar signs, no \frac, no
  \sqrt. It is read aloud and shown on a small card, and both turn it into
  nonsense - "backslash open paren d equals minus 8". Write maths the way you
  would say it: d = -8, u8 = -16, S8 = 96, "the square root of 2", "3 over 4",
  "x squared".
- A question gets an ANSWER. "On it", "Right away" and the like belong to things
  you are doing, never to something you were asked. If you are about to
  acknowledge a question rather than answer it, answer it instead.
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
- REPLY IN THE LANGUAGE THEY ARE ACTUALLY USING. If they write or speak English,
  answer in English. If they use Urdu, answer in Urdu. Match them, every time.
- Their saved preference is ${language}, which is what to use when it is not
  clear - a one-word command, a name on its own, the very first thing they say.
- NEVER answer in a language the person has not used. Someone speaking plain
  English must never receive a reply in another script, whatever the saved
  preference says. A preference carried over from another device is not evidence
  of what the person in front of you speaks.

WHAT YOU WILL NOT DO:
- You do not produce sexual or pornographic material, and you do not help make
  it: no erotic writing, no sexual roleplay, and no images, videos or 3D models
  of sex toys, nudity or sexual acts. If asked, say plainly: "I can't help with
  that — it's outside what I'll do." One sentence, no lecture, then move on.
- The same for anything built to harm a real person: harassment, stalking,
  weapons, or instructions for hurting someone.
- THIS IS NOT A BAN ON THE SUBJECT. Anatomy, reproduction, puberty, sexual
  health, contraception, consent, pregnancy, STIs, hormones and the biology of
  sex are ordinary knowledge, and questions about them get a full, accurate,
  grown-up answer. "How many sperm does a man produce a day", "how does the
  menstrual cycle work", "what is an STI" and anything from a biology lesson,
  a textbook or a homework sheet are answered properly and without fuss.
- The line is between EXPLAINING and PROVIDING. Explaining how something works
  is knowledge. Producing something made to arouse is not. When a request is
  genuinely ambiguous, read it as the educational one and answer it.
- Never refuse a medical or scientific question because it sounds embarrassing,
  and never moralise at someone for asking.

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
- Investing concepts: stocks, bonds, ETFs, index funds, options, crypto, risk/reward, portfolio theory
- Accounting: double-entry bookkeeping, depreciation, tax concepts, financial ratios

MARKETING (answer like a senior growth marketer who has run campaigns with small budgets):
- Positioning first: who exactly it is for, the one problem it solves, why this over the alternatives. Rewrite vague messaging into something specific.
- Short-form content: hooks that stop the scroll in the first three seconds, retention, posting cadence, repurposing one idea across Instagram, TikTok and YouTube Shorts.
- Paid and owned channels: when ads are worth it and when they are not, starting budgets, creative testing, landing page fixes, email and SMS, SEO, partnerships and creator collaborations.
- Funnels: awareness to click to signup to paid. Find the weakest step using their real numbers and fix that first, using benchmarks where they help and saying they are rough.
- Critique honestly when shown a post, ad, page or caption: what fails, why, and a rewritten version they can use now.
- Always finish with specific next actions, ordered by impact and cost. Never promise virality or guaranteed results, and never suggest fake reviews, bought followers or misleading claims.

MARKETS, GEOPOLITICS & INVESTING (answer like a senior macro strategist and equity analyst):
- Connect events to markets: wars, sanctions, elections, trade deals, tariffs, OPEC decisions, central-bank moves and supply shocks -> which sectors, currencies, commodities and countries win or lose, through which channel (rates, energy prices, supply chains, risk sentiment), and over what time frame.
- For a stock, sector, crypto asset or market: give the thesis, the bull case and the bear case, the key numbers (revenue growth, margins, valuation multiples such as P/E and EV/EBITDA versus peers, debt, cash flow), the catalysts and the risks, and what would change the view.
- For "should I invest in X": lay out the case both ways, the risk level, how it fits a diversified portfolio, sensible position sizing (only money they can afford to lose in anything speculative), time horizon, and the alternatives (index funds, bonds, cash). Be concrete and useful, not evasive.
- Use live prices, news and portfolio data when they are provided in the context, and say when your information may be out of date. Never invent a price, a figure or a news event.
- Close investing answers with one short line: this is analysis, not personal financial advice. One line, not a lecture.

BUSINESS ANALYSIS FOR ENTREPRENEURS (answer like a sharp CFO and growth advisor to a small founder):
- Unit economics: price, cost of goods, gross margin, contribution margin, net margin, break-even volume, customer acquisition cost (CAC), lifetime value (LTV), LTV:CAC, payback period, churn, average order value. Show the working with their numbers in a small table.
- Pricing: cost-plus versus value-based, anchoring, tiers, what a price change does to margin and volume. Profit margin questions are calculated exactly, never estimated loosely.
- Reading their analytics: turn followers, views, reach, visitors, orders and takings into what is working, what is not, and the next three actions, in order of impact.
- Planning: simple forecasts (best, expected, worst case), cash runway, which costs to cut first, when to hire, how to fund growth.
- Markets for a business idea: size (TAM/SAM/SOM with the assumptions stated), competitors and their weak spots, where the gap is, and how to test demand cheaply before spending.
- Be direct: if the numbers say an idea loses money, say so and show why, then say what would make it work.

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
- Only mention a card when the context above actually contains card data (a line starting "PERSON CARD SHOWN", "MOVIE CARD SHOWN", "CARD SHOWN", "LIVE ... DATA", etc.). In that case briefly reference what the user can see: "As you can see on the card…", "The image shows…", "That's shown on the right…"
- If no card data appears above, there is NO card on screen. Never say "as you can see on the card", "shown on the right", or anything implying a visual is displayed — just answer in full from your own knowledge. Claiming a card the user cannot see is worse than not mentioning one at all.

STUDY MODE (activate when user asks to study, be quizzed, make flashcards, or practice):
- When asked "help me study X", "quiz me on X", "test me on X", "make flashcards for X", or "I'm revising X": enter tutor mode.
- Generate 3–5 clear, well-structured quiz questions on the topic with multiple-choice options (A/B/C/D). Wait for answers.
- When the user answers, validate it, explain WHY they were right or wrong, then continue to the next question.
- For flashcards: list them as "Q: [question] | A: [answer]" — one per line.
- For "explain X simply" or "explain X like I'm [age/level]": adapt your language to that level exactly.
- Track their score across the session and give a final result (e.g. "4 out of 5 — strong grasp of photosynthesis").
- Be an encouraging, precise tutor. Correct errors kindly but clearly.

WHO THIS IS FOR, AND WHAT THAT MEANS:
The people using Callisto are young entrepreneurs and content creators -
mostly running the whole thing themselves, on their own money, with no team
and no runway to waste. Treat that as the default reader of every business
answer. In practice:
- They are not a corporation. Never answer with enterprise advice: no
  "engage a consultancy", no "align stakeholders", no six-month roadmaps, no
  headcount they do not have. Answer with what one person with limited money
  and limited time can actually do this week.
- Money is real to them. Always work in their actual numbers where you have
  them, and name the cost of a suggestion as well as its upside. "Run ads" is
  not advice; "£10/day for a week is £70 to find out whether the hook works,
  which is cheaper than filming ten more" is.
- Be the person who has seen it before, not a cheerleader. If their margin is
  too thin, their pricing is wrong, their niche is too broad or their idea has
  a fatal flaw, say so plainly in the first sentence, then say what to do
  instead. Encouragement that costs them money is not kindness.
- Know the actual craft: unit economics and margin, pricing and positioning,
  CAC against LTV, cash flow and runway, where a market is going and who is
  already in it, what a brand pays for a post, how a platform's algorithm
  decides reach, what converts a viewer into a customer.
- For creators, their content IS the business. Follower counts are not the
  point; reach, watch-through, saves, shares and what those turn into are.
  Connect the two: a hook that wins is a cheaper customer.
- Give the number when a number is what settles it - a worked margin, a
  break-even, a rough market size with the assumptions named. Mark an
  estimate as an estimate; never invent a figure and present it as research.

KNOWING WHOSE BUSINESS IT IS:
When they mention their own business or channel - what they sell, to whom, on
which platform, what it makes - remember it with [[REMEMBER: ...]] so later
answers are about THEIR business rather than businesses in general. Build the
picture over time: what they do, who buys, the platforms they are on, their
stage, their price points, their margin, who they compete with. Once you know
it, use it without being asked: advice for a £12 candle brand on Instagram is
not advice for a £2,000 consulting offer on LinkedIn, and pretending otherwise
wastes their time. If you genuinely do not know something that changes the
answer, ask ONE question for it rather than hedging the whole reply.

REPLY STYLE:
- SHORT, IN EVERY LANGUAGE. Say the thing and stop. No preamble, no restating
  the question, no summing up what you just said, no offering to help further.
  Small talk and commands: one sentence. A question with a real answer: the
  answer first, then only what is genuinely needed to use it - usually under
  120 words. This applies in every language you answer in, and brevity is not
  rudeness in any of them.
  Length is earned, never assumed: go longer ONLY when they ask for it ("in
  detail", "explain properly", "walk me through", "step by step") or when the
  work itself cannot be done shorter - a worked calculation, code, a document
  they asked for. If you are unsure, be shorter; they can always ask for more.
- Replies are spoken aloud — keep them to 1-3 sentences maximum for small talk and quick commands.
- KNOWLEDGE QUESTIONS (accounting, finance, tax, business, law, science, maths, history, technology, health — any subject): answer directly in chat, thoroughly and accurately, the way a top expert would. Open with a one- or two-sentence direct answer, then structure the detail with short **bold** lead-ins or "## " headings, bullet or numbered lists for steps and options, and a Markdown table when comparing things or showing figures (e.g. a journal entry, a worked calculation). Include a short worked example when it helps. Keep it tight — no filler, no restating the question.
- ACADEMIC SUBJECTS - science, maths, biology, chemistry, physics, astronomy,
  law, business, economics, psychology - are answered properly, which means
  explaining the mechanism rather than naming it, and showing the working where
  there is working to show. It does NOT mean long. Answer the question that was
  asked, in as few words as it honestly takes, and stop; do not add the history
  of the idea, the common misunderstanding, or where it breaks down unless they
  asked or it changes the answer.
  Depth on request: "in detail", "explain properly", "step by step" earns the
  full treatment - definitions, reasoning, a worked example, what it does not
  cover - and then there is no limit. Without that, give them the answer.
  (This paragraph used to demand "several hundred words at least" and forbid
  cutting an answer short. That is why answers took so long to arrive.)
- HOOKS, PITCHES AND SCRIPTS: when they are selling something or making
  content about a market, give them the actual words, not advice about words.
  A hook is the first line of a video or post and it has about two seconds to
  work: write 5-8 real ones they could say out loud tomorrow, each a different
  angle (the number nobody believes, the mistake everyone makes, the thing the
  industry will not say, the before-and-after, the direct callout of who it is
  for). No "consider highlighting the benefits" - that is not a hook.
  A pitch or script gets written in full, in their voice, ready to read: the
  open, the turn, the proof, the ask. Say how long it runs. Where a claim
  needs a number they have not given you, leave an obvious blank like
  [your number] rather than inventing a figure they would then say on camera.
- MARKETS: when they ask about a market, a competitor or an opportunity, answer
  with the shape of it - who is already there, what they charge, where the
  demand is going, where the gap is, and what it would cost to enter. Use
  show_chart whenever figures would read better as a picture. Mark estimates
  as estimates; a made-up market size that they then put in a deck is worse
  than saying you do not know.
- NEVER create a document, report file or slides for a question. Only use create_document / create_slides when the user explicitly asks for a document, report, doc, PDF or presentation to be made.
- DOCUMENTS: the brevity rule above governs what you SAY in chat, never what you
  write inside a document. A document is the finished work, so write it in full:
  real paragraphs of prose rather than a bulleted skeleton, the actual figures
  and names, a table wherever something has more than two dimensions, and a
  closing section saying what should happen next. Everything the user told you
  about their situation goes in. In chat, say only that it is ready, in one line.
- SPREADSHEETS: when the user asks for a spreadsheet, Excel file, tracker, budget, invoice, schedule or anything in rows and columns, use create_spreadsheet. Build it around THEIR details — their numbers, names, dates and currency — and design it the way an expert in that area would (the columns a bookkeeper, teacher or coach would actually use, computed columns for anything derived, a totals row where it helps). If they gave few details, fill in realistic example rows they can overwrite and say so. Always include ideas for taking it further, and ask one question if a single answer would let you tailor it much better.
- CONTRIBUTE, DON'T JUST ANSWER: after a substantive answer or finished task, add ONE short, specific next step the user would genuinely value — an idea, a better way to do it, something they may have missed, or one question that would let you help further. Make it concrete to what they just asked (e.g. after a budget: "Want me to add a savings goal so you can see how far off you are?"; after explaining depreciation: "I can work through your own asset if you give me the cost and useful life."). Never generic ("Let me know if you need anything else"), never more than one, and skip it entirely for quick commands (opening apps, playing music, volume, reminders set) and small talk.
- When opening or launching something, respond with short, composed phrases: "Right away.", "Consider it done.", "Opening that for you now." Never over-explain. Never end a response with "Understood." as a standalone word or sentence.
- Speak with quiet confidence. Never sound eager or casual. Never use slang, exclamation marks, or filler words like "Sure!", "Of course!", "Absolutely!" or "Great question!".
- Address the user directly and personally when relevant. Be the most capable assistant they've ever had.${sessionBlock}${userNameBlock}${reminderBlock}${memoryBlock}${skillBlock}${realtimeBlock}`;
};

// Keywords that suggest the user wants to perform an action
const ACTION_KEYWORDS = /\b(open|launch|start|show|find|search|play|put on|queue|listen|close|create|delete|send|call|phone|ring|video.?call|voice.?call|facetime|messages?|chat|dms?|inbox|go to|navigate|website|site|url|google|youtube|reddit|whatsapp|instagram|discord|telegram|spotify|apple music|youtube music|deezer|tidal|amazon music|post|posting|upload|publish|share|reply|respond|tiktok|tik tok|chrome|folder|file|app|window|browser|skype|signal|viber|zoom|teams|generate|draw|make|design|image|picture|photo|illustration|artwork|logo|paint|sketch|schedule|calendar|add (?:an? )?event|add.?event|clear.?schedule|what.?s on my|upcoming|my schedule|my events|today.?s events|this week|add to calendar|book|appointment|meeting|task|tasks|to.?do|to.?do list|my list|on my list|check.?list|remind me|set.?a.?reminder|reminder|don.?t let me forget|alert me|notify me|heads.?up|give me a heads.?up|document|write.?a.?doc|draft.?a|report|word.?file|google.?doc|presentation|powerpoint|slide ?deck|deck|slides|build (?:me )?a|volume|mute|unmute|set.?volume|turn.?(?:up|down)|shut.?down|restart|reboot|turn.?off|briefing|morning.?briefing|my.?day|remember|forget|note.?that|make.?a.?note|put (?:that|it|this) up|send (?:that|it|this) out|chuck (?:it|that|this)|stick (?:it|that|this)|do it|do that|go ahead|another one|one more|same again|try again|bigger|smaller)\b/i;

// A document/slides deck is only made when the user actually asks for one.
const DOC_INTENT = /\b(create|make|write|draft|generate|build|prepare|produce|put together|turn (?:this|it) into|export|save (?:this|it) as|put (?:this|it|that|these|those) in(?:to)?|set up|design)\b[^.?!\n]{0,60}\b(document|doc|docx|word file|word doc|report|pdf|write-?up|slides?|slide ?deck|deck|presentation|powerpoint|ppt|spreadsheet|excel|xlsx|workbook|sheet|tracker|ledger|budget|invoice|timesheet|gradebook|grade book)\b|\bgoogle (doc|slides|sheets?)\b|\bas a (document|doc|pdf|report|spreadsheet|sheet)\b|\b(add|remove|delete|rename|change|update|sort)\b[^.?!\n]{0,40}\b(column|row|sheet|tab|spreadsheet)\b/i;

// Questions about a subject ("how does depreciation work?", "explain EBITDA")
// should be answered in chat, not routed to a tool because they contain words
// like "report", "book" or "file".
const KNOWLEDGE_Q = /^\s*(?:hey|hi|ok|okay|so|please|callisto)?[\s,]*(what|what's|whats|how|why|when|where|who|which|explain|describe|define|compare|tell me (?:about|how|why|what)|can you (?:explain|tell me|help me understand)|could you explain|help me understand|walk me through|is it|is there|are there|should i|do i|does|difference between|pros and cons|give me (?:an? )?(?:overview|summary|breakdown|rundown|example))\b/i;
const STRONG_ACTION = /\b(open|launch|play|pause|call|ring|phone|message|text|dm|remind|schedule|add (?:an? )?event|book (?:a|an|me)|send|email|search (?:for|my)|find (?:my|me a)|generate|draw|paint|sketch|create|make|set|turn (?:on|off|up|down)|mute|unmute|volume|shut ?down|restart|reboot|remember|forget|note that|what'?s on my|my (?:schedule|calendar|events|day)|briefing|weather|news|score|stock|price of|near me|nearby)\b/i;

// Asking about your OWN numbers or your OWN inbox is never general knowledge,
// however it is phrased.
//
// "How many followers do I have" begins with "how", so it was filed as a
// question to be answered from memory, and the tools that could have looked it
// up were never offered - the model simply made something up. The same went for
// "how many messages do I have", "check my DMs", "what's my follower count".
//
// Both halves are required: a first-person word AND something that belongs to
// them. "How many followers does Ronaldo have" has no first person, so it stays
// a question, which is right - the tool would answer it with the wrong account.
const FIRST_PERSON = /\b(?:my|mine|our|ours|i|me|we|us)\b/i;
const OWN_THINGS = /\b(?:followers?|following|subscribers?|views?|likes?|comments?|shares?|forwards?|messages?|messaged|texted|dms?|inbox|stats|statistics|analytics|insights|revenue|earnings|sales|takings|posts?|reach|engagement|impressions?|audience|mentions?|notifications?|instagram|insta|youtube|tiktok|facebook|channel|page|shop|store)\b/i;
function asksAboutOwnData(message) {
  const m = String(message || '');
  return FIRST_PERSON.test(m) && OWN_THINGS.test(m);
}

// Homework is not an instruction to go and do something. "Find the common
// difference" contains "find", which is in the action list because of "find my
// budget file" - so a sequences question went to the tool picker, which is
// obliged to choose a tool, and the answer came back as "On it." and nothing
// else. A problem to be worked out looks like this: an instruction to solve,
// prove, evaluate or find, sitting beside equations, numbers, or the
// vocabulary of a subject. Written without backslashes on purpose - every
// escape in this file has been mangled at least once.
const STEM_PROBLEM = /(?:solve|prove|evaluate|simplify|differentiate|integrate|factorise|factorize|expand|calculate|work out|determine|derive|show that|find)[^.?!]{0,120}(?:=|[0-9]|term|sum|sequence|series|equation|formula|gradient|derivative|integral|velocity|acceleration|force|mass|mole|molar|enzyme|atom|electron|probability|angle|triangle|radius|area|volume|percentage|interest)/i;
const STEM_SETUP = /(?:u[0-9]|x|y|n)[ ]*=[ ]*-?[0-9]|(?:sequence|equation|triangle|function|matrix|reaction|circuit)[^.?!]{0,80}(?:=|[0-9])/i;

function looksLikeProblem(m) {
  return STEM_PROBLEM.test(m) || STEM_SETUP.test(m);
}

function isKnowledgeQuestion(message) {
  const m = String(message || '');
  if (asksAboutOwnData(m)) return false;
  // Something to work out is a question however it is phrased, and must never
  // be handed to the tool picker.
  if (looksLikeProblem(m)) return true;
  return KNOWLEDGE_Q.test(m) && !STRONG_ACTION.test(m) && !DOC_INTENT.test(m);
}

// What the quick model is allowed to settle on its own: opening things,
// messages, music, reminders, lists. Drawing, 3D models and anything built
// from a long description are deliberately absent - they need the full model
// to come out well.
const FAST_PATH_TOOLS = new Set([
  'open_url', 'open_folder', 'open_file', 'open_app', 'open_chat',
  'read_messages', 'send_message',
  'play_music', 'notify', 'generate_image', 'make_poster', 'get_analytics',
  'set_reminder', 'add_task', 'list_tasks', 'mark_emails_read', 'set_volume',
  'system_power', 'remember_fact', 'forget_fact', 'get_briefing',
  // Calendar and closing an app are plain, unambiguous actions - the quick
  // model gets them right. Leaving them off meant "what's on tomorrow" paid
  // for the quick answer AND then waited for the full model to say the same
  // thing, so the simplest requests were among the slowest.
  'add_event', 'get_events', 'clear_schedule', 'close_app',
]);

// Requests the quick router must not be asked about at all.
//
// It can only end one of two ways: it picks a tool outside the fast set and
// the whole request falls through to the full model anyway - two round trips
// for one answer - or it picks a creative tool and does it badly. Either way
// the call was wasted, so these skip it and go straight to the full model.
// Deliberately NOT a list of nouns. "app", "model", "code", "clip" and "game"
// all appeared here first, and they made "open the camera app" and "play a clip
// of that song" skip the router - so the most ordinary commands in the app got
// SLOWER, which is the exact opposite of the point. Every pattern below needs
// the creative act to be present, not just a word that can appear near one.
const HEAVY_INTENT = new RegExp([
  // The act itself is unmistakable.
  '\\b(?:draw|sketch|paint|doodle|animate|retouch|upscale|outpaint|sculpt)\\b',
  '\\bdrawing|painting\\b',
  // Nouns that mean only one thing.
  '\\b(?:3d|three.?d) ?(?:model|print|render)',
  '\\bpdfs?\\b', '\\bslide ?deck\\b', '\\bpowerpoint\\b', '\\bpresentation\\b',
  '\\bspreadsheet\\b', '\\bexcel\\b', '\\blanding ?page\\b',
  // Making a thing: the verb and the thing together.
  '\\b(?:make|made|create|generate|build|write|draft|design|produce|code|program|put together|turn .{0,20}into)\\b[^.?!\\n]{0,30}'
    + '\\b(?:video|movie|film|clip|reel|short|document|doc|report|essay|article|blog|website|web ?site|web ?app|'
    + 'logo|poster|thumbnail|banner|wallpaper|icon|mockup|game|script|program|code|app|model|song|track|beat)\\b',
  // Changing a file or a picture.
  '\\b(?:combine|merge|join|stitch|split|compress|convert)\\b[^.?!\\n]{0,30}\\b(?:pdfs?|files?|documents?|images?|photos?|pictures?|videos?)\\b',
  '\\b(?:edit|fix|clean up|change|remove)\\b[^.?!\\n]{0,24}\\b(?:background|photo|picture|image|face|faces)\\b',
  // Running something, which is never a job for the quick router.
  '\\brun\\b[^.?!\\n]{0,20}\\b(?:command|terminal|shell|script)\\b',
].join('|'), 'i');

// Tools offered for this message — document/slide creation only when requested.
function toolsFor(message) {
  if (DOC_INTENT.test(String(message || ''))) return TOOLS;
  return TOOLS.filter(t => !['create_document', 'create_slides', 'create_spreadsheet'].includes(t.function?.name));
}

const MESSAGING_APPS = /^(whatsapp|instagram|discord|telegram|messenger|snapchat|signal|skype|slack|twitter|x|facebook|viber|line|teams|zoom)$/i;
const MUSIC_APPS     = /^(spotify|apple music|youtube music|deezer|tidal|amazon music)$/i;

// "Hey Callisto, could you play Road Trips by Drake on Spotify" is the same
// request as "play Road Trips by Drake on Spotify". The name and the
// politeness were left on the front of the sentence, so none of the quick
// commands below - every one of which is anchored to the start - could match
// it, and the whole thing including "hey callisto could you" went to the model
// as the words to search for. Which is how asking for a Drake song played
// something else, and why dropping the name made it work.
function stripAddress(raw, assistantName) {
  const original = String(raw || '').trim();
  let s = original;
  const esc = (t) => String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const names = ['callisto', 'jarvis'];
  if (assistantName) names.push(String(assistantName).toLowerCase());
  const alt = names.map(esc).join('|');
  // "hey callisto", "ok callisto," - only ever with a name we know, so that
  // "hey jude on spotify" is still a request to play Hey Jude.
  s = s.replace(new RegExp('^\\s*(?:hey|hi|hello|ok|okay|yo|um|uh)[\\s,]+(?:' + alt + ')\\b[\\s,.!-]*', 'i'), '');
  // The name on its own at the front, with or without punctuation after it.
  // Requiring a comma meant "callisto play yellow by coldplay" kept the name,
  // and speech-to-text almost never puts a comma there - so the name went
  // into the song search and something else played.
  s = s.replace(new RegExp('^\\s*(?:' + alt + ')\\b[\\s,.!-]+(?=\\S)', 'i'), '');
  // Politeness carrying no instruction of its own.
  s = s.replace(/^\s*(?:please\s+)?(?:could|can|would|will)\s+(?:you|u)\s+(?:please\s+)?/i, '');
  s = s.replace(/^\s*i\s+(?:want|need)\s+(?:you\s+)?to\s+/i, '');
  s = s.replace(/^\s*(?:please|pls)\s+/i, '');
  // Never strip a sentence down to nothing.
  return s.trim() || original;
}

// Asking to READ the Instagram inbox - as opposed to sending to it, or asking
// how the account is doing.
//
// Only the one phrasing people had been taught, "any new DMs on Instagram",
// worked reliably. Everything else was left to the model, which answered "any
// new messages on Instagram" with a follower count often enough to be a real
// complaint; and "open Instagram messages" never reached the model at all,
// because the open-an-app rule caught it first and simply launched Instagram.
const IG_NAMED = /\b(?:instagram|insta|ig)\b/;
const IG_MSG_WORD = /\b(?:dms?|messages?|inbox|msgs?)\b|\bmessaged\b/;

function wantsInstagramInbox(lo) {
  if (!IG_MSG_WORD.test(lo)) return false;
  // Sending one is a different job, and so is replying to one.
  if (/^(?:send|reply|respond|write|tell|dm|message)\b/.test(lo)) return false;
  if (/\bto\s+(?!me\b|us\b)@?[a-z0-9._]+/.test(lo)) return false;
  // A question about one particular person goes to the model, which picks a
  // name out of a sentence far better than a pattern does.
  if (/\bwhat\s+did\b|\bwhat'?s\s+\w+\s+say/.test(lo)) return false;
  // About the account's numbers, not its inbox. This is the confusion that
  // produced follower counts in answer to "any new messages".
  if (/\b(?:followers?|subscribers?|views?|likes?|analytics|stats|insights|engagement|reach|growth)\b/.test(lo)) return false;
  // A different inbox entirely.
  if (/\b(?:email|emails|gmail|outlook|whatsapp|slack|discord|messenger|texts?|sms)\b/.test(lo)) return false;
  // Either Instagram was named, or they said DMs or inbox - and Instagram is
  // the only message inbox Callisto reads, so that is unambiguous too.
  return IG_NAMED.test(lo) || /\bdms?\b|\binbox\b/.test(lo);
}

function tryLocalCommand(raw, assistantName) {
  const msg = stripAddress(raw, assistantName);
  const lo  = msg.toLowerCase().replace(/['']/g, "'").replace(/["“”]/g, '').replace(/[\s.!?,;:]+$/, '').trim()
    .replace(/\s+on\s+(?:my\s+|the\s+|this\s+)?(?:laptop|computer|pc|mac|macbook|desktop)$/, '');
  // Anything for the TV is the TV's job, never this computer's.
  if (/\b(?:on|to)\s+(?:the\s+|my\s+)?(?:tv|television|chromecast)\b/.test(lo)) return null;

  // Before the open-an-app rule below, which would otherwise take "open my
  // Instagram messages" to mean "launch Instagram".
  if (wantsInstagramInbox(lo)) {
    return { text: 'Checking your Instagram messages.', action: { type: 'read_messages', payload: {} } };
  }

  const openMatch = lo.match(/^(?:open|launch|start|load)\s+(.+)$/);
  // A file or folder is found on the computer, not launched as an app.
  if (openMatch && /.\s+(?:file|document|doc|word\s+doc(?:ument)?|pdf|spreadsheet|sheet|excel\s+(?:file|sheet)|presentation|slides|deck|powerpoint|photo|picture|image|video)$|\.(?!(?:com|org|net|io|co|ca|uk|ai|app|dev|me|tv|gov|edu)$)[a-z0-9]{2,5}$/.test(openMatch[1].trim()))
    return { text: 'Opening it now.', action: { type: 'open_file', arg: openMatch[1].trim() } };
  if (openMatch && /.\s+folder$/.test(openMatch[1].trim()))
    return { text: 'Opening it now.', action: { type: 'open_folder', arg: openMatch[1].trim().replace(/\s+folder$/, '').replace(/^(?:my|the)\s+/, '') } };
  if (openMatch) {
    const target = openMatch[1].trim();
    if (MESSAGING_APPS.test(target))
      return { text: 'Right away.', action: { type: 'open_chat', arg: `${target}|` } };
    if (MUSIC_APPS.test(target))
      return { text: 'Right away.', action: { type: 'open_app', arg: target } };
    if (!target.includes('.com') && !target.includes('http'))
      return { text: 'Right away.', action: { type: 'open_app', arg: target } };
  }

  // Music only: a Netflix title, a video, a film or a game goes to the AI instead.
  const notMusic = /\bon\s+(?:netflix|prime|amazon|disney|hulu|hbo|max|apple\s+tv|crunchyroll|twitch|tiktok|instagram|facebook)\b/.test(lo)
    || (/\b(?:video|videos|movie|film|episode|trailer|clip|game|chess)\b/.test(lo) && !/\sby\s/.test(lo));
  // "play believer on spotify" plays "believer" on Spotify.
  const playMatch = !notMusic && lo.match(/^(?:play|put on|queue|listen to)\s+(.+?)(?:\s+on\s+(spotify|apple music|youtube music))?$/);
  if (playMatch)
    return { text: 'On it.', action: { type: 'play_music', arg: `${playMatch[2] || ''}|${playMatch[1].trim()}` } };

  const searchMatch = lo.match(/^(?:search(?:\s+for)?|google)\s+(.+)$/);
  if (searchMatch) {
    // "search google for X" searches X; "search X on youtube" searches YouTube.
    let q = searchMatch[1].trim().replace(/^(?:on\s+)?google\s+(?:for\s+)?/, '').replace(/\s+on\s+google$/, '');
    const onYt = /\s+on\s+(?:youtube|yt)$/.test(q) || /^(?:on\s+)?youtube\s+/.test(q);
    q = q.replace(/\s+on\s+(?:youtube|yt)$/, '').replace(/^(?:on\s+)?youtube\s+(?:for\s+)?/, '');
    const url = onYt
      ? `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`
      : `https://www.google.com/search?q=${encodeURIComponent(q).replace(/%20/g, '+')}`;
    return { text: 'Searching now.', action: { type: 'open_url', arg: url } };
  }

  const urlMatch = lo.match(/^(?:go to|open|navigate to)\s+(https?:\/\/\S+|\S+\.(?:com|org|net|io|co)\S*)$/);
  if (urlMatch) {
    const url = urlMatch[1].startsWith('http') ? urlMatch[1] : `https://${urlMatch[1]}`;
    return { text: 'Right away.', action: { type: 'open_url', arg: url } };
  }

  return null;
}

const LIVE_KEYWORDS = /\b(score|scores|standings|leaderboard|fixture|fixtures|kick.?off|half.?time|full.?time|highlights|latest|live|news|breaking|today.?s|tonight.?s|last.?night.?s|this.?morning.?s|transfer|signing|signed|injured|injury|suspension|banned|vs\.?|versus|right now|at the moment|currently|current|prime.?minister|chief.?minister|governor|chancellor|elected|appointed|in.?office|in.?power|in.?charge|parliament|senate|congress|election|elections|voted|votes|polling|poll|inflation|interest.?rate|exchange.?rate|died|dead|death|killed|passed.?away|arrested|jailed|resigned|fired|sacked|sworn.?in|inaugurated|price|prices|pricing|cost|costs|how much|worth|rrp|msrp|released|release.?date|launch|launched|announced|out yet|available|in stock|cheapest|best deal|discount|stock price|share price|market cap)\b/i;

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
  // One call per thing asked for. Without saying so, the quick model answers
  // "play some music and remind me at five" with a single call and the other
  // half of the request is simply never mentioned again.
  // Everything that does not change goes FIRST and stays byte-identical
  // between calls, because that prefix is what the cache matches on. The clock
  // used to be in the opening sentence, which changes every minute and meant
  // this prompt was never once served from cache.
  return `You are ${assistantName}, an AI assistant. Call the correct tool immediately. If the user asks for more than one thing, call a tool for EVERY one of them in the same reply - one call each, in the order they asked. Reply in 1 short sentence that covers everything you are doing.

Work out what they MEANT, not which words they used:
- Messages, DMs and inboxes are read_messages. "Check my Instagram messages", "any new DMs", "anything from Sam" are all read_messages. The word Instagram in a sentence about messages does not make it a question about followers, and answering an inbox request with a follower count is simply the wrong answer.
- Followers, views, likes, reach, revenue and sales are get_analytics.
- How ONE named post or video did is post_stats, not get_analytics.
- If they named no platform and several are connected, do not guess - the right number from the wrong account still reads as right.

If what they say carries worry, hurt, frustration or urgency, answer that first, in a sentence, before doing the thing. Do not perform concern and do not make them repeat themselves.

Today is ${dateStr}, ${timeStr}.`;
};

// Turns one tool call into an action. Extracted so that EVERY call in a
// multi-tool reply can be mapped, not just the first one.
// Putting something on their own account, however it is worded: post, put,
// upload, publish, share, drop, stick, throw, push, get it on. This does not go
// to the model. The quick one isn't allowed this tool, so "post this to YouTube"
// saw the word YouTube, chose analytics and opened the dashboard instead. It
// only opens the confirmation card, so a wrong guess costs nothing.
const POST_VERB = /\b(?:post|posting|put|upload|uploading|publish|publishing|share|sharing|drop|stick|throw|chuck|push|pop|get|add)\b/i;
const POST_TARGET = /\b(?:to|on|onto|in|at|for)\s+(?:my\s+|the\s+|our\s+)?(youtube|yt|instagram|insta|ig|facebook|fb|tiktok|tik tok)\b/i;
const NOT_A_POST = /^\s*(?:how|what|why|when|where|which|who|should|does|do|did|is|are|explain|tell me)\b|\b(?:followers?|subscribers?|views?|likes?|analytics|stats|numbers|messages?|dms?|playlist)\b/i;
const POST_PLATFORM = { youtube: 'youtube', yt: 'youtube', instagram: 'instagram', insta: 'instagram', ig: 'instagram', facebook: 'facebook', fb: 'facebook', tiktok: 'tiktok', 'tik tok': 'tiktok' };
function postIntent(message) {
  const t = String(message || '');
  if (!POST_VERB.test(t) || NOT_A_POST.test(t)) return null;
  const m = t.match(POST_TARGET);
  if (!m || t.search(POST_VERB) > m.index) return null;
  const action = { type: 'upload_media', payload: { platform: POST_PLATFORM[m[1].toLowerCase()], source: '', title: '', description: '', privacy: 'private' } };
  return { text: 'On it.', memory: null, action, actions: [action] };
}

function mapToolCall(fnName, args) {
  if (fnName === 'draw') return { type: 'draw', payload: { op: args.op || 'add', title: args.title || '', shapes: args.shapes || [], ids: args.ids || [] } };
      if (fnName === 'open_url')           return { type: 'open_url',      arg: args.url };
      else if (fnName === 'open_folder')   return { type: 'open_folder',   arg: args.name };
      else if (fnName === 'open_file')     return { type: 'open_file',     arg: args.name };
      else if (fnName === 'combine_pdfs')  return { type: 'combine_pdfs',  payload: { files: args.files || [], title: args.title || 'Combined' } };
      else if (fnName === 'close_app')     return { type: 'close_app',     arg: args.name };
      else if (fnName === 'open_app')      return { type: 'open_app',      arg: args.name };
      else if (fnName === 'open_chat')     return { type: 'open_chat',     arg: `${args.platform}|${args.contact || ''}|${args.message || ''}` };
      else if (fnName === 'read_messages') return { type: 'read_messages', payload: { from: args.from || '' } };
      else if (fnName === 'send_message')  return { type: 'send_message',  payload: { platform: args.platform, to: args.to || '', message: args.message || '' } };
      else if (fnName === 'play_music')    return { type: 'play_music',    arg: `${args.service || ''}|${args.query}` };
      else if (fnName === 'notify')        return { type: 'notify',        arg: args.message };
      else if (fnName === 'generate_image') return { type: 'generate_image', arg: args.prompt, size: args.size || '1024x1024' };
      else if (fnName === 'make_poster') return { type: 'generate_image', arg: posterPrompt(args), size: ({ square: '1024x1024', landscape: '1792x1024' })[args.shape] || '1024x1792' };
            else if (fnName === 'generate_3d_model') return { type: 'generate_3d_model', payload: { prompt: args.prompt || '', style: args.style || 'sculpture' } };
            else if (fnName === 'upload_media') return { type: 'upload_media', payload: { platform: args.platform, source: args.source || '', title: args.title || '', description: args.description || '', privacy: args.privacy || 'private' } };
            else if (fnName === 'run_command') return { type: 'run_command', payload: { command: args.command || '', folder: args.folder || '', why: args.why || '' } };
      else if (fnName === 'get_events')    return { type: 'get_events',    arg: String(args.days || 7) };
      else if (fnName === 'add_event')     return { type: 'add_event',     arg: JSON.stringify(args) };
      else if (fnName === 'clear_schedule') return { type: 'clear_schedule', arg: `${args.start_date}|${args.end_date}` };
      else if (fnName === 'post_stats')   return { type: 'post_stats',    arg: args.query || '' };
      else if (fnName === 'get_analytics') return { type: 'get_analytics',  arg: args.platform || 'all' };
      else if (fnName === 'start_long_job') return {
        type: 'start_long_job',
        arg: args.request || 'that',
        steps: Array.isArray(args.steps) ? args.steps : [],
      };
      else if (fnName === 'show_chart') return {
        type: 'show_chart',
        arg: args.title || 'Chart',
        chart: {
          title: args.title || 'Chart',
          kind: args.kind === 'bar' ? 'bar' : 'line',
          // Anything not explicitly marked as the user's own data is an
          // estimate, and the chart says so. Defaulting the other way would
          // let a guess be drawn as if it were measured.
          basis: args.basis === 'measured' ? 'measured' : 'estimate',
          unit: args.unit || '',
          note: args.note || '',
          series: Array.isArray(args.series) ? args.series : [],
        },
      };
      else if (fnName === 'set_reminder')  return { type: 'set_reminder',   arg: `${args.text}|${args.datetime}|${args.early_minutes || 0}` };
      else if (fnName === 'add_task')    return { type: 'add_task',      arg: `${args.text}|${args.date || ''}` };
      else if (fnName === 'list_tasks')  return { type: 'list_tasks',    arg: args.when || 'today' };
      else if (fnName === 'create_document') return { type: 'create_document', arg: args.title || 'Document', sections: args.sections || [] };
      else if (fnName === 'create_slides')   return { type: 'create_slides',   arg: args.title || 'Presentation', slides: args.slides || [] };
            else if (fnName === 'create_spreadsheet') return { type: 'create_spreadsheet', spec: args };
      else if (fnName === 'mark_emails_read') return { type: 'mark_emails_read', arg: '' };
      else if (fnName === 'set_volume')    return { type: 'set_volume',    arg: `${args.action}|${args.level ?? ''}` };
      else if (fnName === 'system_power')  return { type: 'system_power',  arg: `${args.action}|${args.delay ?? 10}` };
      else if (fnName === 'remember_fact') return { type: 'remember_fact', arg: args.fact };
      else if (fnName === 'forget_fact')   return { type: 'forget_fact',   arg: args.query };
      else if (fnName === 'find_sources')  return { type: 'find_sources',  arg: args.subject };
      else if (fnName === 'get_briefing')  return { type: 'get_briefing',  arg: args.days || 1 };
  return null;
}

// People change their mind mid-sentence: "create me a... no, actually, tell me
// what the biggest country is". Routing read the whole line, saw "create", and
// fired a tool at the half that had just been taken back - so a question came
// back as "On it." with something irrelevant opened. The decision of what this
// request IS gets made on the part after the correction; the model still sees
// the whole sentence, because how somebody arrived at the question is context.
const SECOND_THOUGHTS = /(?:^|[,;.!?\u2014\u2013-]\s*)(?:no,?\s+)?actually,?\s+|(?:^|[,;.!?\u2014\u2013-]\s*)wait,?\s+|scratch that,?\s*|never\s?mind,?\s*|forget (?:that|it),?\s*|i mean,?\s+/i;

function afterSecondThoughts(message) {
  const text = String(message || '');
  let out = text, guard = 0;
  while (guard++ < 4) {
    const m = SECOND_THOUGHTS.exec(out);
    if (!m) break;
    const tail = out.slice(m.index + m[0].length).trim();
    // Only take the tail if there is a real request left in it.
    if (tail.split(/\s+/).length < 2) break;
    out = tail;
  }
  return out || text;
}

async function respond({ message, history = [], assistantName, memories = [], realtimeContext = null, language = 'English', attachments = [], userName = null, userTitle = null, userLocation = null, fast = false }) {
  beginTurn();
  const local = tryLocalCommand(message, assistantName);
  if (local) return { ...local, memory: null };
  const posting = postIntent(stripAddress(message, assistantName));
  if (posting) return posting;

  // Its own name comes off before the model ever sees the sentence.
  //
  // Stripping it inside tryLocalCommand only was not enough: anything that
  // rule did not catch went to the model with "hey Callisto" still on the
  // front, and the model copied the whole sentence into the argument. "Hey
  // Callisto, play xyz on Spotify" became a search for "hey callisto xyz" and
  // played something else entirely. It is wrong in the same way for a reminder
  // title or a search, so it is removed once, here, for all of them.
  message = stripAddress(message, assistantName);

  // Spreadsheets, documents and slides are built by a tool, however they're phrased.
  const isDocWork = DOC_INTENT.test(message);
  const intent = afterSecondThoughts(message);
  const needsTools = isDocWork || asksAboutOwnData(intent) || ((ACTION_KEYWORDS.test(intent) || LIVE_KEYWORDS.test(intent)) && !isKnowledgeQuestion(intent));

  // Fast path: action queries with no context get a minimal prompt and trimmed
  // history for speed. Creative and file work skips it - see HEAVY_INTENT: for
  // those the quick call could only be thrown away, and paying for a round trip
  // before the real one started was pure added wait.
  if (fast && needsTools && !realtimeContext && !isDocWork && !HEAVY_INTENT.test(message)) {
    const fastMessages = [
      { role: 'system', content: FAST_SYSTEM_PROMPT(assistantName) },
      ...history.slice(-5).map((h) => ({ role: h.role, content: h.content })),
      { role: 'user', content: message },
    ];
    // The router only has to pick the right tool, which the mini does as well
    // as anything and faster - about 980ms against 1200-1500 for gpt-4o-mini,
    // on the same tool definitions. Speed is what matters on this one.
    const fastBody = { model: 'gpt-5.4-mini', max_tokens: 150, messages: fastMessages, tools: toolsFor(message), tool_choice: 'required' };
    try {
      const fastRes = await serverFetch('chat', fastBody, { timeout: 15000, retries: 1 });
      const fastData = await fastRes.json();
      if (!fastData.error) {
        const fastChoice = fastData.choices[0];
        if (fastChoice.finish_reason === 'tool_calls' && fastChoice.message.tool_calls) {
          // EVERY call the model made, not just the first. This path kept
          // tool_calls[0] and dropped the rest, so "play some music and remind
          // me at five" did one of the two - and it is the path most action
          // requests take, which is why asking for two things only ever got
          // one. It also used to carry its own copy of the tool-to-action list,
          // which had fallen behind the real one and knew nothing about
          // drawing, 3D models or calendar entries.
          const fastCalls = fastChoice.message.tool_calls;
          // Anything outside this set deserves the full model - a drawing or a
          // 3D model from the quick one comes out poor - so the whole request
          // falls through rather than being half-answered here.
          const everyoneIsQuick = fastCalls.every((c) => FAST_PATH_TOOLS.has(c.function.name));
          if (everyoneIsQuick) {
            const fastActions = fastCalls.map((c) => {
              try { return mapToolCall(c.function.name, JSON.parse(c.function.arguments)); }
              catch (_) { return null; }
            }).filter(Boolean);
            if (fastActions.length) {
              return {
                text: fastChoice.message.content || 'Right away.', memory: null,
                action: fastActions[0], actions: fastActions,
              };
            }
          }
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
    // Building a spreadsheet or document is one long, careful answer: a stronger
    // model, and enough room that the JSON isn't cut off part-way through a row.
    //
    // Documents were still being written by gpt-4.1 while ordinary chat had
    // already moved to gpt-5.4, so the one answer that gets kept as a file was
    // coming from the weaker model. The writing is the whole product here.
    model: hasImages ? 'gpt-4o' : (isDocWork ? 'gpt-5.4' : 'gpt-4o-mini'),
    max_tokens: isDocWork ? 12000 : (needsTools ? 1500 : (hasImages ? 3000 : (isKnowledgeQuestion(message) ? 4000 : 1024))),
    messages,
  };
  if (needsTools) { body.tools = toolsFor(message); body.tool_choice = 'required'; }

  // A full spreadsheet takes far longer than a one-line reply; don't retry it —
  // a retry would double the wait and the cost for the same answer.
  const res = await serverFetch('chat', body, isDocWork ? { timeout: 150000, retries: 0 } : { timeout: 40000, retries: 2 });
  const data = await res.json();
  if (data.error) throw new Error(data.error?.message || data.error);

  const choice = data.choices[0];
  let text = '';
  let action = null;
  let extraActions = [];

  if (needsTools && choice.finish_reason === 'tool_calls' && choice.message.tool_calls) {
    // "Open my markets and show me the weather" is two requests in one breath.
    // The model returns a tool call for each, and every one after the first
    // used to be discarded — so only half of what was asked for happened.
    const _calls = choice.message.tool_calls;
    const call = _calls[0];
    const fnName = call.function.name;
    const args = JSON.parse(call.function.arguments);
    action = mapToolCall(fnName, args);
    // Anything the model asked for beyond the first call runs too.
    extraActions = _calls.slice(1).map((c) => {
      try { return mapToolCall(c.function.name, JSON.parse(c.function.arguments)); }
      catch (_) { return null; }
    }).filter(Boolean);
    text = choice.message.content || 'On it.';
  } else {
    text = choice.message.content || '';
  }

  const rememberMatch = text.match(/\[\[REMEMBER:\s*(.+?)\]\]/i);
  const memory = rememberMatch ? rememberMatch[1].trim() : null;
  text = text.replace(/\[\[REMEMBER:[^\]]+\]\]/gi, '').trim();
  return { text, memory, action, actions: [action, ...extraActions].filter(Boolean) };
}

// Stream response sentence-by-sentence via SSE
async function respondStreaming({ message, history = [], assistantName, memories = [], realtimeContext = null, language = 'English', onSentence, attachments = [], skipToolFallback = false, userName = null, userTitle = null, userLocation = null }) {
  beginTurn();
  const local = tryLocalCommand(message, assistantName);
  if (local) { if (onSentence) onSentence(local.text, local.text); return { ...local, memory: null }; }

  // As above: the name comes off before the model sees it, or it ends up
  // inside whatever argument the model builds out of the sentence.
  message = stripAddress(message, assistantName);
  const posting = postIntent(message);
  if (posting) return posting;

  // Cap on the whole streaming operation. Long answers (biographies, explanations)
  // genuinely take longer, so they get more room before we stop waiting.
  const STREAM_TIMEOUT_MS = 45000;

  const hasImages = attachments.some(a => a.kind === 'image');

  // If images attached — must use non-streaming respond() since vision needs gpt-4o + full analysis
  const intent2 = afterSecondThoughts(message);
  const needsTools = !skipToolFallback && (DOC_INTENT.test(intent2) || asksAboutOwnData(intent2) || ((ACTION_KEYWORDS.test(intent2) || LIVE_KEYWORDS.test(intent2)) && !isKnowledgeQuestion(intent2)));
  if (needsTools || hasImages) {
    return respond({ message, history, assistantName, memories, realtimeContext, language, attachments });
  }

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT(assistantName, memories, realtimeContext, language, userName, userTitle, userLocation) },
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: 'user', content: buildUserContent(message, attachments) },
  ];

  let streamCtrl;
  // What has arrived so far. If the stream stalls or times out we return this
  // instead of throwing — a shortened answer beats a sentence that stops dead.
  let partialText = '';
  const finishPartial = () => {
    const clean = partialText.replace(/\[\[REMEMBER:[^\]]+\]\]/gi, '').trim();
    if (!clean) return null;
    // Drop a trailing half-sentence so the answer ends somewhere sensible.
    const lastEnd = Math.max(clean.lastIndexOf('.'), clean.lastIndexOf('!'), clean.lastIndexOf('?'));
    const trimmed = lastEnd > clean.length * 0.5 ? clean.slice(0, lastEnd + 1) : clean;
    return { text: trimmed, memory: null, action: null, truncated: true };
  };

  const streamResult = await Promise.race([
    (async () => {
      // Educational/study/homework queries need full budget; all other replies are 1-3 sentences
      const EDUCATIONAL_REGEX = /\b(explain|how does|how do|why does|why is|what is|what are|teach me|study|quiz|flashcard|revise|revision|step by step|in detail|describe|define|history of|science|math|chemistry|physics|biology|formula|equation|calculate|solve|homework|assignment|essay|question|answer|problem|working|workings?|proof|derive|derivation|simplify|factorise|factorize|integrate|differentiate|expand|balance|reaction|compound|element|periodic|astronomy|astrophysics|cosmology|planet|galaxy|universe|psychology|psychological|cognitive|behaviour|behavior|neuroscience|geology|ecology|evolution|genetics|anatomy|physiology|thermodynamic\w*|mechanics|quantum|relativity|molecul\w*|atom\w*|cell\w*|enzyme|photosynthesis|orbit\w*|star|stars|planet\w*|theorem|calculus|algebra|geometry|statistic\w*|probability|law of|laws of|principle of|theory of)\b/i;
      const BUSINESS_REGEX = /\b(accounting|finance|financial|tax|taxes|vat|gst|invoice|ledger|balance sheet|cash ?flow|income statement|profit|loss|revenue|margin|ebitda|depreciation|amorti[sz]ation|audit|payroll|budget|forecast|valuation|equity|debt|loan|interest|investment|portfolio|dividend|inflation|economics?|marketing|strategy|business|startup|company|management|operations|supply chain|pricing|sales|contract|law|legal|compliance|hr|negotiat\w*|leadership|entrepreneur\w*|supply and demand|demand curve|market|monopol\w*|gdp|fiscal|monetary|trade|tariff)\b/i;
      // A detailed answer on one of these subjects runs well past 2000 tokens,
      // and being cut off mid-explanation is worse than not starting one.
      const deepSubject = EDUCATIONAL_REGEX.test(message) || BUSINESS_REGEX.test(message);
      // Room to finish, not room to ramble. These were 4000 / 2000 / 900, and
      // a model given four thousand tokens tends to use them - which is time
      // the person spends waiting. Asking for depth still lifts the ceiling;
      // the default no longer invites a lecture.
      const streamTokens = deepSubject ? 2200 : (isKnowledgeQuestion(message) ? 1000 : 500);
      // The answer itself, where what the model actually knows shows. gpt-4o-mini
      // was three generations behind, which is most of why answers read as out
      // of date. The server turns max_tokens into max_completion_tokens for a
      // model of this era; temperature it still takes.
      const res = await serverFetch('chat/stream', {
        model: 'gpt-5.4', max_tokens: streamTokens, temperature: 0.3, messages,
      }, { timeout: 25000, retries: 1 });

      // Keep a fresh AbortController so we can cancel body read on timeout
      streamCtrl = new AbortController();

      let fullText = '';
      let buffer = '';
      let lineBuffer = '';
      const SENTENCE_END = /[.!?]+(\s|$)/;
      // Every finished sentence used to go straight to speech. A short opener
      // - "Yes, sir." - therefore became a clip of its own, with its own
      // request, and the rest of the thought could not start until the next
      // clip came back. That is the pause people hear as "yes... sir, how may
      // I assist you today". Fragments wait and travel with the sentence
      // after them, so a reply is spoken in whole breaths.
      // Two thresholds, because the first clip and the rest want opposite
      // things. The first should be short so speech starts almost at once.
      // Everything after wants to be LONG: each clip is its own synthesis
      // round trip, and a numbered list emitted item by item is a round trip
      // per item - which is why an answer could speak three points, run the
      // queue dry and stall for two seconds before point four. Fewer, longer
      // clips mean fewer chances to run dry, and they sound less clipped.
      // The screen waits for this many characters before showing anything, so
      // it is the gap between asking and seeing a reply begin. 45 held the
      // answer back about a second for no benefit: the first clause is enough
      // to start reading, and the voice catches up. Later chunks stay long,
      // because breaking speech into short pieces is what made it stutter.
      const MIN_FIRST_SPOKEN = 22;
      const MIN_SPOKEN = 220;
      let pendingSpeech = '';
      let spokeOnce = false;

      try {
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
            partialText = fullText;
            buffer += delta;

            let match;
            while ((match = SENTENCE_END.exec(buffer)) !== null) {
              const end = match.index + match[0].length;
              const sentence = buffer.slice(0, end).trim();
              buffer = buffer.slice(end);
              if (!sentence) continue;
              const joined = (pendingSpeech ? pendingSpeech + ' ' : '') + sentence;
              const floor = spokeOnce ? MIN_SPOKEN : MIN_FIRST_SPOKEN;
              if (joined.length < floor) { pendingSpeech = joined; continue; }
              spokeOnce = true;
              pendingSpeech = '';
              // The running markdown goes with it. A sentence has been trimmed
              // and is about to be joined to the last one with a space, which
              // destroys headings and list structure - so the chat bubble
              // formats from this rather than from the reassembled sentences.
              if (onSentence) onSentence(joined, fullText);
            }
          } catch {}
        }
      }

      } catch (err) {
        // Connection dropped part-way — keep what arrived rather than losing the answer.
        if (!fullText.trim()) throw err;
      }

      // Whatever is still held back is said now, joined to any tail.
      const remaining = ((pendingSpeech ? pendingSpeech + ' ' : '') + buffer.trim()).trim();
      pendingSpeech = '';
      if (remaining && onSentence) onSentence(remaining, fullText);

      const rememberMatch = fullText.match(/\[\[REMEMBER:\s*(.+?)\]\]/i);
      const memory = rememberMatch ? rememberMatch[1].trim() : null;
      const cleanText = fullText.replace(/\[\[REMEMBER:[^\]]+\]\]/gi, '').trim();
      return { text: cleanText, memory, action: null };
    })(),
    new Promise((resolve, reject) => setTimeout(() => {
      if (streamCtrl) streamCtrl.abort();
      const partial = finishPartial();
      if (partial) resolve(partial);
      else reject(new Error('Stream timed out'));
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

module.exports = {
  asksAboutOwnData, respond, respondStreaming, generateImage, ACTION_KEYWORDS, isKnowledgeQuestion, serverFetch };
