require('dotenv').config();

// Prefix every console log/warn/error with an ISO timestamp
['log', 'warn', 'error'].forEach(level => {
  const orig = console[level].bind(console);
  console[level] = (...args) => orig(`[${new Date().toISOString()}]`, ...args);
});

// Applies admin-saved settings to process.env (anything defined in .env wins) — must run before other modules read it
const settings = require('./settings');

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const path = require('path');
const fs = require('fs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const authRouter = require('./routes/auth');
const { sanitizeText } = require('./sanitize');
const moviesRouter = require('./routes/movies');
const showsRouter = require('./routes/shows');
const { router: streamRouter, clearRoomManifest } = require('./routes/stream');
const { setupSync, getRoomByInviteToken, createScheduledRoom, getRoom, restorePersistentRooms } = require('./sync');
const scheduler = require('./scheduler');
const scheduleRouter = require('./routes/schedule');
const adminRouter = require('./routes/admin');
const recentRouter = require('./routes/recent');
const notifier = require('./notifier');
const users = require('./users');
const { buildIcs, googleCalendarUrl } = require('./ical');
const embed = require('./embed');
const wordfilter = require('./wordfilter');
const gifs = require('./gifs');
const uploads = require('./uploads');
uploads.clearAll();   // chat images belong to rooms, which don't survive a restart

const roomTypesFromEnv = () => ({
  movie:   process.env.ROOM_TYPE_MOVIE   !== 'false',
  tv:      process.env.ROOM_TYPE_TV      !== 'false',
  youtube: process.env.ROOM_TYPE_YOUTUBE !== 'false',
  livetv:  process.env.ROOM_TYPE_LIVETV  === 'true',
});
// One shared object (sync.js holds the same reference), updated in place when the admin changes a room-type setting
const enabledRoomTypes = roomTypesFromEnv();
settings.onChange(['roomMovie', 'roomTv', 'roomYoutube', 'roomLivetv'], () => {
  Object.assign(enabledRoomTypes, roomTypesFromEnv());
  restorePersistentRooms();   // an always-on room whose type was just switched on opens now
});

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.set('trust proxy', 1);

// Security headers
// HSTS is only valid over HTTPS — sending it over HTTP causes Firefox to cache
// the upgrade and break subsequent requests to http://localhost.
const behindHttps = process.env.COOKIE_SECURE === 'true';
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://www.youtube.com', 'https://s.ytimg.com'],
      workerSrc: ["'self'", 'blob:'],
      styleSrc: ["'self'", "'unsafe-inline'"],
      mediaSrc: ["'self'", 'blob:'],
      connectSrc: ["'self'", ...(process.env.APP_URL ? [`wss://${new URL(process.env.APP_URL).host}`, `ws://${new URL(process.env.APP_URL).host}`] : ['wss:', 'ws:'])],
      frameSrc: ["'self'", 'https://www.youtube.com'],
      frameAncestors: ["'none'"],
      imgSrc: ["'self'", 'data:', 'https:'],
    }
  },
  // helmet's default is no-referrer, but YouTube's embedded player refuses to play without one ("Error 153").
  // This policy sends other sites only our origin (never a path, so no invite tokens), and nothing over HTTP.
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  hsts: behindHttps ? { maxAge: 31536000, includeSubDomains: true } : false,
  crossOriginEmbedderPolicy: false
}));

app.use(express.json());

const sessionsDir = process.env.DATA_PATH
  ? path.join(process.env.DATA_PATH, 'sessions')
  : '/data/sessions';
fs.mkdirSync(sessionsDir, { recursive: true });

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  throw new Error('SESSION_SECRET env var must be set and at least 32 characters long');
}

const sessionMiddleware = session({
  store: new FileStore({ path: sessionsDir, ttl: 7 * 24 * 3600, retries: 1 }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.COOKIE_SECURE === 'true',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
});

app.use(sessionMiddleware);

io.use((socket, next) => {
  sessionMiddleware(socket.request, socket.request.res || {}, next);
});
io.use((socket, next) => {
  const user = socket.request.session?.user;
  if (user && !user.isGuest) {
    // The registry owns nicknames, so a reset by the owner (or a change from another device) applies here
    user.displayName = users.touch(user).nickname || undefined;
  }
  if (user) { socket.user = user; next(); }
  else next(new Error('Unauthorized'));
});

function requireAuth(req, res, next) {
  if (req.session?.user) return next();
  // Non-page requests (HLS/XHR/fetch) should get a 401, not an HTML redirect —
  // a redirect causes HLS.js to silently receive a login page and stall.
  const acceptsHtml = req.headers.accept?.includes('text/html');
  if (!acceptsHtml) return res.status(401).json({ error: 'Unauthorized' });
  res.redirect('/login');
}

function requirePlexAuth(req, res, next) {
  if (req.session?.user && !req.session.user.isGuest) return next();
  if (req.headers.accept?.includes('json')) return res.status(403).json({ error: 'Plex account required' });
  res.redirect('/login');
}

// The Plex server owner only (set at login from plex.tv's `owned` flag on this server)
function requireAdmin(req, res, next) {
  const user = req.session?.user;
  if (user && !user.isGuest && user.isAdmin) return next();
  if (req.headers.accept?.includes('text/html')) return res.redirect('/');
  res.status(403).json({ error: 'Server owner only' });
}

// Rate limit auth endpoints — prevents PIN enumeration and brute-force
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' }
});

// The TV app polls this every few seconds while someone enters its code at plex.tv/link, which would use up the
// /auth limit above in a couple of minutes, so it gets its own (a code lasts ~15 min; 5 s polling is 180 calls).
const deviceStatusLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' }
});
app.get('/auth/plex/device/status', deviceStatusLimiter, authRouter.deviceStatus);
app.use('/auth', authLimiter, authRouter);
app.use('/api/movies', requirePlexAuth, moviesRouter);
app.use('/api/shows', requirePlexAuth, showsRouter);
app.use('/api/recent', requirePlexAuth, recentRouter);
// Segment proxy is the high-volume path (one request per .ts chunk, every few
// seconds per viewer). The manifest endpoint is called once per movie load and
// must never be rate-limited — a 429 there kills the whole stream startup.
// The segment limiter is registered first so it runs before the stream router.
const segmentLimiter = rateLimit({
  windowMs: 60 * 1000,        // 1 minute
  max: 600,                   // 600 segment requests per minute per IP (~10/s)
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many stream requests' }
});
app.use('/api/stream/proxy', segmentLimiter);
app.use('/api/stream', requireAuth, streamRouter);
app.use('/api/schedule', requirePlexAuth, scheduleRouter);
app.use('/api/admin', requireAdmin, adminRouter);

app.get('/api/config', (req, res) => res.json({ enabledRoomTypes, gifs: gifs.enabled(), imageUploads: uploads.allowedFor(req.session?.user) }));

// Chat images: paste/upload and serve (routes/chat-images.js, uploads.js)
app.use('/api/chat', requireAuth, require('./routes/chat-images'));

// GIF search for the chat picker (guests too). The Giphy key never leaves the server; see gifs.js.
const gifLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });
app.get('/api/gifs', requireAuth, gifLimiter, async (req, res) => {
  if (!gifs.enabled()) return res.status(404).json({ error: 'GIFs are not set up on this server' });
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    res.json(await gifs.search(q, parseInt(req.query.offset, 10) || 0));
  } catch (err) {
    console.warn('[GIF] search failed:', err.response?.status || err.message);
    res.status(502).json({ error: 'GIF search is unavailable right now' });
  }
});

// Always mounted, so Live TV can be switched on from the admin settings without a restart
app.use('/api/livetv', requireAuth,
  (req, res, next) => (enabledRoomTypes.livetv ? next() : res.status(404).json({ error: 'Live TV is turned off' })),
  require('./routes/livetv'));

app.get('/api/me', (req, res) => {
    const user = req.session?.user || null;
    if (!user) return res.json({ user: null });
    const { plexToken, ...safeUser } = user;
    if (!user.isGuest) safeUser.displayName = users.touch(user).nickname || undefined;
    res.json({ user: safeUser });
});

app.post('/api/me/display-name', requirePlexAuth, (req, res) => {
  const name = sanitizeText((req.body?.name || '').trim().slice(0, 40));
  if (!name) return res.status(400).json({ error: 'Name required' });
  if (!wordfilter.isClean(name)) return res.status(400).json({ error: wordfilter.NAME_REFUSED });
  users.touch(req.session.user);
  users.setNickname(req.session.user.id, name);    // remembered across sign-ins
  req.session.user.displayName = name;
  req.session.save(err => {
    if (err) return res.status(500).json({ error: 'Session error' });
    res.json({ name });
  });
});

// The lobby page is served by the authed '/' route; direct hits on index.html must not bypass it.
app.get('/index.html', (req, res) => res.redirect('/'));
app.get('/admin.html', (req, res) => res.redirect('/admin'));
app.get('/admin-settings.html', (req, res) => res.redirect('/admin/settings'));

app.use(express.static(path.join(__dirname, 'public'), {
  index: false,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.css') || filePath.endsWith('.js')) {
      res.setHeader('Cache-Control', 'no-store');
    } else {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

app.get('/', requireAuth, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', requireAdmin, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/admin/settings', requireAdmin, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'admin-settings.html'));
});

app.get('/watch/:roomId', (req, res, next) => {
  // Discord/Slack/Telegram crawlers don't have a session — intercept before requireAuth
  // and return a lightweight OG preview page so link unfurls work.
  if (embed.isCrawler(req.headers['user-agent'])) {
    res.setHeader('Cache-Control', 'no-store');
    const room = getRoom(req.params.roomId);
    const base = `${process.env.APP_URL || ''}/watch/${req.params.roomId}`;
    return (room ? embed.forRoom(room, `${base}/preview.jpg?v=${encodeURIComponent(room.movieKey || '')}`, { invite: false }) : Promise.resolve(embed.expired()))
      .then(card => res.send(embed.page(card, base)), next);
  }
  requireAuth(req, res, () => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(__dirname, 'public', 'watch.html'));
  });
});

// Info endpoint used by join.html and waiting.html to get roomId or scheduled info
app.get('/join/:inviteToken/info', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const token = req.params.inviteToken;

  // Check active rooms first
  const room = getRoomByInviteToken(token);
  if (room) return res.json({ roomId: room.id });

  // Check scheduled rooms
  const scheduled = scheduler.getByInviteToken(token);
  if (scheduled) {
    return res.json({
      scheduled:    true,
      scheduledFor: scheduled.scheduledFor,
      name:         scheduled.name,
      timezone:     scheduled.timezone,
      recurrence:   scheduled.recurrence || null,
      calendar:     { ics: `/join/${token}/event.ics`, google: googleCalendarUrl(scheduled) }
    });
  }

  res.status(404).json({ error: 'Invite expired or invalid' });
});

// Calendar file for a scheduled night — public like the invite link itself (the token is the secret)
app.get('/join/:inviteToken/event.ics', (req, res) => {
  const scheduled = scheduler.getByInviteToken(req.params.inviteToken);
  if (!scheduled) return res.status(404).send('Not found');
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="playdarr-watch-night.ics"');
  res.setHeader('Cache-Control', 'no-store');
  res.send(buildIcs(scheduled));
});

// Artwork for link previews (embed.js) — public like the links themselves; only ever the room's current title
app.get('/join/:inviteToken/preview.jpg', async (req, res) => {
  const room = getRoomByInviteToken(req.params.inviteToken);
  const key = room ? room.movieKey : scheduler.getByInviteToken(req.params.inviteToken)?.movieKey;
  if (!(key && await embed.sendArt(res, key))) res.status(404).send('No preview');
});
app.get('/watch/:roomId/preview.jpg', async (req, res) => {
  const key = getRoom(req.params.roomId)?.movieKey;
  if (!(key && await embed.sendArt(res, key))) res.status(404).send('No preview');
});

// Invite link — public, no auth required
app.get('/join/:inviteToken', (req, res) => {
  // Prevent proxies/CDNs from caching this response — room existence is dynamic
  res.setHeader('Cache-Control', 'no-store');
  const token = req.params.inviteToken;
  const room  = getRoomByInviteToken(token);

  if (embed.isCrawler(req.headers['user-agent'])) {
    const base = `${process.env.APP_URL || ''}/join/${token}`;
    const scheduled = !room && scheduler.getByInviteToken(token);
    const key = room ? room.movieKey : scheduled ? scheduled.movieKey : '';
    const img = `${base}/preview.jpg?v=${encodeURIComponent(key || '')}`;   // new title → new URL, so caches refresh
    const card = room ? embed.forRoom(room, img) : scheduled ? embed.forScheduled(scheduled, img) : Promise.resolve(embed.expired());
    return card.then(c => res.send(embed.page(c, base)), err => {
      console.warn('[Embed] preview failed:', err.message);
      res.send(embed.page({ siteName: 'Playdarr', title: room?.name || scheduled?.name || 'Playdarr', lines: ['Tap to join.'] }, base));
    });
  }
  console.log(`[Join] token=${token} found=${!!room}`);

  if (room) {
    // Active room exists
    if (req.session?.user && !req.session.user.isGuest) {
      req.session.user.inviteToken = token;
      return req.session.save(() => res.redirect(`/watch/${room.id}`));
    }
    return res.sendFile(path.join(__dirname, 'public', 'join.html'));
  }

  // Check if it's a scheduled room not yet open
  const scheduled = scheduler.getByInviteToken(token);
  if (scheduled) {
    // Pass data as query params so waiting.html can render immediately
    // without needing a separate async fetch for initial display
    if (!req.query.t) {
      const q = new URLSearchParams({
        n: scheduled.name,
        t: scheduled.scheduledFor,
        z: scheduled.timezone || 'UTC'
      });
      return res.redirect(`/join/${token}?${q}`);
    }
    return res.sendFile(path.join(__dirname, 'public', 'waiting.html'));
  }

  res.redirect('/?error=expired');
});

app.get('/login', (req, res) => {
  if (req.session?.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

setupSync(io, enabledRoomTypes);
restorePersistentRooms();

notifier.init();
scheduler.init((scheduled) => {
  const room = createScheduledRoom(scheduled);
  console.log(`[Scheduler] Room "${room.name}" opened from schedule (roomId=${room.id})`);
  notifier.notify('schedule.started', notifier.scheduleData(scheduled), { schedule: scheduled });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Playdarr running on port ${PORT}`));
