const twilio = require('twilio');
const logger = require('../utils/logger');

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

async function makeCall({ to, from, voiceScript, statusCallbackUrl, gatherUrl }) {
  const twiml = `<Response>
  <Pause length="2"/>
  <Say voice="Polly.Joanna" language="en-US">${voiceScript}</Say>
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

async function sendSms({ to, from, body }) {
  const msg = await client.messages.create({ to, from, body });
  logger.info('twilio', `sms sent sid=${msg.sid} to=${to}`);
  return msg;
}

function validateSignature(req) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const signature = req.headers['x-twilio-signature'];
  const url = process.env.BASE_URL + req.originalUrl;
  return twilio.validateRequest(authToken, signature, url, req.body);
}

module.exports = { makeCall, sendSms, validateSignature };
