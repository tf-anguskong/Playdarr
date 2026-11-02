'use strict';

const express  = require('express');
const router   = express.Router();
const notifier = require('../notifier');

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

module.exports = router;
