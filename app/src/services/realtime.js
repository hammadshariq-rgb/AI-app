const fetch = require('node-fetch');

// Weather via wttr.in — free, no API key
async function getWeather(location) {
  try {
    const res = await fetch(`https://wttr.in/${encodeURIComponent(location)}?format=j1`, { timeout: 2500 });
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

// DuckDuckGo Instant Answers — free, no API key
async function ddgSearch(query) {
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const res = await fetch(url, { timeout: 2500 });
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
    const search = await fetch(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=1`, { timeout: 2500 });
    const searchData = await search.json();
    const title = searchData?.query?.search?.[0]?.title;
    if (!title) return null;
    const summary = await fetch(`https://en.wikipedia.org/w/api.php?action=query&prop=extracts&exintro&explaintext&titles=${encodeURIComponent(title)}&format=json`, { timeout: 2500 });
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
    const res = await fetch(`https://news.google.com/rss/search?q=${query}&hl=en-US&gl=US&ceid=US:en`, { timeout: 2500 });
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

  // General factual question — always check Google first, then DuckDuckGo/Wikipedia
  const [google, ddg, wiki] = await Promise.all([
    googleFactSearch(query),
    ddgSearch(query),
    wikiSearch(query),
  ]);
  const parts = [google, ddg, wiki].filter(Boolean);
  return parts.length > 0
    ? `REAL-TIME DATA (prioritise this over your training data):\n${parts.join('\n').slice(0, 900)}`
    : null;
}

// Look up ticker symbol by company name using Yahoo Finance search
async function resolveTickerSymbol(query) {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=1&newsCount=0`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 2500 }
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
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=30d`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 6000 }
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

function formatVolume(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

// Person card — photo + name + short bio from Wikipedia
const PERSON_REGEX = /\b(who is|who('s| is) (the )?|tell me about|show me|photo of|picture of|biography of)\b.{2,60}?(minister|president|prime minister|pm|ceo|founder|king|queen|prince|princess|chancellor|senator|governor|mayor|general|admiral|director|secretary|actor|actress|singer|rapper|athlete|player|politician|leader|chef|scientist|inventor|philosopher|author|writer|poet|artist|painter|composer|conductor|director|cto|cfo|chairman|chairwoman|head of|lord|emperor|empress|prince|princess|duke|duchess|sultan|emir|ayatollah|pope|archbishop|cardinal|bishop|imam|rabbi|sheikh)/i;

const PERSON_QUERY_REGEX = /^(who is|who('s| is) the |tell me about |show me |biography of |about )/i;

async function getPersonCard(query) {
  try {
    // Clean the query to get the person's name/role
    const subject = query
      .replace(/^(who is|who's|who are|tell me about|show me|photo of|picture of|biography of|about)\s+/i, '')
      .replace(/\?$/, '')
      .trim();

    // Search Wikipedia
    const searchRes = await fetch(
      `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(subject)}&format=json&srlimit=3`,
      { timeout: 2500 }
    );
    const searchData = await searchRes.json();
    const results = searchData?.query?.search || [];
    if (!results.length) return null;

    // Pick the most relevant result (prefer exact title match, then first)
    const subjectLower = subject.toLowerCase();
    const best = results.find(r => r.title.toLowerCase().includes(subjectLower.split(' ').slice(-1)[0])) || results[0];
    const title = best.title;

    // Fetch photo + extract + categories to confirm it's a person
    const detailRes = await fetch(
      `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=pageimages|extracts|categories&exintro&explaintext&pithumbsize=400&cllimit=5&format=json`,
      { timeout: 2500 }
    );
    const detailData = await detailRes.json();
    const pages = detailData?.query?.pages;
    const page = pages[Object.keys(pages)[0]];
    if (!page || page.missing) return null;

    const extract = page.extract || '';
    // Extract first sentence as subtitle (usually "X is a/an ...")
    const firstSentence = extract.split(/\.\s/)[0]?.trim() || '';
    // Short bio — 2-3 sentences
    const bio = extract.split(/\.\s/).slice(0, 3).join('. ').trim();

    return {
      type: 'person',
      name: page.title,
      imageUrl: page.thumbnail?.source || null,
      subtitle: firstSentence.length > 120 ? firstSentence.slice(0, 120) + '…' : firstSentence,
      bio: bio.length > 350 ? bio.slice(0, 350) + '…' : bio,
      source: 'Wikipedia',
      sourceUrl: `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title)}`,
    };
  } catch (e) { return null; }
}

// Image from Wikipedia
async function getImageCard(query) {
  try {
    const search = await fetch(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=1`, { timeout: 2500 });
    const sd = await search.json();
    const title = sd?.query?.search?.[0]?.title;
    if (!title) return null;
    const img = await fetch(`https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=pageimages|extracts&exintro&explaintext&pithumbsize=600&format=json`, { timeout: 2500 });
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
      const res = await fetch(url, { timeout: 2500 });
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
          const sumRes = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/summary?event=${ev.id}`, { timeout: 2500 });
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

// Map of common names → Yahoo Finance tickers
const TICKER_MAP = {
  // Tech
  apple: 'AAPL', microsoft: 'MSFT', google: 'GOOGL', alphabet: 'GOOGL',
  amazon: 'AMZN', meta: 'META', facebook: 'META', netflix: 'NFLX',
  tesla: 'TSLA', nvidia: 'NVDA', amd: 'AMD', intel: 'INTC',
  samsung: '005930.KS', sony: 'SONY', qualcomm: 'QCOM',
  'take-two': 'TTWO', 'take two': 'TTWO', 'rockstar': 'TTWO',
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
  const q = query.toLowerCase();

  // Stock / crypto detection
  if (STOCK_KEYWORDS.test(q) || /\b(bitcoin|ethereum|crypto|btc|eth|sol|doge|bnb|xrp|stock|shares?|ticker)\b/i.test(q)) {
    // 1. Check known name map first
    let symbol = null;
    for (const [name, ticker] of Object.entries(TICKER_MAP)) {
      if (q.includes(name) && ticker) { symbol = ticker; break; }
    }

    // 2. Try to extract a ticker (ALL CAPS 1-5 letters) from the query
    if (!symbol) {
      const tickerMatch = query.match(/\b([A-Z]{2,5}(?:-USD)?)\b/);
      if (tickerMatch) symbol = tickerMatch[1];
    }

    // 3. Fall back to Yahoo Finance symbol search for the full query
    if (!symbol) {
      // Extract company name from question ("what is the price of X", "X stock price", etc.)
      const nameGuess = query
        .replace(/what (is|are|'s) (the )?(current |live )?(stock |share |crypto )?(price|value|worth|cost) (of |for )?/gi, '')
        .replace(/\b(stock|share|shares|price|value|worth|crypto|cryptocurrency|coin|token|current|live|trading|today|how much)\b/gi, '')
        .trim();
      if (nameGuess.length > 1) symbol = await resolveTickerSymbol(nameGuess);
    }

    if (symbol) return await getStockCard(symbol);
  }

  // Sports scores — ESPN (World Cup + all leagues) then Google
  if (/match|score|game|vs|versus|goal|cricket|football|soccer|basketball|tennis|premier league|champions league|world cup|nba|nfl|f1/i.test(q)) {
    const espn = await espnSportsSearch(query);
    if (espn) return espn;
    return await googleSportsScore(query);
  }

  // Person queries — show photo + bio card
  if (/\bwho is\b|\bwho('s| is) (the |a )?\b|\btell me about\b|\bshow me\b|\bbiography of\b/i.test(q)) {
    const card = await getPersonCard(query);
    if (card) return card;
  }

  // Image — car, painting, place, artwork
  if (/car|vehicle|painting|artwork|portrait|photo|picture|image|what does|show me/i.test(q)) {
    const subject = query.replace(/show me|what does|photo of|picture of|image of/gi, '').trim();
    return await getImageCard(subject);
  }

  return null;
}

module.exports = { fetchRealtimeContext, fetchCardData, SPORTS_REGEX };
