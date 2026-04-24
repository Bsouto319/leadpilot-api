const twilio = require('twilio');
const logger = require('../utils/logger');

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

async function makeCall({ to, from, voiceScript, statusCallbackUrl, gatherUrl }) {
  const twiml = `<Response>
  <Pause length="2"/>
  <Say voice="Polly.Joanna" language="en-US">${voiceScript}</Say>
  <Pause length="2"/>
  <Gather input="speech" action="${gatherUrl}" method="POST" speechTimeout="3" timeout="10" language="en-US">
    <Say voice="Polly.Joanna" language="en-US">What day and time works best for your free in-home estimate? You can say something like... tomorrow afternoon... or Friday morning.</Say>
  </Gather>
  <Pause length="1"/>
  <Say voice="Polly.Joanna" language="en-US">No problem! We will follow up with you soon. Thank you and have a great day!</Say>
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
