const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const db = require('../services/supabase');
const twilioSvc = require('../services/twilio');
const openaiSvc = require('../services/openai');
const calendarSvc = require('../services/calendar');
const { handleError } = require('../middleware/alerting');

function detectServiceType(text) {
  const msg = (text || '').toLowerCase();
  if (/tile|tiling|grout|bullnose|porcelain/.test(msg)) return 'tile_install';
  if (/custom home|new home|build|construction/.test(msg)) return 'custom_home';
  if (/remodel|kitchen|bathroom|bath/.test(msg)) return 'remodel';
  if (/renovat/.test(msg)) return 'renovation';
  if (/repair|fix|replace|replacement/.test(msg)) return 'tile_replacement';
  if (/estimate|quote|price/.test(msg)) return 'free_estimate';
  return 'general';
}

function normalizePhone(raw) {
  return (raw || '').replace(/\D/g, '');
}

// Twilio inbound SMS
router.post('/sms', (req, res) => {
  // Respond immediately so Twilio doesn't timeout
  res.set('Content-Type', 'text/xml');
  res.send('<Response></Response>');

  // Process async
  processSms(req.body).catch(err => handleError('webhook', err));
});

async function processSms(body) {
  const leadPhone   = normalizePhone(body.From);
  const twilioNumber = (body.To || '').trim();
  const message     = body.Body || '';

  if (!leadPhone) {
    logger.warn('webhook', 'SMS received with no From number, skipping');
    return;
  }

  logger.info('webhook', `inbound SMS from=${leadPhone} to=${twilioNumber}`);

  const serviceType = detectServiceType(message);

  // 1. Find client
  let client;
  try {
    client = await db.getClientByTwilioNumber(twilioNumber);
  } catch (err) {
    await handleError('supabase', err);
    return;
  }
  if (!client) {
    logger.warn('webhook', `no active client for number ${twilioNumber}`);
    return;
  }

  // 2. Anti-duplicate
  let isDuplicate;
  try {
    isDuplicate = await db.checkDuplicate(client.id, leadPhone, 60);
  } catch (err) {
    await handleError('supabase', err);
    return;
  }
  if (isDuplicate) {
    logger.info('webhook', `duplicate lead ${leadPhone} for client ${client.id}, skipping`);
    return;
  }

  // 3. Save lead
  let conversation;
  try {
    conversation = await db.saveLead({
      clientId: client.id,
      leadPhone,
      source: 'sms',
      serviceType,
      message,
    });
  } catch (err) {
    await handleError('supabase', err);
    return;
  }

  // 4. Generate voice script
  let voiceScript;
  try {
    voiceScript = await openaiSvc.generateVoiceScript({
      businessName: client.business_name,
      serviceType,
      pricing: client.pricing,
    });
  } catch (err) {
    await handleError('openai', err);
    voiceScript = client.voice_script || `Hi! This is ${client.business_name}. We received your flooring request and would love to schedule a FREE in-home estimate. Please reply with your preferred date and time. Thank you!`;
  }

  // 5. Make call immediately
  let call;
  try {
    const BASE = process.env.BASE_URL || 'http://asso488k40o4gsc8c0w80gcw.31.97.240.160.sslip.io';
    call = await twilioSvc.makeCall({
      to: `+${leadPhone}`,
      from: client.twilio_number,
      voiceScript,
      statusCallbackUrl: `${BASE}/webhook/call-status`,
      gatherUrl: `${BASE}/webhook/call-gather?conversationId=${conversation.id}&clientId=${client.id}`,
    });
    await db.updateConversation(conversation.id, {
      call_sid: call.sid,
      call_status: call.status,
      call_attempted_at: new Date().toISOString(),
    });
  } catch (err) {
    await handleError('twilio', err);
  }

  // 6. Google Calendar (non-critical)
  if (client.google_refresh_token && client.google_calendar_id) {
    try {
      await calendarSvc.createFollowUpEvent({
        refreshToken: client.google_refresh_token,
        calendarId: client.google_calendar_id,
        leadPhone,
        serviceType,
        message,
        voiceScript,
      });
    } catch (err) {
      await handleError('calendar', err);
    }
  }

  // 7. Notify owner
  try {
    const notifyMsg = `NEW LEAD – ${client.business_name}\nPhone: ${leadPhone}\nService: ${serviceType}\nCall initiated!\nCalendar updated.`;
    await twilioSvc.sendSms({
      to: client.owner_phone,
      from: client.twilio_number,
      body: notifyMsg,
    });
  } catch (err) {
    await handleError('twilio', err);
  }

  // 8. Update stage
  try {
    await db.updateConversation(conversation.id, {
      stage: 'ai_responded',
      ai_response: voiceScript,
      last_response_at: new Date().toISOString(),
    });
  } catch (err) {
    await handleError('supabase', err);
  }

  logger.info('webhook', `lead processed id=${conversation.id} phone=${leadPhone}`);
}

// Twilio call status callback
router.post('/call-status', async (req, res) => {
  res.sendStatus(200);
  const { CallSid, CallStatus } = req.body;
  if (!CallSid) return;

  try {
    await db.updateConversationByCallSid(CallSid, { call_status: CallStatus });
    logger.info('webhook', `call-status sid=${CallSid} status=${CallStatus}`);
  } catch (err) {
    handleError('supabase', err).catch(() => {});
  }
});

// Twilio speech gather — lead responded with preferred date/time
router.post('/call-gather', async (req, res) => {
  const { SpeechResult, conversationId, clientId } = { ...req.body, ...req.query };
  const speech = SpeechResult || '';

  logger.info('webhook', `call-gather speech="${speech}" conv=${conversationId}`);

  if (!speech) {
    res.set('Content-Type', 'text/xml');
    return res.send(`<Response><Say voice="Polly.Joanna" language="en-US">We didn't catch that. We'll follow up with you soon. Thank you!</Say></Response>`);
  }

  // Parse date/time and book calendar async
  processGather({ speech, conversationId, clientId }).catch(err => handleError('gather', err));

  res.set('Content-Type', 'text/xml');
  res.send(`<Response>
  <Say voice="Polly.Joanna" language="en-US">Perfect! We have noted your preference. You will receive a confirmation shortly. Thank you for choosing Denali Custom Homes and have a wonderful day!</Say>
</Response>`);
});

async function processGather({ speech, conversationId, clientId }) {
  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(
    'https://pvphgusjofufwtyiyviu.supabase.co',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB2cGhndXNqb2Z1Znd0eWl5dml1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUyNjkwODYsImV4cCI6MjA5MDg0NTA4Nn0.0aA8YNmhVusNuBjWZoEZW50dTRZWowm9AoNVoyGCXBM'
  );

  // 1. Get conversation + client data
  const { data: conv } = await supabase
    .from('conversations')
    .select('*, clients(*)')
    .eq('id', conversationId)
    .single();

  if (!conv) return;

  const client = conv.clients;

  // 2. Parse date/time with GPT
  const OpenAI = require('openai');
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const now = new Date().toISOString();

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 100,
    messages: [
      {
        role: 'system',
        content: `Today is ${now}. The user said when they want an appointment. Extract a specific ISO 8601 datetime. If vague (e.g. "tomorrow afternoon"), pick 2pm. If no day mentioned, assume next business day. Respond ONLY with the ISO datetime, nothing else. Timezone: ${client.timezone || 'America/New_York'}.`,
      },
      { role: 'user', content: speech },
    ],
  });

  const isoDate = completion.choices[0].message.content.trim();
  logger.info('webhook', `parsed date from speech: ${isoDate}`);

  const startDate = new Date(isoDate);
  const endDate = new Date(startDate.getTime() + 60 * 60 * 1000); // +1h

  // 3. Save preference to Supabase
  await supabase.from('conversations').update({
    stage: 'scheduled',
    collected_data: { preferred_datetime: isoDate, speech_input: speech },
    last_response_at: new Date().toISOString(),
  }).eq('id', conversationId);

  // 4. Google Calendar (if client has refresh token)
  if (client.google_refresh_token && client.google_calendar_id) {
    try {
      await calendarSvc.createFollowUpEvent({
        refreshToken: client.google_refresh_token,
        calendarId: client.google_calendar_id,
        leadPhone: conv.lead_phone,
        serviceType: conv.service_type,
        message: `Scheduled via voice call. Lead said: "${speech}"`,
        voiceScript: `Estimate visit at ${isoDate}`,
      });
      logger.info('webhook', `calendar event created for ${isoDate}`);
    } catch (err) {
      await handleError('calendar', err);
    }
  }

  // 5. Notify owner with scheduled time
  try {
    await twilioSvc.sendSms({
      to: client.owner_phone,
      from: client.twilio_number,
      body: `SCHEDULED – ${client.business_name}\nPhone: ${conv.lead_phone}\nService: ${conv.service_type}\nTime: ${startDate.toLocaleString('en-US', { timeZone: client.timezone || 'America/New_York' })}\nLead said: "${speech}"`,
    });
  } catch (err) {
    await handleError('twilio', err);
  }
}

module.exports = router;
