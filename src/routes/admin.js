'use strict';

const express  = require('express');
const router   = express.Router();
const notifier = require('../notifier');
const users    = require('../users');
const alwaysOn = require('../always-on');
const sync     = require('../sync');
const settings = require('../settings');
const { onlineUserIds } = sync;
const { sanitizeText } = require('../sanitize');
const wordfilter = require('../wordfilter');

// Mounted at /api/admin behind requireAdmin (the Plex server owner) in server.js.

// Webhook form options + current webhooks
router.get('/webhooks', (req, res) => {
  res.json({
    webhooks: notifier.list(),
    events: notifier.EVENTS,
    types: notifier.TYPES,
    leads: notifier.LEADS,
  });
});

function guard(fn) {
  return (req, res) => {
    try { fn(req, res); } catch (err) { res.status(400).json({ error: err.message }); }
  };
}

router.post('/webhooks', guard((req, res) => {
  const webhook = notifier.create(req.body || {});
  console.log(`[Admin] ${req.session.user.name} added webhook "${webhook.name}" (${webhook.type})`);
  res.status(201).json({ webhook });
}));

router.put('/webhooks/:id', guard((req, res) => {
  const webhook = notifier.update(req.params.id, req.body || {});
  if (!webhook) return res.status(404).json({ error: 'Webhook not found' });
  console.log(`[Admin] ${req.session.user.name} updated webhook "${webhook.name}"`);
  res.json({ webhook });
}));

router.delete('/webhooks/:id', (req, res) => {
  const hook = notifier.get(req.params.id);
  if (!hook || !notifier.remove(req.params.id)) return res.status(404).json({ error: 'Webhook not found' });
  console.log(`[Admin] ${req.session.user.name} deleted webhook "${hook.name}"`);
  res.json({ ok: true });
});

router.post('/webhooks/:id/test', async (req, res) => {
  const status = await notifier.test(req.params.id);
  if (!status) return res.status(404).json({ error: 'Webhook not found' });
  res.json({ status });
});

// Everyone who has signed in with Plex, with the nickname they chose (most recently seen first)
router.get('/users', (req, res) => {
  const online = onlineUserIds();
  res.json({ users: users.list().map(u => ({ ...u, online: online.has(u.id) })) });
});

// Clear a nickname (e.g. an inappropriate one). They can set a new one. Applies at once wherever they're connected.
router.delete('/users/:id/nickname', (req, res) => {
  const u = users.setNickname(req.params.id, null);
  if (!u) return res.status(404).json({ error: 'User not found' });
  console.log(`[Admin] ${req.session.user.name} cleared the nickname of ${u.name}`);
  sync.applyRename(u.id, null);
  res.json({ ok: true });
});

// Rename someone (sets their nickname). They can still change it themselves later.
router.put('/users/:id/nickname', (req, res) => {
  const name = sanitizeText(String(req.body?.name || '').trim().slice(0, 40));
  if (!name) return res.status(400).json({ error: 'Enter a name' });
  if (!wordfilter.isClean(name)) return res.status(400).json({ error: wordfilter.NAME_REFUSED });
  const u = users.setNickname(req.params.id, name);
  if (!u) return res.status(404).json({ error: 'User not found' });
  console.log(`[Admin] ${req.session.user.name} renamed ${u.name} → ${name}`);
  sync.applyRename(u.id, name);
  res.json({ ok: true, nickname: name });
});

// ── Settings: the friendly, editable view of the server's configuration ──
// Never exposes variable names or secret values; anything defined in .env is reported as locked.
router.get('/settings', (req, res) => {
  res.json({ groups: settings.list() });
});

function settingResult(req, res, fn, verb) {
  try {
    const item = fn();
    console.log(`[Admin] ${req.session.user.name} ${verb} setting "${item.label}"${item.value !== undefined && item.type !== 'secret' ? ` → ${JSON.stringify(item.value)}` : ''}`);
    res.json({ setting: item });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
}
router.put('/settings/:id', (req, res) => settingResult(req, res, () => settings.set(req.params.id, req.body?.value), 'changed'));
router.delete('/settings/:id', (req, res) => settingResult(req, res, () => settings.reset(req.params.id), 'reset'));

// ── Always-on rooms: rooms the owner pins open (they reset, rather than close, when empty) ──
const baseUrl = () => (process.env.APP_URL || '').replace(/\/$/, '');

function alwaysOnView(def) {
  const room = sync.getPersistentRoom(def.id);
  return {
    id: def.id, name: def.name, roomType: def.roomType, channel: def.channel,
    inviteUrl: `${baseUrl()}/join/${def.inviteToken}`,
    createdBy: def.createdBy, createdAt: def.createdAt,
    open: !!room,                                            // false when the room type is currently turned off
    roomId: room ? room.id : null,
    viewers: room ? room.viewers.size : 0,
    hostName: room && !room.awaitingHost ? room.hostName : null,
    onChannel: room ? room.liveTvChannel : null,
  };
}

router.get('/always-on', (req, res) => {
  res.json({ rooms: alwaysOn.list().map(alwaysOnView), enabledRoomTypes: sync.enabledRoomTypes() });
});

router.post('/always-on', async (req, res) => {
  const { name, roomType, channel } = req.body || {};
  if (!['livetv', 'movie', 'tv'].includes(roomType) || !sync.enabledRoomTypes()[roomType]) {
    return res.status(400).json({ error: 'That room type is not available' });
  }
  const cleanName = sanitizeText(String(name || '').trim().slice(0, 60));
  if (!cleanName) return res.status(400).json({ error: 'Name is required' });

  let ch = null;
  if (roomType === 'livetv' && channel) {
    try {
      const { channels } = await require('../livetv-manager').getGuide();
      const found = channels.find(c => c.number === String(channel));
      if (!found) return res.status(400).json({ error: 'Unknown channel' });
      ch = { channel: found.number, channelTitle: found.title, channelId: found.channelId };
    } catch {
      return res.status(502).json({ error: 'Could not read the channel guide' });
    }
  }

  const def = alwaysOn.add({ name: cleanName, roomType, channel: ch, createdBy: req.session.user.name });
  sync.createPersistentRoom(def);
  console.log(`[Admin] ${req.session.user.name} created always-on room "${def.name}" (${def.roomType}${ch ? ', ' + ch.channel : ''})`);
  res.status(201).json({ room: alwaysOnView(def) });
});

router.delete('/always-on/:id', (req, res) => {
  const def = alwaysOn.get(req.params.id);
  if (!def) return res.status(404).json({ error: 'Always-on room not found' });
  sync.removePersistentRoom(def.id);
  alwaysOn.remove(def.id);
  console.log(`[Admin] ${req.session.user.name} removed always-on room "${def.name}"`);
  res.json({ ok: true });
});

module.exports = router;
