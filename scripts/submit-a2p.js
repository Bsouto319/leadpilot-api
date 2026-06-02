// Script one-shot: submete campanha A2P corrigida no Twilio com privacy + terms URLs
// Executar: node scripts/submit-a2p.js
require('dotenv').config();
const https = require('https');
const querystring = require('querystring');

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN;
const MSG_SVC     = process.env.TWILIO_MSG_SERVICE_SID || 'MGef6f3b5996907f47914fdeea98d07056';
const BRAND_SID   = process.env.TWILIO_BRAND_SID       || 'BNb71d93d0c73236c89588e2edc4e2a0be';

if (!ACCOUNT_SID || !AUTH_TOKEN) {
  console.error('\nERROR: Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN in your .env first.\n');
  process.exit(1);
}

function twilioRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString('base64');
    const postData = body ? querystring.stringify(body) : '';
    const opts = {
      hostname: 'messaging.twilio.com',
      port: 443,
      path,
      method,
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
      },
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

// querystring.stringify não suporta arrays nativamente — usar escape manual
function buildFormBody(params) {
  const parts = [];
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) {
      for (const item of v) {
        parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(item)}`);
      }
    } else {
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
    }
  }
  return parts.join('&');
}

async function main() {
  // 1. Deletar campanha existente se houver
  const OLD = 'QE2c6890da8086d771620e9b13fadeba0b';
  console.log(`Deletando campanha ${OLD}...`);
  const del = await twilioRequest('DELETE', `/v1/Services/${MSG_SVC}/Compliance/Usa2p/${OLD}`, null);
  console.log('Delete status:', del.status, del.status === 204 || del.status === 404 ? '✓' : '✗', del.body?.message || '');

  // 2. Montar o body com todos os campos
  const body = {
    BrandRegistrationSid: BRAND_SID,
    UsAppToPersonUsecase: 'SOLE_PROPRIETOR',
    Description:
      'Denali Custom Homes LLC schedules FREE in-home estimates for flooring, tile installation, ' +
      'custom home construction, and remodeling in Florida. Customers requesting estimates via ' +
      'Thumbtack.com or by contacting us directly receive appointment scheduling, confirmations, ' +
      'reminders, and follow-ups via SMS. All messages relate directly to the customer-requested service.',
    MessageFlow:
      'Customers provide explicit consent to receive SMS from Denali Custom Homes LLC via two methods: ' +
      '(1) Web Form Opt-In: Customers submit a free estimate request on Thumbtack.com, provide their ' +
      'phone number, and select Denali Custom Homes LLC as their contractor, expressly consenting to be ' +
      'contacted by phone and SMS about their project. Thumbtack platform terms confirm consumers agree ' +
      'to receive communications from the businesses they select. ' +
      '(2) Mobile-Originated Opt-In: Customers call or text our business number directly, constituting ' +
      'explicit SMS opt-in. All messages relate to the customer service request. ' +
      'STOP opt-out is included in every message and processed immediately and permanently.',
    'MessageSamples[]': [
      'Hi! Denali Custom Homes here - we saw your Thumbtack estimate request and are calling you RIGHT NOW! If we miss you reply with your best day and time for a FREE in-home estimate. Reply STOP to opt out.',
      'You are all set! FREE estimate confirmed Thursday May 14 at 2 PM at 123 Oak St Naples FL. Denali Custom Homes will reach out to confirm. Reply STOP to cancel.',
      'Reminder: your FREE estimate with Denali Custom Homes is TOMORROW at 2 PM. We will be there! Questions just reply here. Reply STOP to cancel.',
      'Hi! We missed your call at Denali Custom Homes. Reply with your name and project details and we will schedule your FREE estimate ASAP. Reply STOP to opt out.',
      'Thank you for choosing Denali Custom Homes! We hope you love the results of your project. Reply STOP to opt out.',
    ],
    HasEmbeddedLinks: 'false',
    HasEmbeddedPhone: 'false',
    'OptInKeywords[]':  ['START', 'YES'],
    OptInMessage:
      'You have opted in to appointment and estimate messages from Denali Custom Homes LLC. ' +
      'Msg and data rates may apply. Message frequency varies. Reply STOP to unsubscribe, HELP for help.',
    'OptOutKeywords[]': ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'],
    OptOutMessage:
      'You have been unsubscribed from Denali Custom Homes LLC. ' +
      'No further messages will be sent. Reply START to resubscribe.',
    'HelpKeywords[]':   ['HELP', 'INFO'],
    HelpMessage:
      'Denali Custom Homes LLC estimate scheduling service. ' +
      'Msg and data rates may apply. Reply STOP to unsubscribe.',
    PrivacyPolicyUrl:       'https://leads.btechsouto.shop/privacy',
    TermsAndConditionsUrl:  'https://leads.btechsouto.shop/terms',
  };

  const postData = buildFormBody(body);

  console.log('\nSubmetendo nova campanha A2P...');
  const opts = {
    hostname: 'messaging.twilio.com',
    port: 443,
    path: `/v1/Services/${MSG_SVC}/Compliance/Usa2p`,
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(postData),
    },
  };

  const result = await new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });

  if (result.status === 201 || result.status === 200) {
    const c = result.body;
    console.log('\n✅ CAMPANHA CRIADA COM SUCESSO!');
    console.log('SID:            ', c.sid);
    console.log('Status:         ', c.campaign_status);
    console.log('Use case:       ', c.us_app_to_person_usecase);
    console.log('Privacy URL:    ', c.privacy_policy_url || '(não retornado pela API)');
    console.log('Terms URL:      ', c.terms_and_conditions_url || '(não retornado pela API)');
    console.log('\n→ Twilio vai revisar em 24-48h. Garanta que as páginas estejam no ar:');
    console.log('  https://leads.btechsouto.shop/privacy');
    console.log('  https://leads.btechsouto.shop/terms');
  } else {
    console.error('\n❌ ERRO ao criar campanha:');
    console.error('Status HTTP:', result.status);
    console.error(JSON.stringify(result.body, null, 2));
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Erro fatal:', err.message);
  process.exit(1);
});
