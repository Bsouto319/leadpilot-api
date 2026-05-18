const twilio = require('twilio');
const logger = require('../utils/logger');

let _defaultClient = null;
function getClient(credentials) {
  if (credentials?.accountSid && credentials?.authToken) {
    return twilio(credentials.accountSid, credentials.authToken);
  }
  if (!_defaultClient) _defaultClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  return _defaultClient;
}

function escapeXml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function makeCall({ to, from, voiceScript, statusCallbackUrl, gatherUrl, intakeUrl, credentials }) {
  const client = getClient(credentials);
  const callParams = {
    to,
    from,
    statusCallback: statusCallbackUrl,
    statusCallbackMethod: 'POST',
  };
  if (intakeUrl) {
    callParams.url = intakeUrl;
  } else {
    callParams.twiml = `<Response>
  <Say voice="alice" language="en-US">${escapeXml(voiceScript)}</Say>
  <Pause length="1"/>
  <Say voice="alice" language="en-US">To schedule your free estimate, simply reply to our text message with your preferred day and time. We will confirm right away. Thank you and have a wonderful day!</Say>
</Response>`;
  }

  try {
    const call = await client.calls.create(callParams);
    logger.info('twilio', `call_initiated sid=${call.sid} to=${to} from=${from} status=${call.status}`);
    return call;
  } catch (err) {
    logger.error('twilio', `call_failed to=${to} from=${from} code=${err.code || 'N/A'} status=${err.status || 'N/A'} message=${err.message}`);
    if (err.code === 21216) {
      err.isAccountRestricted = true;
      err.friendlyMessage = 'Conta Twilio restrita pelo provedor para chamadas +1. Aguardar liberação do suporte (Ticket #26755104).';
    }
    throw err;
  }
}

async function sendSms({ to, from, body, credentials }) {
  const client = getClient(credentials);
  try {
    const msg = await client.messages.create({ to, from, body });
    logger.info('twilio', `sms_sent sid=${msg.sid} to=${to} from=${from} status=${msg.status}`);
    return msg;
  } catch (err) {
    logger.error('twilio', `sms_failed to=${to} from=${from} code=${err.code || 'N/A'} message=${err.message}`);
    throw err;
  }
}

function validateSignature(req, authToken) {
  const base = (process.env.BASE_URL || '').replace(/\/$/, '');
  if (!base) return true; // BASE_URL not configured — skip validation
  const token = authToken || process.env.TWILIO_AUTH_TOKEN;
  const signature = req.headers['x-twilio-signature'] || '';
  // Construct full URL safely
  let url;
  try {
    url = new URL(req.originalUrl, base).toString();
  } catch {
    logger.warn('twilio', `validateSignature: could not construct URL from BASE_URL="${base}" path="${req.originalUrl}" — skipping`);
    return true;
  }
  return twilio.validateRequest(token, signature, url, req.body);
}

function twilioSignatureMiddleware(req, res, next) {
  if (process.env.TWILIO_VALIDATE_SIGNATURES !== 'true') return next();
  try {
    if (!validateSignature(req)) {
      logger.warn('twilio', `invalid signature from ${req.ip} on ${req.originalUrl}`);
      return res.status(403).send('Forbidden');
    }
  } catch (err) {
    // Never crash the webhook due to signature validation — fail open and log
    logger.error('twilio', `signature validation threw unexpectedly: ${err.message} — allowing request`);
  }
  next();
}

// CNAM lookup — retorna primeiro nome limpo ou null se não encontrado
// Funciona para números +1 (EUA/Canadá). Custo: ~$0.01/consulta.
async function lookupCallerName(phoneNumber) {
  try {
    // CNAM only works for US/Canada (+1). Skip lookup for other countries.
    if (!phoneNumber.startsWith('+1')) return null;
    const client = getClient();
    const result = await client.lookups.v1.phoneNumbers(phoneNumber).fetch({ type: ['caller-name'] });
    const raw = result.callerName?.callerName;
    if (!raw || raw.trim() === '') return null;
    // Pega só o primeiro nome (CNAM às vezes retorna nome completo em maiúsculas)
    const first = raw.trim().split(/\s+/)[0];
    return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
  } catch {
    return null; // nunca bloqueia o fluxo principal
  }
}

// Simple one-way notification call — plays a message and hangs up. No intake flow.
async function makeNotifyCall({ to, from, message, credentials }) {
  const client = getClient(credentials);
  const twiml = `<Response><Say voice="alice" language="en-US">${escapeXml(message)}</Say><Pause length="1"/></Response>`;
  try {
    const call = await client.calls.create({ to, from, twiml });
    logger.info('twilio', `notify_call sid=${call.sid} to=${to}`);
    return call;
  } catch (err) {
    logger.error('twilio', `notify_call failed to=${to} message=${err.message}`);
    throw err;
  }
}

module.exports = { makeCall, makeNotifyCall, sendSms, validateSignature, twilioSignatureMiddleware, lookupCallerName };
