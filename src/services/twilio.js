const twilio = require('twilio');
const logger = require('../utils/logger');

const defaultClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

function getClient(credentials) {
  if (credentials?.accountSid && credentials?.authToken) {
    return twilio(credentials.accountSid, credentials.authToken);
  }
  return defaultClient;
}

function escapeXml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function makeCall({ to, from, voiceScript, statusCallbackUrl, gatherUrl, credentials }) {
  const client = getClient(credentials);
  const twiml = `<Response>
  <Pause length="2"/>
  <Say voice="Polly.Joanna" language="en-US">${escapeXml(voiceScript)}</Say>
  <Pause length="2"/>
  <Say voice="Polly.Joanna" language="en-US">To schedule your free estimate, simply reply to our text message with your preferred day and time. We will confirm right away. Thank you and have a wonderful day!</Say>
  <Pause length="1"/>
</Response>`;

  const call = await client.calls.create({
    to,
    from,
    twiml,
    statusCallback: statusCallbackUrl,
    statusCallbackMethod: 'POST',
  });

  logger.info('twilio', `call initiated sid=${call.sid} to=${to}`);
  return call;
}

async function sendSms({ to, from, body, credentials }) {
  const client = getClient(credentials);
  const msg = await client.messages.create({ to, from, body });
  logger.info('twilio', `sms sent sid=${msg.sid} to=${to}`);
  return msg;
}

function validateSignature(req, authToken) {
  const token = authToken || process.env.TWILIO_AUTH_TOKEN;
  const signature = req.headers['x-twilio-signature'];
  const url = process.env.BASE_URL + req.originalUrl;
  return twilio.validateRequest(token, signature, url, req.body);
}

function twilioSignatureMiddleware(req, res, next) {
  if (process.env.TWILIO_VALIDATE_SIGNATURES !== 'true') return next();
  if (!validateSignature(req)) {
    logger.warn('twilio', `invalid signature from ${req.ip} on ${req.originalUrl}`);
    return res.status(403).send('Forbidden');
  }
  next();
}

module.exports = { makeCall, sendSms, validateSignature, twilioSignatureMiddleware };
