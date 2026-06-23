const axios = require('axios');
const logger = require('../utils/logger');

const BASE = 'https://dialpad.com/api/v2';
const KEY  = process.env.DIALPAD_API_KEY;

const api = axios.create({
  baseURL: BASE,
  headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
  timeout: 12000,
});

async function findNumberId(phone) {
  const digits = phone.replace(/\D/g, '');
  const { data } = await api.get('/numbers', { params: { limit: 100 } });
  const match = (data.items || []).find(n => (n.number || '').replace(/\D/g, '') === digits);
  return match ? match.id : null;
}

async function enableForwarding(numberId, twilioNumber) {
  const { data } = await api.patch(`/numbers/${numberId}`, {
    forwarding_enabled: true,
    forward_to_number: twilioNumber,
  });
  logger.info(`[Dialpad] Forwarding ON → ${twilioNumber}`);
  return data;
}

async function disableForwarding(numberId) {
  const { data } = await api.patch(`/numbers/${numberId}`, {
    forwarding_enabled: false,
  });
  logger.info('[Dialpad] Forwarding OFF — secretary active');
  return data;
}

async function registerWebhook(hookUrl) {
  const { data } = await api.post('/webhooks', {
    hook_url: hookUrl,
    secret:   process.env.DIALPAD_WEBHOOK_SECRET || 'dialpad-cp-2026',
    enabled:  true,
  });
  logger.info(`[Dialpad] Webhook registered: ${hookUrl}`);
  return data;
}

async function getCallLogs(numberId, limit = 100) {
  const { data } = await api.get('/calls', {
    params: { phone_number_id: numberId, limit },
  });
  return data.items || [];
}

function calcLeadScore(call) {
  let score = 0;
  if (call.duration > 60)  score += 30;
  if (call.duration > 180) score += 20;
  if (call.direction === 'inbound') score += 20;
  const hr = new Date(call.started_at || call.date_started).getHours();
  if (hr >= 8 && hr <= 18) score += 20; // business hours
  else score += 10; // after hours — still a lead, just urgent
  return Math.min(score, 100);
}

function detectArea(callerNumber) {
  const areaCodes = {
    charleston: ['843', '854'],
    columbia:   ['803'],
    florence:   ['843'],
  };
  const code = (callerNumber || '').replace(/\D/g, '').slice(1, 4);
  if (areaCodes.charleston.includes(code)) return 'Charleston, SC';
  if (areaCodes.columbia.includes(code))   return 'Irmo / Columbia, SC';
  return 'Other SC area';
}

module.exports = { findNumberId, enableForwarding, disableForwarding, registerWebhook, getCallLogs, calcLeadScore, detectArea };
