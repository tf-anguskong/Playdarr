'use strict';

// Chat images (files: uploads.js; messages: sync.js). Mounted at /api/chat behind requireAuth.
// The browser sends the raw file as the request body; it's re-encoded server-side and only ever served back as
// WebP, and only to people in the same room. Posting it is a separate chat message naming the returned id.
const express   = require('express');
const rateLimit = require('express-rate-limit');
const uploads   = require('../uploads');
const { chatRoomFor, registerUpload, getRoom } = require('../sync');

const router = express.Router();

const uploadLimiter = rateLimit({
  windowMs: 60 * 1000, max: 8, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many images at once — wait a minute.' },
});

router.post('/upload/:roomId', uploadLimiter, express.raw({ type: () => true, limit: uploads.MAX_BYTES }), async (req, res) => {
  const user = req.session.user;
  if (!uploads.allowedFor(user)) return res.status(403).json({ error: 'Image uploads are turned off.' });
  const room = chatRoomFor(user, req.params.roomId, { upload: true });
  if (!room) return res.status(403).json({ error: 'You can’t post images in this room.' });
  try {
    const info = await uploads.save(room.id, req.body);
    if (getRoom(room.id) !== room) { uploads.remove(room.id, info.id); return res.status(410).json({ error: 'The room has closed.' }); }
    registerUpload(room, user.id, info);
    res.json({ id: info.id, w: info.w, h: info.h });
  } catch (err) {
    if (!err.userMessage) console.warn('[Uploads] failed:', err.message);
    res.status(400).json({ error: err.userMessage || 'That image could not be uploaded.' });
  }
});

router.get('/image/:roomId/:id', (req, res) => {
  const id = String(req.params.id).replace(/\.webp$/, '');
  const room = chatRoomFor(req.session.user, req.params.roomId);
  const file = room && uploads.pathOf(room.id, id);
  if (!file) return res.status(404).send('Not found');
  res.setHeader('Content-Type', 'image/webp');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.sendFile(file);
});

// A body over the size limit
router.use((err, req, res, next) => {
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Images can be up to 8 MB.' });
  next(err);
});

module.exports = router;
