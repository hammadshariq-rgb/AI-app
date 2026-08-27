const fetch = require('node-fetch');

// ── In-memory cache — avoid repeat fetches for the same query within 60s ─────
const _cache = new Map();
function _cached(key, fn, ttlMs = 60000) {
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.ts < ttlMs) return Promise.resolve(hit.value);
  return fn().then(v => { _cache.set(key, { value: v, ts: Date.now() }); return v; });
}

// ── Timed fetch helper ────────────────────────────────────────────────────────
function _timedFetch(url, opts = {}, ms = 3000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

// Weather via wttr.in — free, no API key
async function getWeather(location) {
  try {
    const res = await fetch(`https://wttr.in/${encodeURIComponent(location)}?format=j1`, { timeout: 1500 });
    const data = await res.json();
    const current = data.current_condition[0];
    const area = data.nearest_area[0];
    const city = area.areaName[0].value;
    const country = area.country[0].value;
    const desc = current.weatherDesc[0].value;
    const tempC = current.temp_C;
    const tempF = current.temp_F;
    const humidity = current.humidity;
    const feelsC = current.FeelsLikeC;
    const wind = current.windspeedKmph;
    return `Weather in ${city}, ${country}: ${desc}. Temperature: ${tempC}°C (${tempF}°F), feels like ${feelsC}°C. Humidity: ${humidity}%. Wind: ${wind} km/h.`;
  } catch (e) {
    return null;
  }
}

// ── Periodic table element data ───────────────────────────────────────────────
const ELEMENTS = {
  H:{n:1,name:'Hydrogen',mass:'1.008',cat:'Nonmetal',group:1,period:1,config:'1s¹',desc:'Lightest element; makes up ~75% of the universe.'},
  He:{n:2,name:'Helium',mass:'4.003',cat:'Noble Gas',group:18,period:1,config:'1s²',desc:'Noble gas; second most abundant in the universe.'},
  Li:{n:3,name:'Lithium',mass:'6.941',cat:'Alkali Metal',group:1,period:2,config:'[He] 2s¹',desc:'Lightest metal; used in batteries.'},
  Be:{n:4,name:'Beryllium',mass:'9.012',cat:'Alkaline Earth',group:2,period:2,config:'[He] 2s²',desc:'Light, stiff metal used in aerospace.'},
  B:{n:5,name:'Boron',mass:'10.81',cat:'Metalloid',group:13,period:2,config:'[He] 2s² 2p¹',desc:'Metalloid; essential in glass & ceramics.'},
  C:{n:6,name:'Carbon',mass:'12.011',cat:'Nonmetal',group:14,period:2,config:'[He] 2s² 2p²',desc:'Basis of all organic chemistry & life.'},
  N:{n:7,name:'Nitrogen',mass:'14.007',cat:'Nonmetal',group:15,period:2,config:'[He] 2s² 2p³',desc:'Makes up 78% of Earth\'s atmosphere.'},
  O:{n:8,name:'Oxygen',mass:'15.999',cat:'Nonmetal',group:16,period:2,config:'[He] 2s² 2p⁴',desc:'Essential for respiration; most abundant in Earth\'s crust.'},
  F:{n:9,name:'Fluorine',mass:'18.998',cat:'Halogen',group:17,period:2,config:'[He] 2s² 2p⁵',desc:'Most electronegative element.'},
  Ne:{n:10,name:'Neon',mass:'20.180',cat:'Noble Gas',group:18,period:2,config:'[He] 2s² 2p⁶',desc:'Used in signs & lasers.'},
  Na:{n:11,name:'Sodium',mass:'22.990',cat:'Alkali Metal',group:1,period:3,config:'[Ne] 3s¹',desc:'Highly reactive; essential electrolyte in biology.'},
  Mg:{n:12,name:'Magnesium',mass:'24.305',cat:'Alkaline Earth',group:2,period:3,config:'[Ne] 3s²',desc:'Light structural metal; essential in chlorophyll.'},
  Al:{n:13,name:'Aluminium',mass:'26.982',cat:'Post-Transition',group:13,period:3,config:'[Ne] 3s² 3p¹',desc:'Most abundant metal in Earth\'s crust.'},
  Si:{n:14,name:'Silicon',mass:'28.086',cat:'Metalloid',group:14,period:3,config:'[Ne] 3s² 3p²',desc:'Basis of semiconductors & computer chips.'},
  P:{n:15,name:'Phosphorus',mass:'30.974',cat:'Nonmetal',group:15,period:3,config:'[Ne] 3s² 3p³',desc:'Essential for DNA, RNA, and ATP.'},
  S:{n:16,name:'Sulfur',mass:'32.06',cat:'Nonmetal',group:16,period:3,config:'[Ne] 3s² 3p⁴',desc:'Used in sulfuric acid; essential for proteins.'},
  Cl:{n:17,name:'Chlorine',mass:'35.45',cat:'Halogen',group:17,period:3,config:'[Ne] 3s² 3p⁵',desc:'Used in water purification & PVC.'},
  Ar:{n:18,name:'Argon',mass:'39.948',cat:'Noble Gas',group:18,period:3,config:'[Ne] 3s² 3p⁶',desc:'Third most abundant gas in Earth\'s atmosphere.'},
  K:{n:19,name:'Potassium',mass:'39.098',cat:'Alkali Metal',group:1,period:4,config:'[Ar] 4s¹',desc:'Essential mineral for nerve and muscle function.'},
  Ca:{n:20,name:'Calcium',mass:'40.078',cat:'Alkaline Earth',group:2,period:4,config:'[Ar] 4s²',desc:'Most abundant mineral in the human body; essential for bones.'},
  Sc:{n:21,name:'Scandium',mass:'44.956',cat:'Transition Metal',group:3,period:4,config:'[Ar] 3d¹ 4s²',desc:'Light metal used in aerospace alloys.'},
  Ti:{n:22,name:'Titanium',mass:'47.867',cat:'Transition Metal',group:4,period:4,config:'[Ar] 3d² 4s²',desc:'Strong, corrosion-resistant metal used in aircraft.'},
  V:{n:23,name:'Vanadium',mass:'50.942',cat:'Transition Metal',group:5,period:4,config:'[Ar] 3d³ 4s²',desc:'Used in steel alloys and batteries.'},
  Cr:{n:24,name:'Chromium',mass:'51.996',cat:'Transition Metal',group:6,period:4,config:'[Ar] 3d⁵ 4s¹',desc:'Used in stainless steel and chrome plating.'},
  Mn:{n:25,name:'Manganese',mass:'54.938',cat:'Transition Metal',group:7,period:4,config:'[Ar] 3d⁵ 4s²',desc:'Essential trace element; used in steel production.'},
  Fe:{n:26,name:'Iron',mass:'55.845',cat:'Transition Metal',group:8,period:4,config:'[Ar] 3d⁶ 4s²',desc:'Most used metal; essential component of hemoglobin.'},
  Co:{n:27,name:'Cobalt',mass:'58.933',cat:'Transition Metal',group:9,period:4,config:'[Ar] 3d⁷ 4s²',desc:'Used in batteries, magnets, and blue pigment.'},
  Ni:{n:28,name:'Nickel',mass:'58.693',cat:'Transition Metal',group:10,period:4,config:'[Ar] 3d⁸ 4s²',desc:'Corrosion-resistant; used in stainless steel & coins.'},
  Cu:{n:29,name:'Copper',mass:'63.546',cat:'Transition Metal',group:11,period:4,config:'[Ar] 3d¹⁰ 4s¹',desc:'Excellent conductor; used in wiring & plumbing.'},
  Zn:{n:30,name:'Zinc',mass:'65.38',cat:'Transition Metal',group:12,period:4,config:'[Ar] 3d¹⁰ 4s²',desc:'Essential trace element; used in galvanising steel.'},
  Ga:{n:31,name:'Gallium',mass:'69.723',cat:'Post-Transition',group:13,period:4,config:'[Ar] 3d¹⁰ 4s² 4p¹',desc:'Melts near room temperature; used in semiconductors.'},
  Ge:{n:32,name:'Germanium',mass:'72.630',cat:'Metalloid',group:14,period:4,config:'[Ar] 3d¹⁰ 4s² 4p²',desc:'Semiconductor used in electronics.'},
  As:{n:33,name:'Arsenic',mass:'74.922',cat:'Metalloid',group:15,period:4,config:'[Ar] 3d¹⁰ 4s² 4p³',desc:'Toxic metalloid; used in semiconductors.'},
  Se:{n:34,name:'Selenium',mass:'78.971',cat:'Nonmetal',group:16,period:4,config:'[Ar] 3d¹⁰ 4s² 4p⁴',desc:'Essential trace element; used in photocells.'},
  Br:{n:35,name:'Bromine',mass:'79.904',cat:'Halogen',group:17,period:4,config:'[Ar] 3d¹⁰ 4s² 4p⁵',desc:'Only liquid nonmetal at room temperature.'},
  Kr:{n:36,name:'Krypton',mass:'83.798',cat:'Noble Gas',group:18,period:4,config:'[Ar] 3d¹⁰ 4s² 4p⁶',desc:'Noble gas used in fluorescent lights.'},
  Rb:{n:37,name:'Rubidium',mass:'85.468',cat:'Alkali Metal',group:1,period:5,config:'[Kr] 5s¹',desc:'Highly reactive alkali metal.'},
  Sr:{n:38,name:'Strontium',mass:'87.62',cat:'Alkaline Earth',group:2,period:5,config:'[Kr] 5s²',desc:'Used in fireworks (red colour) and CRT screens.'},
  Ag:{n:47,name:'Silver',mass:'107.87',cat:'Transition Metal',group:11,period:5,config:'[Kr] 4d¹⁰ 5s¹',desc:'Best electrical conductor; used in jewellery & electronics.'},
  Cd:{n:48,name:'Cadmium',mass:'112.41',cat:'Transition Metal',group:12,period:5,config:'[Kr] 4d¹⁰ 5s²',desc:'Toxic metal used in rechargeable batteries.'},
  Sn:{n:50,name:'Tin',mass:'118.71',cat:'Post-Transition',group:14,period:5,config:'[Kr] 4d¹⁰ 5s² 5p²',desc:'Used in solder, tin cans, and bronze alloys.'},
  I:{n:53,name:'Iodine',mass:'126.90',cat:'Halogen',group:17,period:5,config:'[Kr] 4d¹⁰ 5s² 5p⁵',desc:'Essential for thyroid hormones; used as antiseptic.'},
  Xe:{n:54,name:'Xenon',mass:'131.29',cat:'Noble Gas',group:18,period:5,config:'[Kr] 4d¹⁰ 5s² 5p⁶',desc:'Used in high-intensity lamps and anaesthesia.'},
  Ba:{n:56,name:'Barium',mass:'137.33',cat:'Alkaline Earth',group:2,period:6,config:'[Xe] 6s²',desc:'Used in X-ray imaging and fireworks (green).'},
  W:{n:74,name:'Tungsten',mass:'183.84',cat:'Transition Metal',group:6,period:6,config:'[Xe] 4f¹⁴ 5d⁴ 6s²',desc:'Highest melting point of all metals; used in light bulb filaments.'},
  Au:{n:79,name:'Gold',mass:'196.97',cat:'Transition Metal',group:11,period:6,config:'[Xe] 4f¹⁴ 5d¹⁰ 6s¹',desc:'Highly conductive, corrosion-resistant precious metal.'},
  Hg:{n:80,name:'Mercury',mass:'200.59',cat:'Transition Metal',group:12,period:6,config:'[Xe] 4f¹⁴ 5d¹⁰ 6s²',desc:'Only liquid metal at room temperature; toxic.'},
  Pb:{n:82,name:'Lead',mass:'207.2',cat:'Post-Transition',group:14,period:6,config:'[Xe] 4f¹⁴ 5d¹⁰ 6s² 6p²',desc:'Dense, soft, toxic metal; used in batteries.'},
  Ra:{n:88,name:'Radium',mass:'226',cat:'Alkaline Earth',group:2,period:7,config:'[Rn] 7s²',desc:'Radioactive element discovered by Marie Curie.'},
  U:{n:92,name:'Uranium',mass:'238.03',cat:'Actinide',group:3,period:7,config:'[Rn] 5f³ 6d¹ 7s²',desc:'Radioactive; fuel for nuclear reactors.'},
  Pu:{n:94,name:'Plutonium',mass:'244',cat:'Actinide',group:3,period:7,config:'[Rn] 5f⁶ 7s²',desc:'Radioactive; used in nuclear weapons and reactors.'},
};

const ELEMENT_NAME_MAP = Object.fromEntries(
  Object.entries(ELEMENTS).map(([sym, el]) => [el.name.toLowerCase(), sym])
);

function findElement(query) {
  const q = query.toLowerCase();
  for (const [name, sym] of Object.entries(ELEMENT_NAME_MAP)) {
    if (q.includes(name)) return sym;
  }
  // Direct symbol (case-sensitive, surrounded by word boundaries)
  for (const sym of Object.keys(ELEMENTS)) {
    const re = new RegExp(`\\b${sym}\\b`);
    if (re.test(query)) return sym;
  }
  return null;
}

const SCIENCE_REGEX = /\b(atom|atomic|molecule|element|periodic table|chemical|chemistry|photosynthesis|mitosis|meiosis|dna|rna|protein|enzyme|cell|gene|chromosome|evolution|ecosystem|organism|biology|physics|gravity|quantum|relativity|thermodynamics|electromagnetic|newton|force|energy|velocity|acceleration|momentum|circuit|voltage|current|resistance|ohm|faraday|wave|frequency|wavelength|radiation|nuclear|fission|fusion|proton|neutron|electron|quark|lepton|boson|higgs|orbit|planet|galaxy|black hole|solar system|space mission|nasa|apollo|hubble|james webb|telescope|supernova|neutron star|nebula|asteroid|comet|mars|jupiter|saturn|milky way|big bang|dark matter|dark energy|algebra|calculus|trigonometry|geometry|quadratic|derivative|integral|matrix|vector|probability|statistics|theorem|pythagoras|fibonacci|prime number|polynomial|logarithm|einstein|newton|darwin|mendel|curie|tesla|bohr|heisenberg|schrödinger|planck)\b/i;

function extractConcept(query) {
  return query
    .replace(/\b(tell me about|what is|what are|what was|what were|explain|describe|show me|how does|how do|how is|why is|why does|define|teach me|i want to know about|can you explain|history of)\b/gi, '')
    .replace(/\b(please|the|a|an|to|me|us|for)\b/gi, '')
    .replace(/[?!.]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function wikiCard(topic) {
  if (!topic || topic.length < 2) return null;
  const res = await _timedFetch(
    `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(topic)}`,
    { headers: { 'User-Agent': 'JarvisApp/1.0' } }, 5000
  );
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.title || data.type === 'disambiguation') return null;

  // If Wikipedia returns coordinates → it's a geographic location, show location card
  if (data.coordinates) {
    const { lat, lon } = data.coordinates;
    // Fetch extra images from Wikimedia Commons for this page
    let extraImages = [];
    try {
      const imgRes = await _timedFetch(
        `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(data.title)}&prop=images&format=json&imlimit=8`,
        { headers: { 'User-Agent': 'JarvisApp/1.0' } }, 3000
      );
      if (imgRes.ok) {
        const imgData = await imgRes.json();
        const pages = Object.values(imgData?.query?.pages || {});
        const imgTitles = (pages[0]?.images || [])
          .map(i => i.title)
          .filter(t => /\.(jpg|jpeg|png|webp)$/i.test(t) && !/flag|coat|logo|icon|seal|map|locator/i.test(t))
          .slice(0, 4);
        // Resolve image URLs
        if (imgTitles.length) {
          const urlRes = await _timedFetch(
            `https://en.wikipedia.org/w/api.php?action=query&titles=${imgTitles.map(encodeURIComponent).join('|')}&prop=imageinfo&iiprop=url&format=json`,
            { headers: { 'User-Agent': 'JarvisApp/1.0' } }, 3000
          );
          if (urlRes.ok) {
            const urlData = await urlRes.json();
            extraImages = Object.values(urlData?.query?.pages || {})
              .map(p => p.imageinfo?.[0]?.url)
              .filter(Boolean);
          }
        }
      }
    } catch {}

    return {
      type: 'location',
      title: data.title,
      description: data.description || '',
      summary: (data.extract || '').slice(0, 300),
      heroImage: data.thumbnail?.source || null,
      images: extraImages,
      lat, lon,
      mapsUrl: `https://www.google.com/maps/search/${encodeURIComponent(data.title)}`,
      sourceUrl: data.content_urls?.desktop?.page || null,
    };
  }

  return {
    type: 'science',
    title: data.title,
    subtitle: data.description || '',
    summary: (data.extract || '').slice(0, 500),
    imageUrl: data.thumbnail?.source || null,
    source: 'Wikipedia',
    sourceUrl: data.content_urls?.desktop?.page || null,
  };
}

// ── Places / business search using Nominatim (free, no API key) ───────────────
const PLACES_SEARCH_REGEX = /\b(best|top|nearest|closest|good|find|where('s| is| are)|recommend|great|popular|famous)\b.{0,40}\b(restaurant|pizza|burger|food|sushi|coffee|cafe|bar|pub|gym|bowling|cinema|theatre?|hotel|hospital|pharmacy|bank|atm|mall|supermarket|museum|park|beach|nightclub|club|spa|salon|dentist|doctor|mechanic|gas station|petrol|station)\b/i;
const LOCATION_QUERY_REGEX = /\b(show me|pictures? of|photos? of|images? of|visit|travel to|explore|what('s| is).{0,20}like|tell me about|about)\b.{0,50}\b(city|country|capital|island|town|village|landmark|monument|beach|mountain|lake|river|park|region|state|province)\b|\b(in|of|from)\s+[A-Z][a-z]+(\s+[A-Z][a-z]+)?\s*\??\s*$/;

async function getPlacesCard(query) {
  try {
    const searchQuery = query
      .replace(/\b(best|top|nearest|closest|good|find me|find|where is|where are|recommend|give me|show me|tell me|great|popular|famous|i want|can you|please)\b/gi, '')
      .replace(/\b(in|near|around|at|a|an|the|some)\b/gi, ' ')
      .replace(/[?!.]+/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    const res = await _timedFetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(searchQuery)}&format=json&limit=5&addressdetails=1&extratags=1`,
      { headers: { 'User-Agent': 'JarvisApp/1.0 (personal assistant)' } }, 5000
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !data.length) return null;

    const places = data.slice(0, 5).map(p => {
      const parts = p.display_name.split(', ');
      return {
        name: p.name || parts[0],
        address: parts.slice(0, 3).join(', '),
        type: (p.type || p.class || '').replace(/_/g, ' '),
        lat: p.lat,
        lon: p.lon,
        phone: p.extratags?.phone || null,
        website: p.extratags?.website || null,
        mapsUrl: `https://www.google.com/maps/search/${encodeURIComponent((p.name || parts[0]) + ' ' + parts.slice(1, 3).join(', '))}`,
      };
    });

    return { type: 'places', query: searchQuery, places };
  } catch { return null; }
}

async function getLocationCard(query) {
  try {
    const topic = query
      .replace(/\b(show me|tell me about|pictures? of|photos? of|images? of|visit|travel to|explore|what is|what's|about|the history of|overview of|facts about|info on|information about)\b/gi, '')
      .replace(/[?!.]+$/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!topic || topic.length < 2) return null;
    const card = await wikiCard(topic);
    return card?.type === 'location' ? card : null;
  } catch { return null; }
}

async function getScienceCard(query) {
  try {
    // Specific chemical element
    const elemSym = findElement(query);
    if (elemSym && ELEMENTS[elemSym]) {
      const el = ELEMENTS[elemSym];
      return {
        type: 'element',
        symbol: elemSym,
        name: el.name,
        atomicNumber: el.n,
        mass: el.mass,
        category: el.cat,
        group: el.group,
        period: el.period,
        config: el.config,
        desc: el.desc,
        source: 'Periodic Table',
        sourceUrl: `https://en.wikipedia.org/wiki/${encodeURIComponent(el.name)}`,
      };
    }

    // Full periodic table
    if (/periodic table/i.test(query)) {
      return { type: 'periodic_table', source: 'Periodic Table', sourceUrl: 'https://en.wikipedia.org/wiki/Periodic_table' };
    }

    // Extract the core concept from question-form queries
    const concept = extractConcept(query);
    if (!concept || concept.length < 2) return null;

    // Try the exact concept first, then fallback to a 2-word sub-phrase
    const card = await wikiCard(concept);
    if (card) return card;

    // Try just the first 2-3 significant words
    const words = concept.split(/\s+/).filter(w => w.length > 2);
    if (words.length > 1) {
      const shorter = words.slice(0, 3).join(' ');
      const card2 = await wikiCard(shorter);
      if (card2) return card2;
    }

    return null;
  } catch (_) {
    return null;
  }
}

// DuckDuckGo Instant Answers — free, no API key
async function ddgSearch(query) {
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const res = await _timedFetch(url, {}, 2500);
    const data = await res.json();
    const parts = [];
    if (data.Answer) parts.push(data.Answer);
    if (data.AbstractText) parts.push(data.AbstractText);
    if (data.RelatedTopics && data.RelatedTopics.length > 0) {
      data.RelatedTopics.slice(0, 3).forEach((t) => { if (t.Text) parts.push(t.Text); });
    }
    return parts.length > 0 ? parts.join(' ') : null;
  } catch (e) {
    return null;
  }
}

// Wikipedia summary for factual/historical queries
async function wikiSearch(query) {
  try {
    const search = await _timedFetch(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=1`, {}, 2000);
    const searchData = await search.json();
    const title = searchData?.query?.search?.[0]?.title;
    if (!title) return null;
    const summary = await _timedFetch(`https://en.wikipedia.org/w/api.php?action=query&prop=extracts&exintro&explaintext&titles=${encodeURIComponent(title)}&format=json`, {}, 2000);
    const sumData = await summary.json();
    const pages = sumData?.query?.pages;
    const page = pages[Object.keys(pages)[0]];
    if (!page?.extract) return null;
    // Return first 600 chars
    return page.extract.slice(0, 600).trim();
  } catch (e) {
    return null;
  }
}

// RSS news feed for current events
async function getLatestNews(topic) {
  try {
    const query = encodeURIComponent(topic);
    const res = await fetch(`https://news.google.com/rss/search?q=${query}&hl=en-US&gl=US&ceid=US:en`, { timeout: 1500 });
    const xml = await res.text();
    // Parse titles from RSS
    const titles = [];
    const regex = /<title><!\[CDATA\[(.+?)\]\]><\/title>|<title>(.+?)<\/title>/g;
    let match;
    let count = 0;
    while ((match = regex.exec(xml)) !== null && count < 5) {
      const title = (match[1] || match[2] || '').trim();
      if (title && title !== topic && !title.toLowerCase().includes('google news')) {
        titles.push(title);
        count++;
      }
    }
    return titles.length > 0 ? `Latest news on "${topic}": ${titles.join(' | ')}` : null;
  } catch (e) {
    return null;
  }
}

// Scrape Google for a general factual answer — handles current leaders, recent events, etc.
async function googleFactSearch(query) {
  try {
    const res = await fetch(`https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en&gl=us`, {
      headers: BROWSER_HEADERS, timeout: 8000,
    });
    if (!res.ok) return null;
    const html = await res.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ');

    // Try to grab the featured snippet / knowledge panel (first 600 chars near the query keyword)
    const keyword = query.toLowerCase().split(/\s+/).filter(w => w.length > 3)[0] || query.toLowerCase().split(' ')[0];
    const idx = text.toLowerCase().indexOf(keyword);
    const snippet = idx >= 0
      ? text.slice(Math.max(0, idx - 100), idx + 700).trim()
      : text.slice(500, 1200).trim();

    return snippet.length > 40 ? `Google result: ${snippet.slice(0, 700)}` : null;
  } catch (e) { return null; }
}

// Main function — called before AI responds when real-time data is needed
async function fetchRealtimeContext(query) {
  return _cached(`rtx:${query}`, () => _fetchRealtimeContextInner(query), 45000);
}
async function _fetchRealtimeContextInner(query) {
  const q = query.toLowerCase();

  // Weather
  if (/weather|temperature|forecast|raining|sunny|hot|cold|humid|wind/.test(q)) {
    const locMatch = query.match(/(?:weather|temperature|forecast)\s+(?:in|at|for|like in)?\s+([a-zA-Z\s,]+)/i);
    const location = locMatch ? locMatch[1].trim() : 'current location';
    const weather = await getWeather(location);
    if (weather) return weather;
  }

  // Sports — ESPN with date-range search + detailed summary (scorers + MOTM)
  if (SPORTS_REGEX.test(q)) {
    const card = await espnSportsSearch(query);
    if (card) {
      const isUpcoming = card.score1 === '–';
      let ctx = isUpcoming
        ? `LIVE SPORTS DATA:\n${card.team1} vs ${card.team2} — match has NOT started yet.\nStatus: ${card.status}`
        : `LIVE SPORTS DATA:\nFinal Score: ${card.team1} ${card.score1} - ${card.score2} ${card.team2}\nStatus: ${card.status}`;
      if (card.league) ctx += `\nCompetition: ${card.league}`;
      if (card.date) ctx += `\nDate: ${card.date}`;
      if (card.venue) ctx += `\nVenue: ${card.venue}`;
      if (card.scorers?.length) {
        ctx += `\nGoal Scorers:\n${card.scorers.map(s => `- ${s.team ? s.team + ': ' : ''}${s.detail}`).join('\n')}`;
      } else if (!isUpcoming) {
        ctx += `\nScorers: Not available from ESPN for this match.`;
      }
      if (card.motm) ctx += `\nMan of the Match: ${card.motm}`;
      ctx += `\nSource: ${card.source}\n\nRead out the score, list every scorer with their minute, and state the man of the match. Only use what is above.`;
      return ctx;
    }
    return `LIVE DATA: No match data found on ESPN for "${query}". Do NOT guess or invent any score, scorer, or result. Tell the user you could not find data and offer to open Google for them.`;
  }

  // Current world affairs — presidents, prime ministers, leaders, elections, recent events
  const worldAffairsRegex = /\b(president|prime minister|premier|chancellor|king|queen|emperor|leader|head of state|ceo|who is|who was|who leads|who runs|who won|who beat|elected|election|appointed|sworn in|resigned|died|passed away|killed|war|conflict|attack|invasion|treaty|sanction|protest|coup|crisis|disaster|earthquake|flood|hurricane|pandemic|outbreak|vaccine|law|bill|act|policy|ban|legalized|arrested|charged|convicted|sentenced|released|summit|deal|agreement|signed|launched|discovered|invented|broke|record|champion|title|won the|lost the|announced|released|dropped|debut)\b/i;

  if (worldAffairsRegex.test(q)) {
    const [google, news] = await Promise.all([
      googleFactSearch(query),
      getLatestNews(query),
    ]);
    const parts = [google, news].filter(Boolean);
    if (parts.length > 0) return `REAL-TIME SEARCH DATA (use this, ignore your training data on this topic):\n${parts.join('\n\n').slice(0, 900)}`;
  }

  // Explicit news/current events queries
  if (/news|latest|what happened|current events|today|yesterday|this week|right now|recently|breaking/.test(q)) {
    const [google, news, ddg] = await Promise.all([
      googleFactSearch(query),
      getLatestNews(query),
      ddgSearch(query),
    ]);
    const parts = [google, news, ddg].filter(Boolean);
    return parts.length > 0 ? `REAL-TIME DATA:\n${parts.join('\n').slice(0, 900)}` : null;
  }

  // General factual question — only fetch live data for questions that need it
  // Skip for pure educational/historical questions that the AI already knows
  const needsLiveData = /\b(who is|who's|who was|currently|right now|at the moment|today|this year|this month|latest|recent|new|announced|launched|released|appointed|elected|won|beat|defeated|died|arrested|charged|sentenced)\b/i.test(q);
  if (!needsLiveData) return null;

  const [google, ddg] = await Promise.all([
    googleFactSearch(query),
    ddgSearch(query),
  ]);
  const parts = [google, ddg].filter(Boolean);
  return parts.length > 0
    ? `REAL-TIME DATA (prioritise this over your training data):\n${parts.join('\n').slice(0, 900)}`
    : null;
}

// (duplicate _timedFetch removed — defined at top of file)

// Look up ticker symbol by company name using Yahoo Finance search
async function resolveTickerSymbol(query) {
  try {
    const res = await _timedFetch(
      `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=1&newsCount=0`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }, 3000
    );
    const data = await res.json();
    const hit = data?.quotes?.[0];
    if (hit?.symbol) return hit.symbol;
  } catch (_) {}
  return null;
}

// Stock / crypto data via Yahoo Finance (no API key needed)
async function getStockCard(symbol) {
  try {
    const res = await _timedFetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=30d`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }, 5000
    );
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    const meta = result?.meta;
    if (!meta?.regularMarketPrice) return null;

    const price = meta.regularMarketPrice;
    const prev = meta.previousClose || meta.chartPreviousClose || price;
    const change = price - prev;
    const changePct = prev ? ((change / prev) * 100).toFixed(2) : '0.00';
    const closes = result?.indicators?.quote?.[0]?.close?.filter(Boolean) || [];

    // 52-week high/low
    const high52 = meta.fiftyTwoWeekHigh;
    const low52 = meta.fiftyTwoWeekLow;
    const marketCap = meta.marketCap;
    const volume = meta.regularMarketVolume;

    const isCrypto = ['BTC-USD','ETH-USD','BNB-USD','SOL-USD','ADA-USD','XRP-USD','DOGE-USD','DOT-USD','AVAX-USD','MATIC-USD','SHIB-USD','LTC-USD','LINK-USD','UNI-USD'].includes(symbol.toUpperCase());

    return {
      type: 'stock',
      isCrypto,
      symbol: meta.symbol,
      name: meta.longName || meta.shortName || meta.symbol,
      price: price < 1 ? price.toFixed(6) : price.toFixed(2),
      change: Math.abs(change) < 1 ? change.toFixed(6) : change.toFixed(2),
      changePct,
      positive: change >= 0,
      currency: meta.currency || 'USD',
      sparkline: closes.slice(-30),
      high52: high52 ? (high52 < 1 ? high52.toFixed(4) : high52.toFixed(2)) : null,
      low52: low52 ? (low52 < 1 ? low52.toFixed(4) : low52.toFixed(2)) : null,
      marketCap: marketCap ? formatMarketCap(marketCap) : null,
      volume: volume ? formatVolume(volume) : null,
      source: 'Yahoo Finance',
      sourceUrl: `https://finance.yahoo.com/quote/${meta.symbol}`,
    };
  } catch (e) { return null; }
}

function formatMarketCap(n) {
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9)  return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6)  return `$${(n / 1e6).toFixed(2)}M`;
  return `$${n.toLocaleString()}`;
}

// Company financial analytics card — revenue history + key metrics
const COMPANY_FINANCE_REGEX = /\b(revenue|revenues|earnings|profit|profits|income|financial(s| data| results| report)?|annual report|quarterly (results|earnings|revenue)|how much (does|did|has)|how many (customers|users)|market share|growth|sales figures?|turnover|ebitda|net income|gross profit|operating income|cash flow|fiscal year)\b/i;

async function getCompanyFinanceCard(query) {
  try {
    // Extract company name from query
    const cleaned = query
      .replace(/show me|what (is|are|was|were) (the )?|tell me (about )?|give me|how much (does|did|has)|how many/gi, '')
      .replace(/\b(revenue|revenues|earnings|profit|profits|income|financial(s| data| results)?|annual|quarterly|last \d+ years?|in the (last|past) \d+ years?|generated by|of|for|the)\b/gi, '')
      .trim();

    const symbol = await resolveTickerSymbol(cleaned);
    if (!symbol) return null;

    // Fetch income statement history + stock quote in parallel
    const [summaryRes, stockCard] = await Promise.all([
      _timedFetch(
        `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=incomeStatementHistory,defaultKeyStatistics,summaryDetail`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } }, 5000
      ).catch(() => null),
      getStockCard(symbol),
    ]);

    let revenues = [];
    let peRatio = null;
    let profitMargin = null;
    let sector = null;

    if (summaryRes && summaryRes.ok) {
      const summaryData = await summaryRes.json().catch(() => null);
      const history = summaryData?.quoteSummary?.result?.[0]?.incomeStatementHistory?.incomeStatementHistory || [];
      const stats = summaryData?.quoteSummary?.result?.[0]?.defaultKeyStatistics || {};
      const detail = summaryData?.quoteSummary?.result?.[0]?.summaryDetail || {};

      revenues = history.slice(0, 4).reverse().map(s => ({
        year: s.endDate?.fmt ? s.endDate.fmt.slice(0, 4) : null,
        revenue: s.totalRevenue?.raw || 0,
        netIncome: s.netIncome?.raw || 0,
      })).filter(r => r.year && r.revenue);

      peRatio = detail.trailingPE?.raw ? detail.trailingPE.raw.toFixed(1) : null;
      profitMargin = stats.profitMargins?.raw ? (stats.profitMargins.raw * 100).toFixed(1) + '%' : null;
    }

    if (!stockCard) return null;

    return {
      type: 'company_finance',
      symbol: stockCard.symbol,
      name: stockCard.name,
      price: stockCard.price,
      change: stockCard.change,
      changePct: stockCard.changePct,
      positive: stockCard.positive,
      currency: stockCard.currency,
      marketCap: stockCard.marketCap,
      sparkline: stockCard.sparkline,
      revenues,
      peRatio,
      profitMargin,
      sourceUrl: `https://finance.yahoo.com/quote/${stockCard.symbol}/financials`,
    };
  } catch (e) { return null; }
}

function formatVolume(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

// Person card — photo + name + short bio from Wikipedia
const PERSON_REGEX = /\b(who is|who('s| is) (the )?|tell me about|show me|photo of|picture of|biography of)\b.{2,60}?(minister|president|prime minister|pm|ceo|founder|king|queen|prince|princess|chancellor|senator|governor|mayor|general|admiral|director|secretary|actor|actress|singer|rapper|athlete|player|politician|leader|chef|scientist|inventor|philosopher|author|writer|poet|artist|painter|composer|conductor|director|cto|cfo|chairman|chairwoman|head of|lord|emperor|empress|prince|princess|duke|duchess|sultan|emir|ayatollah|pope|archbishop|cardinal|bishop|imam|rabbi|sheikh)/i;

const PERSON_QUERY_REGEX = /^(who is|who('s| is) the |tell me about |show me |biography of |about )/i;

// Returns true if a Wikipedia page title looks like a position/office article, not a person
function _isOfficeArticle(title) {
  if (/^list of\b/i.test(title)) return true;
  // "Prime Minister of Pakistan", "President of France", "Secretary of State of X"
  if (/\b(prime minister|minister|president|secretary|chancellor|governor|mayor|chairman|director|head of|speaker of|chief of)\b.{0,20}\bof\b/i.test(title)) return true;
  // "Pakistani PM", "PM of X"
  if (/^\s*(?:the\s+)?(?:pm|cm|vp|ceo|cfo|cto)\s+of\b/i.test(title)) return true;
  return false;
}

// Returns true if the extract text describes a living/past person (not a position/office)
function _looksLikePerson(extract) {
  if (!extract) return false;
  // Person articles typically say "X is/was a [nationality] [noun]" or "born"
  return /\b(born|is an?|was an?|is a|was a)\b/i.test(extract.slice(0, 300));
}

async function _fetchWikiPage(title) {
  const res = await fetch(
    `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=pageimages|extracts&exintro&explaintext&pithumbsize=400&format=json`,
    { timeout: 2500 }
  ).catch(() => null);
  if (!res) return null;
  const data = await res.json().catch(() => null);
  return Object.values(data?.query?.pages || {})[0] || null;
}

async function getPersonCard(query) {
  try {
    // Extract the actual subject from anywhere in the query, not just the start
    // Handles: "Jarvis who is X", "hey who is X", "who is X", "tell me about X"
    let subject = query;

    // Try to extract subject after intent keywords wherever they appear
    const intentMatch = query.match(/\b(?:who is|who's|who are|who was|tell me about|show me|photo of|picture of|biography of|about)\s+(?:the\s+|a\s+|an\s+)?(.+)/i);
    if (intentMatch) {
      subject = intentMatch[1];
    } else {
      // Fallback: strip leading AI name or filler words then strip known prefixes
      subject = query
        .replace(/^[a-z]+[,\s]+/i, '') // strip leading word like "Jarvis, " or "Hey "
        .replace(/^(who is|who's|who are|tell me about|show me|photo of|picture of|biography of|about)\s+/i, '');
    }

    subject = subject.replace(/\?$/, '').trim();

    const isRoleQuery = /\b(prime minister|president|pm|chief minister|governor|secretary|chancellor|minister|mayor|ceo|chairman|king|queen|sultan|emir)\b/i.test(subject);

    // For role queries try "current X" first so Wikipedia surfaces the actual person, then plain subject
    const searchTerms = isRoleQuery ? [`current ${subject}`, subject] : [subject];

    for (const term of searchTerms) {
      const searchRes = await fetch(
        `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(term)}&format=json&srlimit=8`,
        { timeout: 3000 }
      ).catch(() => null);
      if (!searchRes) continue;
      const searchData = await searchRes.json().catch(() => null);
      const results = searchData?.query?.search || [];
      if (!results.length) continue;

      // Fetch top 5 results in parallel — each title individually encoded (no | encoding issue)
      const pages = await Promise.all(results.slice(0, 5).map(r => _fetchWikiPage(r.title)));

      // Return first result that has a photo, isn't an office article, and looks like a person
      const personPage = pages.find(p =>
        p?.thumbnail &&
        !_isOfficeArticle(p.title || '') &&
        _looksLikePerson(p.extract || '')
      );
      if (personPage) {
        const extract = personPage.extract || '';
        const firstSentence = extract.split(/\.\s/)[0]?.trim() || '';
        const bio = extract.split(/\.\s/).slice(0, 3).join('. ').trim();
        return {
          type: 'person',
          name: personPage.title,
          imageUrl: personPage.thumbnail.source,
          subtitle: firstSentence.length > 280 ? firstSentence.slice(0, 280) + '…' : firstSentence,
          bio: bio.length > 500 ? bio.slice(0, 500) + '…' : bio,
          source: 'Wikipedia',
          sourceUrl: `https://en.wikipedia.org/wiki/${encodeURIComponent(personPage.title)}`,
        };
      }
    }

    return null;
  } catch (e) { return null; }
}

// ── Historical event / incident card ─────────────────────────────────────────
const HISTORICAL_REGEX = /\b(battle of|war of|revolution|independence|assassination|holocaust|hiroshima|nagasaki|world war|cold war|civil war|french revolution|american revolution|cuban missile|watergate|9\/11|september 11|pearl harbor|d-day|normandy|crusades|ottoman empire|roman empire|mongol|colonization|slavery|abolition|apartheid|fall of|treaty of|invasion of|siege of|partition of|great fire|black death|plague|spanish flu|boston tea party|storming of|bloody sunday|tiananmen|berlin wall|moon landing|sputnik|industrial revolution|magna carta|reformation|renaissance|bolshevik|russian revolution|chinese revolution|partition of india|great depression|stock market crash|tulip mania|space race|arms race|cold war|vietnam war|korean war|gulf war|iraq war|afghanistan war|rwandan genocide|bosnian war|falklands|suez crisis|yom kippur|six day war|arab spring|french revolution|reign of terror|age of exploration|age of discovery|manifest destiny|trail of tears|underground railroad|suffragette|women's suffrage|great wall of china|pyramids of|colosseum|hanging gardens)\b/i;

async function getHistoricalCard(query) {
  try {
    const concept = extractConcept(query);
    if (!concept || concept.length < 2) return null;
    const card = await wikiCard(concept);
    if (card) return { ...card, type: 'science' };
    const words = concept.split(/\s+/).filter(w => w.length > 2);
    if (words.length > 1) {
      const shorter = words.slice(0, 4).join(' ');
      const card2 = await wikiCard(shorter);
      if (card2) return { ...card2, type: 'science' };
    }
    return null;
  } catch { return null; }
}

// ── Art / painting card ───────────────────────────────────────────────────────
const ART_REGEX = /\b(painting|portrait|mural|fresco|sketch|drawing|artwork|sculpture|statue|tapestry|mona lisa|starry night|last supper|creation of adam|girl with a pearl earring|birth of venus|the scream|guernica|sunflowers|water lilies|da vinci|michelangelo|picasso|van gogh|rembrandt|monet|warhol|banksy|dali|raphael|botticelli|caravaggio|vermeer|renoir|manet|cézanne|kandinsky|pollock|frida kahlo|basquiat|klimt|mucha|hopper|painting by|artwork by|who painted|show me the)\b/i;

async function getArtCard(query) {
  try {
    const concept = extractConcept(query);
    if (!concept || concept.length < 2) return null;
    const card = await wikiCard(concept);
    if (card) return card;
    const words = concept.split(/\s+/).filter(w => w.length > 2);
    if (words.length > 1) {
      const shorter = words.slice(0, 3).join(' ');
      const card2 = await wikiCard(shorter);
      if (card2) return card2;
    }
    return null;
  } catch { return null; }
}

// ── Food / dish card ──────────────────────────────────────────────────────────
const FOOD_REGEX = /\b(pizza|burger|hamburger|sushi|pasta|tacos|biryani|curry|ramen|pho|steak|salmon|lobster|spaghetti|lasagna|paella|dim sum|pad thai|falafel|hummus|shawarma|kebab|samosa|naan|croissant|baguette|cheesecake|tiramisu|macarons|baklava|gelato|sashimi|tempura|kimchi|bulgogi|jerk chicken|fish and chips|bangers and mash|carbonara|risotto|osso buco|peking duck|tom yum|rendang|poutine|moussaka|dolmades|pierogi|borscht|goulash|wiener schnitzel|croissant|crepes|couscous|tagine|injera|jollof rice|egusi|piri piri|bunny chow|bobotie|mole sauce|enchiladas|quesadilla|ceviche|arepa|empanada|chimichurri|acai|brigadeiro|mantu|chapati|daal|saag|haleem|nihari|cholay|pav bhaji|dosa|idli|uttapam|national dish of|traditional food of|famous food from|cuisine of)\b/i;

async function getFoodCard(query) {
  try {
    const concept = extractConcept(query).replace(/\b(food|dish|cuisine|meal|recipe|dessert|traditional|national|famous)\b/gi, '').trim();
    if (!concept || concept.length < 2) return null;
    const card = await wikiCard(concept);
    if (card) return card;
    return null;
  } catch { return null; }
}

// ── Flag card ─────────────────────────────────────────────────────────────────
const FLAG_REGEX = /\b(flag of|flag for|national flag|what does the flag|show me the flag|country flag)\b/i;

async function getFlagCard(query) {
  try {
    const country = query
      .replace(/\b(flag of|flag for|national flag of|what does the flag of|show me the flag of|country flag of|the flag|look like)\b/gi, '')
      .replace(/\?$/, '').trim();
    if (!country || country.length < 2) return null;
    const card = await wikiCard(country + ' flag');
    if (card) return card;
    const card2 = await wikiCard(country);
    return card2;
  } catch { return null; }
}

// ── Fashion / brand / clothing card ──────────────────────────────────────────
const FASHION_REGEX = /\b(gucci|louis vuitton|chanel|prada|versace|armani|dior|hermes|burberry|balenciaga|valentino|givenchy|yves saint laurent|ysl|alexander mcqueen|vivienne westwood|ralph lauren|calvin klein|tommy hilfiger|lacoste|hugo boss|michael kors|marc jacobs|coach|kate spade|tory burch|nike|adidas|puma|new balance|under armour|converse|vans|supreme|off-white|fear of god|essentials|north face|patagonia|lululemon|zara|h&m|uniqlo|gap|levis|wrangler|diesel|true religion|fashion brand|clothing brand|luxury brand|streetwear|sneaker|shoe brand)\b/i;

// ── Animal card ───────────────────────────────────────────────────────────────

function _looksLikeAnimal(extract) {
  if (!extract) return false;
  return /\b(species|genus|family|order|class|mammal|bird|reptile|amphibian|fish|insect|arachnid|mollusk|crustacean|vertebrate|invertebrate|carnivore|herbivore|omnivore|predator|native to|habitat|domesticated|breed|subspecies|wild|animal|creature|fauna)\b/i.test(extract.slice(0, 500));
}

function _looksLikeCharacter(extract) {
  if (!extract) return false;
  return /\b(fictional character|is a character|played by|portrayed by|appears in|character in|created by|character who|superhero|supervillain|villain|protagonist|antagonist|comic book|television character|animated character|voice[d]? by)\b/i.test(extract.slice(0, 500));
}

const ANIMAL_REGEX = /\b(lion|tiger|elephant|giraffe|zebra|cheetah|leopard|jaguar|panther|gorilla|chimpanzee|orangutan|baboon|monkey|dolphin|whale|shark|octopus|jellyfish|seahorse|penguin|eagle|hawk|falcon|owl|parrot|flamingo|peacock|toucan|crocodile|alligator|iguana|python|cobra|anaconda|chameleon|bear|panda|koala|kangaroo|platypus|wolf|fox|hyena|hippo|hippopotamus|rhinoceros|rhino|antelope|gazelle|bison|buffalo|moose|deer|camel|llama|alpaca|sloth|armadillo|anteater|hedgehog|porcupine|raccoon|otter|seal|walrus|narwhal|axolotl|capybara|fennec|red panda|snow leopard|golden retriever|labrador|german shepherd|husky|bulldog|rottweiler|doberman|chihuahua|pug|corgi|dachshund|greyhound|persian cat|siamese cat|tabby|mantis shrimp|great white|blue whale|humpback|meerkat|warthog|komodo dragon|tarantula|scorpion|butterfly|dragonfly|bald eagle|hummingbird|ostrich|cassowary|kiwi bird|wolverine|badger|skunk|yak|gnu|impala|springbok|okapi|tapir|dugong|manatee|sea lion|fur seal|stingray|manta ray|hammerhead|clownfish|pufferfish|piranha|anglerfish|coelacanth|salamander|newt|gecko|monitor lizard|flying squirrel|sugar glider|echidna|quokka|wombat|tasmanian devil|pangolin|aardvark|binturong|fossa|serval|caracal|ocelot|lynx|cougar|puma|bobcat|dingo|coyote|jackal|maned wolf|african wild dog|polar bear|grizzly bear|black bear|sun bear|spectacled bear|giant panda|red fox|arctic fox|kit fox|mandrill|proboscis monkey|langur|gibbon|lemur|aye-aye|tarsier|loris|galago|manatee|beluga|orca|killer whale|sperm whale|fin whale|minke whale|bowhead whale|bottlenose dolphin|spinner dolphin|porpoise|dugong|pelican|albatross|frigate bird|booby|gannet|cormorant|puffin|tern|guillemot|razorbill|kingfisher|hornbill|macaw|cockatoo|budgerigar|lovebird|pigeon|dove|sparrow|finch|canary|robin|thrush|magpie|crow|raven|jay|starling|swift|swallow|martin|woodpecker|nuthatch|treecreeper|warbler|crane|heron|egret|stork|spoonbill|ibis|jacana|plover|sandpiper|snipe|curlew|godwit|avocet|oystercatcher|pied avocet|emu|rhea|kiwi|tinamou|secretary bird|shoebill|marabou stork|vulture|condor|lammergeier|honey badger|ratel|zorilla|polecat|mink|ermine|stoat|weasel|pine marten|fisher|wolverine|sable|civet|genet|mongoose|meerkat|suricate|fossa|numbat|quoll|bilby|bandicoot|wallaby|possum|opossum|glider|cuscus|phalanger|pygmy possum|rabbit|hare|pika|beaver|muskrat|vole|lemming|hamster|gerbil|guinea pig|chinchilla|viscacha|paca|agouti|degu|prairie dog|ground squirrel|chipmunk|marmot|groundhog|woodchuck|gopher|kangaroo rat|jerboa|springhare|springbok|gerenuk|dibatag|addax|oryx|sable antelope|roan antelope|waterbuck|reedbuck|topi|hartebeest|wildebeest|gnu|eland|kudu|bongo|nyala|bushbuck|duiker|steenbok|klipspringer|mountain goat|ibex|markhor|tahr|chamois|saiga|pronghorn|musk ox|takin|serow|goral|nilgai|gaur|banteng|kouprey|wisent|yak|water buffalo|lowland anoa|babirusa|bearded pig|pygmy hippo|chevrotain|mouse deer|peccary|tapir|rhinoceros|indian rhino|sumatran rhino|javan rhino|white rhino|black rhino|malay tapir|baird tapir|mountain tapir|malayan tapir)\b/i;

async function getAnimalCard(query) {
  try {
    // Extract the animal subject
    let subject = query;
    const intentMatch = query.match(/\b(?:what is a?n?|what are|tell me about|show me a?n?|about|facts about|information (?:on|about)|describe a?n?|how (?:big|fast|strong|smart|dangerous) (?:is|are) a?n?)\s+(?:the\s+|a\s+|an\s+)?(.+)/i);
    if (intentMatch) subject = intentMatch[1].replace(/\?$/, '').trim();
    else subject = query.replace(/^(what is|what are|tell me about|show me|about|facts about)\s+(a|an|the)?\s*/i, '').replace(/\?$/, '').trim();

    // First try searching specifically as an animal
    const searchRes = await fetch(
      `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(subject)}&format=json&srlimit=6`,
      { timeout: 3000 }
    ).catch(() => null);
    if (!searchRes) return null;
    const searchData = await searchRes.json().catch(() => null);
    const results = searchData?.query?.search || [];
    if (!results.length) return null;

    const pages = await Promise.all(results.slice(0, 5).map(r => _fetchWikiPage(r.title)));
    const animalPage = pages.find(p => p?.thumbnail && _looksLikeAnimal(p.extract || ''));
    if (!animalPage) return null;

    const extract = animalPage.extract || '';
    const description = extract.split(/\.\s/).slice(0, 3).join('. ').trim();
    // Pull a fun fact from later sentences
    const sentences = extract.split(/\.\s/);
    const funFact = sentences.find((s, i) => i > 0 && i < 6 && s.length > 30 && s.length < 180) || null;

    return {
      type: 'animal',
      name: animalPage.title,
      imageUrl: animalPage.thumbnail.source,
      description: description.length > 400 ? description.slice(0, 400) + '…' : description,
      funFact: funFact ? funFact.trim() + '.' : null,
      source: 'Wikipedia',
      sourceUrl: `https://en.wikipedia.org/wiki/${encodeURIComponent(animalPage.title)}`,
    };
  } catch (e) { return null; }
}

// ── Character card ─────────────────────────────────────────────────────────────

const CHARACTER_REGEX = /\b(from|in|on)\b.{1,60}\b(movie|film|show|series|season|episode|netflix|hbo|disney|marvel|dc comics|anime|avengers|star wars|game of thrones|breaking bad|sopranos|squid game|stranger things|peaky blinders|mandalorian|dune|batman|spider.?man|iron man|harry potter|lord of the rings|the wire|succession|yellowstone|power|euphoria)\b/i;

async function getCharacterCard(query) {
  try {
    let subject = query;
    const intentMatch = query.match(/\b(?:who is|tell me about|show me|about|character)\s+(?:the\s+|a\s+|an\s+)?(.+)/i);
    if (intentMatch) subject = intentMatch[1].replace(/\?$/, '').trim();

    // Try "[character name] character" to surface the fictional article
    const searchTerms = [subject, `${subject} fictional character`, `${subject} character`];

    for (const term of searchTerms) {
      const searchRes = await fetch(
        `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(term)}&format=json&srlimit=6`,
        { timeout: 3000 }
      ).catch(() => null);
      if (!searchRes) continue;
      const searchData = await searchRes.json().catch(() => null);
      const results = searchData?.query?.search || [];
      if (!results.length) continue;

      const pages = await Promise.all(results.slice(0, 5).map(r => _fetchWikiPage(r.title)));
      const charPage = pages.find(p => p?.thumbnail && _looksLikeCharacter(p.extract || ''));
      if (!charPage) continue;

      const extract = charPage.extract || '';
      const firstSentence = extract.split(/\.\s/)[0]?.trim() || '';
      const description = extract.split(/\.\s/).slice(0, 3).join('. ').trim();

      // Try to extract the show/movie name
      const showMatch = extract.match(/\bin\b.{1,10}([\w\s:'"-]{3,40}?)(?:,|\.|by)/i);
      const showName = showMatch?.[1]?.trim() || null;

      return {
        type: 'character',
        name: charPage.title,
        imageUrl: charPage.thumbnail.source,
        subtitle: firstSentence.length > 200 ? firstSentence.slice(0, 200) + '…' : firstSentence,
        description: description.length > 400 ? description.slice(0, 400) + '…' : description,
        showName,
        source: 'Wikipedia',
        sourceUrl: `https://en.wikipedia.org/wiki/${encodeURIComponent(charPage.title)}`,
      };
    }
    return null;
  } catch (e) { return null; }
}

// Image from Wikipedia
async function getImageCard(query) {
  try {
    const search = await fetch(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=1`, { timeout: 1500 });
    const sd = await search.json();
    const title = sd?.query?.search?.[0]?.title;
    if (!title) return null;
    const img = await fetch(`https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=pageimages|extracts&exintro&explaintext&pithumbsize=600&format=json`, { timeout: 1500 });
    const id = await img.json();
    const pages = id?.query?.pages;
    const page = pages[Object.keys(pages)[0]];
    if (!page?.thumbnail?.source) return null;
    return {
      type: 'image',
      title: page.title,
      imageUrl: page.thumbnail.source,
      description: page.extract?.slice(0, 200).trim() || '',
      source: 'Wikipedia',
      sourceUrl: `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title)}`,
    };
  } catch (e) { return null; }
}

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'identity',
};

const SPORTS_REGEX = /\b(score|scoreline|result|match|game|vs\.?|versus|goal|goals|won|beat|cricket|football|soccer|basketball|tennis|f1|formula.?1|nba|nfl|premier.?league|champions.?league|world.?cup|wicket|century|innings|odi|test.?match|t20|grand.?slam|motm|man of the match|next match|upcoming)\b/i;

// ESPN — search across recent dates for any sport/league
async function espnFindMatch(query, sport, league) {
  const vsMatch = query.match(/(.+?)\s+(?:vs?\.?|versus|against)\s+(.+)/i);
  const words = vsMatch
    ? [vsMatch[1].trim().toLowerCase(), vsMatch[2].trim().toLowerCase()]
    : query.toLowerCase().split(/\s+/).filter(w => w.length > 3);

  // Search today + past 21 days + next 7 days
  const dates = [];
  const today = new Date();
  for (let i = -7; i <= 21; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().slice(0, 10).replace(/-/g, ''));
  }

  for (const date of dates) {
    try {
      const url = `https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/scoreboard?dates=${date}`;
      const res = await fetch(url, { timeout: 1500 });
      if (!res.ok) continue;
      const data = await res.json();
      const events = data?.events || [];

      for (const ev of events) {
        const comps = ev.competitions?.[0];
        if (!comps) continue;
        const teamNames = comps.competitors?.map(c => c.team.displayName.toLowerCase()) || [];
        const matched = words.length >= 2
          ? words.slice(0, 2).every(w => teamNames.some(t => t.includes(w.slice(0, 5)) || w.slice(0, 5).length > 2 && t.split(' ').some(p => w.includes(p.slice(0, 4)))))
          : words.some(w => teamNames.some(t => t.includes(w.slice(0, 5))));
        if (!matched) continue;

        const completed = ev.status?.type?.completed === true;
        const inProgress = ev.status?.type?.type === 'STATUS_IN_PROGRESS';
        const scheduled = !completed && !inProgress;

        const home = comps.competitors?.find(c => c.homeAway === 'home');
        const away = comps.competitors?.find(c => c.homeAway === 'away');
        const score1 = scheduled ? '–' : (home?.score ?? '?');
        const score2 = scheduled ? '–' : (away?.score ?? '?');
        const statusLabel = scheduled
          ? `Upcoming — ${new Date(comps.date).toUTCString()}`
          : inProgress ? 'LIVE' : 'Full Time';

        // Fetch detailed summary for scorers + MOTM
        let scorers = [];
        let motm = null;
        try {
          const sumRes = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/summary?event=${ev.id}`, { timeout: 1500 });
          if (sumRes.ok) {
            const sum = await sumRes.json();
            // Scoring plays
            (sum.scoringPlays || []).forEach(p => {
              const player = p.athletesInvolved?.[0]?.displayName || '';
              const clock = p.clock?.displayValue || '';
              const team = p.team?.displayName || '';
              if (player) scorers.push({ team, detail: `${player} ${clock}`.trim() });
            });
            // MOTM / Player of the match
            (sum.awards || []).forEach(a => {
              if (/man.of.the.match|player.of.the.match|motm/i.test(a.name || '')) {
                motm = a.winners?.[0]?.athlete?.displayName || a.winners?.[0]?.displayName || null;
              }
            });
          }
        } catch (_) {}

        return {
          type: 'sports',
          team1: home?.team?.displayName || '',
          score1: String(score1),
          score2: String(score2),
          team2: away?.team?.displayName || '',
          logo1: home?.team?.logo || home?.team?.logos?.[0]?.href || home?.team?.logoDark || null,
          logo2: away?.team?.logo || away?.team?.logos?.[0]?.href || away?.team?.logoDark || null,
          league: data.leagues?.[0]?.name || league,
          date: comps.date?.slice(0, 10) || '',
          venue: comps.venue?.fullName || '',
          status: statusLabel,
          scorers,
          motm,
          headline: scheduled
            ? `${home?.team?.displayName} vs ${away?.team?.displayName} — Not started yet`
            : `${home?.team?.displayName} ${score1} - ${score2} ${away?.team?.displayName}`,
          source: 'ESPN',
          sourceUrl: `https://www.espn.com/${sport}/match?gameId=${ev.id}`,
        };
      }
    } catch (_) { continue; }
  }
  return null;
}

async function espnSportsSearch(query) {
  const leagues = [
    ['soccer', 'fifa.world'],
    ['soccer', 'uefa.champions'],
    ['soccer', 'uefa.euro'],
    ['soccer', 'eng.1'],
    ['soccer', 'esp.1'],
    ['soccer', 'ger.1'],
    ['soccer', 'ita.1'],
    ['soccer', 'fra.1'],
    ['basketball', 'nba'],
    ['football', 'nfl'],
    ['baseball', 'mlb'],
    ['hockey', 'nhl'],
  ];
  for (const [sport, league] of leagues) {
    const result = await espnFindMatch(query, sport, league);
    if (result) return result;
  }
  return null;
}

// ESPN — search across all relevant leagues including World Cup
async function espnSportsSearch(query) {
  const leagues = [
    ['soccer', 'fifa.world'],       // FIFA World Cup 2026
    ['soccer', 'fifa.worldq.concacaf'],
    ['soccer', 'fifa.worldq.uefa'],
    ['soccer', 'uefa.champions'],
    ['soccer', 'uefa.euro'],
    ['soccer', 'eng.1'],            // Premier League
    ['soccer', 'esp.1'],            // La Liga
    ['soccer', 'ger.1'],            // Bundesliga
    ['soccer', 'ita.1'],            // Serie A
    ['soccer', 'fra.1'],            // Ligue 1
    ['basketball', 'nba'],
    ['football', 'nfl'],
    ['baseball', 'mlb'],
    ['hockey', 'nhl'],
    ['cricket', 'icc.cricket_test'],
  ];

  const vsMatch = query.match(/(.+?)\s+(?:vs?\.?|versus|against)\s+(.+)/i);
  const words = vsMatch
    ? [vsMatch[1].trim().toLowerCase(), vsMatch[2].trim().toLowerCase()]
    : query.toLowerCase().split(/\s+/).filter(w => w.length > 3);

  for (const [sport, league] of leagues) {
    try {
      const url = `https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/scoreboard`;
      const res = await fetch(url, { timeout: 6000 });
      if (!res.ok) continue;
      const data = await res.json();
      const events = data?.events || [];

      for (const ev of events) {
        const comps = ev.competitions?.[0];
        if (!comps) continue;
        const teamNames = comps.competitors?.map(c => c.team.displayName.toLowerCase()) || [];
        const matchesQuery = words.every(w => teamNames.some(t => t.includes(w.slice(0, 5)) || w.includes(t.slice(0, 5))));
        if (!matchesQuery) continue;

        const completed = ev.status?.type?.completed === true;
        const inProgress = ev.status?.type?.type === 'STATUS_IN_PROGRESS';
        const scheduled = !completed && !inProgress;

        const home = comps.competitors?.find(c => c.homeAway === 'home');
        const away = comps.competitors?.find(c => c.homeAway === 'away');

        const score1 = scheduled ? '–' : (home?.score ?? '0');
        const score2 = scheduled ? '–' : (away?.score ?? '0');

        let statusLabel = scheduled
          ? `Upcoming — ${new Date(comps.date).toUTCString()}`
          : inProgress ? `LIVE — ${ev.status?.displayClock || ''}`
          : 'Full Time';

        const scorers = [];
        (comps.details || []).forEach(d => {
          const typeText = d.type?.text || '';
          if (/goal|touchdown|score|basket/i.test(typeText)) {
            const player = d.athletesInvolved?.[0]?.displayName || '';
            const clock = d.clock?.displayValue || '';
            if (player) scorers.push({ team: d.team?.displayName || '', detail: `${player} ${clock}`.trim() });
          }
        });

        return {
          type: 'sports',
          team1: home?.team?.displayName || '',
          score1: String(score1),
          score2: String(score2),
          team2: away?.team?.displayName || '',
          logo1: home?.team?.logo || home?.team?.logos?.[0]?.href || home?.team?.logoDark || null,
          logo2: away?.team?.logo || away?.team?.logos?.[0]?.href || away?.team?.logoDark || null,
          league: data.leagues?.[0]?.name || league,
          date: comps.date?.slice(0, 10) || '',
          venue: comps.venue?.fullName || '',
          status: statusLabel,
          scorers,
          headline: scheduled
            ? `${home?.team?.displayName} vs ${away?.team?.displayName} — Not started yet`
            : `${home?.team?.displayName} ${score1} - ${score2} ${away?.team?.displayName}`,
          source: 'ESPN',
          sourceUrl: `https://www.espn.com/${sport}/game/_/gameId/${ev.id}`,
        };
      }
    } catch (_) {}
  }
  return null;
}

// Scrape Google search for a sports score — most up-to-date fallback
async function googleSportsScore(query) {
  try {
    const searchQ = encodeURIComponent(query + ' final score 2026');
    const res = await fetch(`https://www.google.com/search?q=${searchQ}&hl=en&gl=us`, {
      headers: BROWSER_HEADERS, timeout: 9000,
    });
    if (!res.ok) return null;
    const html = await res.text();

    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ');

    const vsMatch = query.match(/(.+?)\s+(?:vs?\.?|versus|against)\s+(.+)/i);
    const q1 = vsMatch ? vsMatch[1].trim().toLowerCase() : '';
    const q2 = vsMatch ? vsMatch[2].trim().toLowerCase() : '';

    // Multiple score patterns Google uses
    const patterns = [
      /([A-Za-zÀ-ɏ][A-Za-zÀ-ɏ\s]{1,25}?)\s+(\d{1,3})\s*[-–:]\s*(\d{1,3})\s+([A-Za-zÀ-ɏ][A-Za-zÀ-ɏ\s]{1,25})/g,
      /(\d{1,3})\s*[-–]\s*(\d{1,3})/g,
    ];

    let best = null;
    const re = patterns[0];
    let m;
    while ((m = re.exec(text)) !== null) {
      const t1 = m[1].trim(), s1 = m[2], s2 = m[3], t2 = m[4].trim();
      if (t1.length < 2 || t2.length < 2 || t1.length > 35 || t2.length > 35) continue;
      if (/^\d/.test(t1) || /^\d/.test(t2)) continue;
      const t1l = t1.toLowerCase(), t2l = t2.toLowerCase();
      const relevant = (q1 && (t1l.includes(q1.slice(0,4)) || q1.slice(0,4) && t1l.includes(q1.slice(0,4)))) ||
                       (q2 && (t2l.includes(q2.slice(0,4)) || q2.slice(0,4) && t2l.includes(q2.slice(0,4))));
      if (relevant) { best = { team1: t1, score1: s1, score2: s2, team2: t2 }; break; }
      if (!best) best = { team1: t1, score1: s1, score2: s2, team2: t2 };
    }

    if (!best) return null;

    let status = 'Full Time';
    const statusM = text.match(/\b(Full[\s-]?Time|FT|Half[\s-]?Time|HT|LIVE|Postponed|AET|Pen(?:alties)?)\b/i);
    if (statusM) status = statusM[0];

    const scorers = [];
    const scorerRe = /([A-Z][a-záéíóúñ]+(?:\s[A-Z][a-záéíóúñ]+)*)\s+(\d{1,3})['′]/g;
    let sm;
    while ((sm = scorerRe.exec(text)) !== null && scorers.length < 10) {
      scorers.push({ team: '', detail: `${sm[1]} ${sm[2]}'` });
    }

    return {
      type: 'sports',
      team1: best.team1, score1: best.score1, score2: best.score2, team2: best.team2,
      league: '', date: '', venue: '', status, scorers,
      headline: `${best.team1} ${best.score1} - ${best.score2} ${best.team2}`,
      source: 'Google', sourceUrl: `https://www.google.com/search?q=${encodeURIComponent(query + ' score')}`,
    };
  } catch (e) { return null; }
}

// Get context snippet from Google when no score card found
async function googleMatchContext(query) {
  try {
    const res = await fetch(`https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en&gl=us`, {
      headers: BROWSER_HEADERS, timeout: 7000,
    });
    if (!res.ok) return null;
    const html = await res.text();
    const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    if (/did not match any documents|No results found/i.test(text)) return 'NO_RESULTS';
    // Find relevant snippet
    const q1 = query.toLowerCase().split(/\s+/)[0];
    const idx = text.toLowerCase().indexOf(q1);
    return idx >= 0 ? text.slice(Math.max(0, idx - 30), idx + 400).trim() : text.slice(200, 600).trim();
  } catch (e) { return null; }
}

// Movie card — OMDB free API (no key needed for basic search) + TMDB fallback
async function getMovieCard(query) {
  try {
    // Strip filler words to get the movie title
    const title = query
      .replace(/when (is|does|will)?|coming out|release date|out|movie|film|sequel|new|latest|upcoming|show me|tell me about|about the|the new|trailer/gi, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (!title || title.length < 2) return null;

    // OMDB free tier — 1000 req/day, no key needed for search endpoint
    const omdbUrl = `https://www.omdbapi.com/?apikey=trilogy&t=${encodeURIComponent(title)}&plot=short`;
    const omdbRes = await fetch(omdbUrl, { timeout: 3000 });
    const omdb = await omdbRes.json();

    if (omdb.Response === 'True') {
      return {
        type: 'movie',
        title: omdb.Title,
        year: omdb.Year,
        rated: omdb.Rated,
        released: omdb.Released,
        runtime: omdb.Runtime,
        genre: omdb.Genre,
        director: omdb.Director,
        cast: omdb.Actors,
        plot: omdb.Plot,
        poster: omdb.Poster !== 'N/A' ? omdb.Poster : null,
        imdbRating: omdb.imdbRating !== 'N/A' ? omdb.imdbRating : null,
        imdbId: omdb.imdbID,
        sourceUrl: omdb.imdbID ? `https://www.imdb.com/title/${omdb.imdbID}/` : null,
        source: 'IMDb / OMDB',
      };
    }

    // Fallback: TMDB public search (no API key for search)
    const tmdbUrl = `https://api.themoviedb.org/3/search/movie?api_key=8265bd1679663a7ea12ac168da84d2e8&query=${encodeURIComponent(title)}&language=en-US&page=1`;
    const tmdbRes = await fetch(tmdbUrl, { timeout: 3000 });
    const tmdb = await tmdbRes.json();
    const hit = tmdb.results?.[0];
    if (!hit) return null;

    return {
      type: 'movie',
      title: hit.title,
      year: hit.release_date ? hit.release_date.slice(0, 4) : '',
      released: hit.release_date || '',
      plot: hit.overview,
      poster: hit.poster_path ? `https://image.tmdb.org/t/p/w300${hit.poster_path}` : null,
      imdbRating: hit.vote_average ? hit.vote_average.toFixed(1) : null,
      genre: '',
      director: '',
      cast: '',
      sourceUrl: `https://www.themoviedb.org/movie/${hit.id}`,
      source: 'TMDB',
    };
  } catch (e) { return null; }
}

// Private companies — explicitly null so we never try to resolve them
const PRIVATE_COMPANIES = new Set([
  'openai', 'open ai', 'stripe', 'klarna', 'revolut',
  'chime', 'databricks', 'canva', 'bytedance', 'tiktok', 'shein', 'cargill',
  'ikea', 'publix', 'mars', 'deloitte', 'mckinsey', 'bain', 'bcg',
  'huawei', 'xiaomi', 'didi', 'grab', 'gojek', 'ola', 'swiggy', 'zomato',
]);

// Map of common names → Yahoo Finance tickers
const TICKER_MAP = {
  // Tech
  apple: 'AAPL', microsoft: 'MSFT', google: 'GOOGL', alphabet: 'GOOGL',
  amazon: 'AMZN', meta: 'META', facebook: 'META', netflix: 'NFLX',
  tesla: 'TSLA', nvidia: 'NVDA', amd: 'AMD', intel: 'INTC',
  samsung: '005930.KS', sony: 'SONY', qualcomm: 'QCOM',
  'take-two': 'TTWO', 'take two': 'TTWO', 'rockstar': 'TTWO', 'ttwo': 'TTWO', 't two': 'TTWO',
  'electronic arts': 'EA', 'ea games': 'EA', activision: 'ATVI',
  'ubisoft': 'UBSFY', 'square enix': 'SQNNY',
  // Finance
  jpmorgan: 'JPM', 'jp morgan': 'JPM', 'goldman sachs': 'GS',
  visa: 'V', mastercard: 'MA', paypal: 'PYPL', stripe: null,
  // Consumer
  disney: 'DIS', 'coca cola': 'KO', 'coke': 'KO', pepsi: 'PEP',
  mcdonalds: 'MCD', nike: 'NKE', adidas: 'ADDYY', starbucks: 'SBUX',
  walmart: 'WMT', target: 'TGT',
  // Crypto
  bitcoin: 'BTC-USD', btc: 'BTC-USD',
  ethereum: 'ETH-USD', eth: 'ETH-USD',
  bnb: 'BNB-USD', binance: 'BNB-USD',
  solana: 'SOL-USD', sol: 'SOL-USD',
  cardano: 'ADA-USD', ada: 'ADA-USD',
  xrp: 'XRP-USD', ripple: 'XRP-USD',
  dogecoin: 'DOGE-USD', doge: 'DOGE-USD',
  polkadot: 'DOT-USD', dot: 'DOT-USD',
  avalanche: 'AVAX-USD', avax: 'AVAX-USD',
  polygon: 'MATIC-USD', matic: 'MATIC-USD',
  litecoin: 'LTC-USD', ltc: 'LTC-USD',
  chainlink: 'LINK-USD', link: 'LINK-USD',
  shiba: 'SHIB-USD', shib: 'SHIB-USD',
  uniswap: 'UNI-USD', uni: 'UNI-USD',
  stellar: 'XLM-USD', xlm: 'XLM-USD',
  tron: 'TRX-USD', trx: 'TRX-USD',
};

const STOCK_KEYWORDS = /\b(stock|share|shares|price|invest|market|nasdaq|nyse|crypto|cryptocurrency|coin|token|trading|chart|value|worth|valuation|how much is|how much are|what is .+ worth|what is .+ trading)\b/i;

async function fetchCardData(query) {
  return _cached(`card:${query}`, () => _fetchCardDataInner(query), 45000);
}
async function _fetchCardDataInner(query) {
  const q = query.toLowerCase();

  // Stock / crypto detection
  if (STOCK_KEYWORDS.test(q) || /\b(bitcoin|ethereum|crypto|btc|eth|sol|doge|bnb|xrp|stock|shares?|ticker)\b/i.test(q)) {
    // Check if the user is asking about a known private company — return null immediately
    for (const priv of PRIVATE_COMPANIES) {
      if (q.includes(priv)) return { type: 'private_company', name: priv.split(' ').map(w => w[0].toUpperCase() + w.slice(1)).join(' ') };
    }

    // 1. Check known name map first
    let symbol = null;
    for (const [name, ticker] of Object.entries(TICKER_MAP)) {
      if (q.includes(name) && ticker) { symbol = ticker; break; }
    }

    // 2. Try to extract a ticker (ALL CAPS 1-5 letters) from the query
    if (!symbol) {
      const hyphenSpelled = query.match(/\b([A-Z](?:-[A-Z]){1,4})\b/);
      if (hyphenSpelled) {
        const collapsed = hyphenSpelled[1].replace(/-/g, '');
        if (collapsed.length >= 2 && collapsed.length <= 5) symbol = collapsed;
      }
    }
    if (!symbol) {
      const tickerMatch = query.match(/\b([A-Z]{2,5}(?:-USD)?)\b/);
      if (tickerMatch) symbol = tickerMatch[1];
    }

    // 3. Fall back to Yahoo Finance symbol search for the full query
    if (!symbol) {
      const nameGuess = query
        .replace(/what (is|are|'s) (the )?(current |live )?(stock |share |crypto )?(price|value|worth|cost) (of |for )?/gi, '')
        .replace(/\b(stock|share|shares|price|value|worth|crypto|cryptocurrency|coin|token|current|live|trading|today|how much|find me|find|the|for)\b/gi, '')
        .trim();
      if (nameGuess.length > 1) {
        const resolved = await resolveTickerSymbol(nameGuess);
        if (resolved) {
          // Validate: fetch the card and check the company name roughly matches the query term
          const card = await getStockCard(resolved);
          if (card) {
            const cardNameLower = (card.name || '').toLowerCase();
            const queryTerms = nameGuess.toLowerCase().split(/\s+/).filter(w => w.length > 2);
            const matches = queryTerms.some(t => cardNameLower.includes(t));
            if (matches) return card;
          }
          return null;
        }
      }
    }

    if (symbol) return await getStockCard(symbol);
  }

  // Sports scores — ESPN (World Cup + all leagues) then Google
  if (/match|score|game|vs|versus|goal|cricket|football|soccer|basketball|tennis|premier league|champions league|world cup|nba|nfl|f1/i.test(q)) {
    const espn = await espnSportsSearch(query);
    if (espn) return espn;
    return await googleSportsScore(query);
  }

  // Movie queries — show movie info card
  if (/\b(movie|film|cinema|sequel|prequel|release date|coming out|when (is|does|will|does)|box office|cast|director|plot|trailer|watch)\b/i.test(q)) {
    const card = await getMovieCard(query);
    if (card) return card;
  }

  // Places / business search — "best pizza in Lahore", "bowling alley in LA"
  if (PLACES_SEARCH_REGEX.test(q)) {
    const card = await getPlacesCard(query);
    if (card) return card;
  }

  // Company financial analytics — must run before person/image to prevent wrong Wikipedia cards
  if (COMPANY_FINANCE_REGEX.test(q)) {
    const card = await getCompanyFinanceCard(query);
    if (card) return card;
  }

  // Location / place / landmark — any query mentioning a place, even parks and local spots
  const LOCATION_TRIGGER = /\b(show me|pictures? of|photos? of|images? of|visit|travel to|explore|tell me about|about|what('s| is)|where is|how big is|what does .{0,30} look like|info on|overview of|facts about)\b.{0,80}\b(park|garden|beach|mountain|lake|river|forest|valley|canyon|island|desert|waterfall|bridge|tower|castle|palace|cathedral|mosque|temple|church|stadium|square|plaza|street|avenue|boulevard|district|neighbourhood|neighborhood|quarter|area|city|country|capital|town|village|landmark|monument|bay|harbor|harbour|cliff|hill|peninsula|coast|shore|reserve|nature reserve|national park|botanical|zoo|museum|gallery|arena|amphitheatre)\b|\b(show me|pictures? of|photos? of|images? of|visit|travel to|explore|tell me about)\b/i;
  if (LOCATION_TRIGGER.test(q) && !COMPANY_FINANCE_REGEX.test(q) && !PLACES_SEARCH_REGEX.test(q)) {
    const card = await getLocationCard(query);
    if (card) return card;
  }

  // Flag queries
  if (FLAG_REGEX.test(q)) {
    const card = await getFlagCard(query);
    if (card) return card;
  }

  // Art / painting queries
  if (ART_REGEX.test(q)) {
    const card = await getArtCard(query);
    if (card) return card;
  }

  // Food / dish queries
  if (FOOD_REGEX.test(q)) {
    const card = await getFoodCard(query);
    if (card) return card;
  }

  // Animal queries — show species photo + description card
  // Also catches "show me a pangolin", "what does a quetzal look like", "tell me about a snow leopard" etc.
  const ANIMAL_INTENT_REGEX = /\b(show me a?n?|what (is|are|does) a?n?|tell me about a?n?|facts about a?n?|pictures? of a?n?|photos? of a?n?|how (big|fast|dangerous|smart|strong) is a?n?|describe a?n?|what does a?n? .{0,20} look like)\b/i;
  if (ANIMAL_REGEX.test(q) || (ANIMAL_INTENT_REGEX.test(q) && /\b(animal|bird|fish|insect|reptile|mammal|amphibian|creature|species|wildlife|predator|prey)\b/i.test(q))) {
    const card = await getAnimalCard(query);
    if (card) return card;
  }

  // Fashion / brand queries — show brand/logo card via Wikipedia
  if (FASHION_REGEX.test(q)) {
    const concept = extractConcept(query);
    const card = await wikiCard(concept);
    if (card) return card;
  }

  // Fictional character queries — show character photo card
  if (!COMPANY_FINANCE_REGEX.test(q) && (CHARACTER_REGEX.test(q) || /\bwho is\b|\bwho('s| is) (the |a )?\b|\btell me about\b/i.test(q))) {
    const charCard = await getCharacterCard(query);
    if (charCard) return charCard;
  }

  // Person queries — show photo + bio card (exclude financial/location queries)
  // Covers: who is/was, tell me about, show me, photo/picture/biography of, plus direct celebrity names
  if (!COMPANY_FINANCE_REGEX.test(q) && /\bwho is\b|\bwho('s| is) (the |a )?\b|\bwho was\b|\btell me about\b|\bshow me\b|\bbiography of\b|\bphoto of\b|\bpicture of\b|\bactor\b|\bactress\b|\bsinger\b|\brappper\b|\bmusician\b|\bpresident\b|\bprime minister\b|\bpolitician\b|\bfounder\b|\bceo\b|\bdirector\b|\bscientist\b|\binventor\b|\bhistorical figure\b|\bwho played\b|\bplayed by\b/i.test(q)) {
    const card = await getPersonCard(query);
    if (card) return card;
  }

  // Historical events / incidents
  if (HISTORICAL_REGEX.test(q)) {
    const card = await getHistoricalCard(query);
    if (card) return card;
  }

  // Image — car, painting, place, artwork (exclude financial queries)
  if (!COMPANY_FINANCE_REGEX.test(q) && !PLACES_SEARCH_REGEX.test(q) && /car|vehicle|painting|artwork|portrait|photo|picture|image|what does|show me/i.test(q)) {
    const subject = query.replace(/show me|what does|photo of|picture of|image of/gi, '').trim();
    return await getImageCard(subject);
  }

  // Science keywords
  if (SCIENCE_REGEX.test(q)) {
    const card = await getScienceCard(query);
    if (card) return card;
  }

  // Catch-all: any conceptual / educational question → try Wikipedia (skip financial/business queries)
  if (!COMPANY_FINANCE_REGEX.test(q) && !PLACES_SEARCH_REGEX.test(q) && /\b(what is|what are|what was|what were|explain|describe|how does|how do|how is|why is|why does|define|tell me about|teach me|history of)\b/i.test(q)) {
    const card = await getScienceCard(query);
    if (card) return card;
  }

  // ── Object image catch-all ────────────────────────────────────────────────────
  // "show me a picture of a sofa", "what does a Lamborghini look like", "show me a helicopter"
  const OBJECT_IMAGE_REGEX = /\b(show me|show me a|show me an|picture of|pictures of|photo of|photos of|image of|images of|what does .{0,40} look like|what do .{0,40} look like|can you show me|i want to see)\b/i;
  if (OBJECT_IMAGE_REGEX.test(q) && !COMPANY_FINANCE_REGEX.test(q)) {
    // Extract the object name by stripping the intent phrase
    const subject = query
      .replace(/\b(show me a picture of|show me pictures of|show me a photo of|show me photos of|show me an? image of|show me an?|show me|picture of|pictures of|photo of|photos of|image of|images of|can you show me an?|can you show me|i want to see an?|i want to see|what does|what do|look like)\b/gi, '')
      .replace(/\b(a|an|the|some|me)\b/gi, '')
      .replace(/[?!.]+$/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (subject.length >= 2) {
      // Try wikiCard first (has richer data), fallback to searchImages
      const card = await wikiCard(subject).catch(() => null) || await searchImages(subject).catch(() => null);
      if (card && (card.imageUrl || card.heroImage || card.thumbnail)) return card;
      // searchImages always has imageUrl if it found something
      if (card) return card;
    }
  }

  return null;
}

// ── Live news feed system — BBC RSS (free, no API key) ────────────────────────
const NEWS_FEEDS = {
  world:      'https://feeds.bbci.co.uk/news/world/rss.xml',
  business:   'https://feeds.bbci.co.uk/news/business/rss.xml',
  technology: 'https://feeds.bbci.co.uk/news/technology/rss.xml',
  science:    'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml',
  sport:      'https://feeds.bbci.co.uk/sport/rss.xml',
  politics:   'https://feeds.bbci.co.uk/news/politics/rss.xml',
  us:         'https://feeds.bbci.co.uk/news/us_and_canada/rss.xml',
  health:     'https://feeds.bbci.co.uk/news/health/rss.xml',
};

let _newsCache = { data: {}, ts: 0 };
const NEWS_CACHE_TTL = 20 * 60 * 1000; // 20 minutes

function _withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}

async function _fetchRSSFeed(url) {
  try {
    const res = await _timedFetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, 3000);
    if (!res.ok) return [];
    const xml = await res.text();
    const items = xml.split('<item>').slice(1);
    return items.slice(0, 6).map(item => {
      const m = item.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
      return m ? m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim() : null;
    }).filter(Boolean);
  } catch { return []; }
}

async function fetchNewsFeeds() {
  const now = Date.now();
  if (now - _newsCache.ts < NEWS_CACHE_TTL && Object.keys(_newsCache.data).length > 0) {
    return _newsCache.data;
  }
  const entries = Object.entries(NEWS_FEEDS);
  // Each feed has its own 3.5s timeout — the overall fetch never blocks longer than that
  const results = await Promise.all(entries.map(([, url]) => _fetchRSSFeed(url)));
  const data = {};
  entries.forEach(([cat], i) => { data[cat] = results[i]; });
  _newsCache = { data, ts: now };
  return data;
}

async function getNewsContext(query) {
  const q = (query || '').toLowerCase();
  let data;
  // If cache is already populated return immediately, otherwise give news fetch max 4s
  try {
    const feedPromise = fetchNewsFeeds();
    data = await ((_newsCache.ts > 0) ? feedPromise : _withTimeout(feedPromise, 4000));
  } catch { return null; }

  // Pick categories relevant to the query
  const cats = [];
  if (/sport|football|soccer|basketball|cricket|tennis|nfl|nba|f1|formula|racing|match|score|game|player|team|league|cup|tournament/i.test(q)) cats.push('sport');
  if (/tech|technology|ai |artificial intelligence|software|app|startup|silicon|computer|phone|robot|cyber|hack|gadget/i.test(q)) cats.push('technology');
  if (/scienc|physic|chemist|biolog|space|nasa|research|study|discover|experiment|climate|environment|nature/i.test(q)) cats.push('science');
  if (/stock|market|financ|economy|business|revenue|profit|company|trade|gdp|inflation|fed |bank|invest|earn|crypto|bitcoin/i.test(q)) cats.push('business');
  if (/politic|president|prime minister|election|government|congress|senate|parliament|vote|policy|law|democrat|republican|labour|tory/i.test(q)) cats.push('politics', 'us');
  if (/health|hospital|medicine|drug|disease|cancer|covid|flu|mental|nhs|medical/i.test(q)) cats.push('health');
  if (/war|conflict|ukraine|russia|china|middle east|israel|iran|nato|military|attack|bomb|sanction|protest|coup/i.test(q)) cats.push('world');
  if (/news|latest|today|yesterday|this week|right now|recently|breaking|what happened|update|current event/i.test(q)) cats.push('world', 'business', 'politics');

  // Always include world as base
  if (!cats.includes('world')) cats.push('world');

  const seen = new Set();
  const headlines = [];
  for (const cat of [...new Set(cats)]) {
    for (const title of (data[cat] || []).slice(0, 3)) {
      if (!seen.has(title)) { seen.add(title); headlines.push(`[${cat.toUpperCase()}] ${title}`); }
    }
  }
  if (!headlines.length) return null;

  const today = new Date().toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  return `LIVE NEWS HEADLINES — ${today}:\n${headlines.join('\n')}\n\nUse these headlines to answer questions about current events. If the user asks about something covered here, reference it accurately.`;
}

// ── Wikimedia Commons image search — richer image results ────────────────────
async function searchImages(query) {
  try {
    const res = await _timedFetch(
      `https://en.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(query)}&gsrlimit=1&prop=pageimages|extracts&exintro&explaintext&pithumbsize=500&format=json`,
      { headers: { 'User-Agent': 'CallistoAI/1.0' } }, 2500
    );
    if (!res.ok) return null;
    const data = await res.json();
    const pages = Object.values(data?.query?.pages || {});
    const page = pages[0];
    if (!page) return null;
    return {
      type: 'wiki_card',
      title: page.title,
      imageUrl: page.thumbnail?.source || null,
      description: (page.extract || '').slice(0, 250),
      source: 'Wikipedia',
      sourceUrl: `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title)}`,
    };
  } catch { return null; }
}

module.exports = { fetchRealtimeContext, fetchCardData, SPORTS_REGEX, getStockCard, resolveTickerSymbol, SCIENCE_REGEX, ELEMENTS, COMPANY_FINANCE_REGEX, getCompanyFinanceCard, fetchNewsFeeds, getNewsContext, PLACES_SEARCH_REGEX, getPlacesCard, getLocationCard, ANIMAL_REGEX, CHARACTER_REGEX, HISTORICAL_REGEX, ART_REGEX, FOOD_REGEX, FLAG_REGEX, FASHION_REGEX, searchImages };
