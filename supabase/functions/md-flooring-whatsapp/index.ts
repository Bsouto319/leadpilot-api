import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

// Função reaproveitada: era o assistente pessoal da MD Flooring, agora loga
// automaticamente lead novo na aba "Leads" do Painel Btech. Mantém o mesmo
// slug/URL (md-flooring-whatsapp) pra não precisar reconfigurar o webhook na
// UAZAPI -- só troca o que ela faz quando a mensagem chega.
//
// Regra do Bruno: no número da BTech (93988147) só fala quem é de verdade
// um lead -- o resto é grupo/comunidade. Então qualquer mensagem individual
// que não seja do próprio Bruno já conta como lead em potencial.
//
// Payload real da UAZAPI (evento "messages", confirmado em
// https://docs.uazapi.com/webhook/messages):
// { EventType, message: { sender, chatid, fromMe, isGroup, messageType,
//   text, pushName, messageid, ... } }

const SPREADSHEET_ID = "1qUCox23Tlfp2VnDNM484ZDXwdfN8Yeb2i7PA7U9oXZQ";
const SHEET_TAB = "Leads";

// Detecta o produto pela mensagem pré-escrita que o próprio anúncio Meta manda
// no clique de "Enviar mensagem" (ex: "Olá! Quero saber como funciona o
// BoxCerto"). Serve pra qualquer campanha futura -- só adiciona a palavra-chave
// da campanha nova nessa lista, sem mexer no resto da função.
const PRODUCT_KEYWORDS: [RegExp, string][] = [
  [/boxcerto/i, "BoxCerto"],
  [/lotesync/i, "LoteSync"],
  [/clinicaflow|pronutro/i, "ClinicaFlow"],
  [/sellpilot/i, "SellPilot"],
  [/leadpilot/i, "LeadPilot"],
];

function detectProduct(text: string): string {
  for (const [re, name] of PRODUCT_KEYWORDS) if (re.test(text)) return name;
  return "BTech (não identificado)";
}

// A Lexy (agente da BTech) só responde perguntas fechadas e conhecidas --
// preço e vídeo. Nunca negocia, nunca promete nada, nunca responde fora
// dessas duas. Qualquer coisa diferente fica só registrada em Leads pro
// Bruno responder na mão. Resposta automática = texto fixo, não é IA
// gerando texto livre -- zero risco de alucinar preço ou condição.
const AUTO_REPLIES: [RegExp, string][] = [
  [
    /quanto|pre[cç]o|valor|custa|investimento/i,
    "Oi! Sou a Lexy, da BTech 👋 O BoxCerto sai por *R$670 no 1º ano* (renova a R$800/ano) ou *R$67/mês* sem compromisso anual — já com tags físicas, IA do áudio e implantação inclusos. Sem letra miúda!\n\nQuer ver funcionando antes? É só pedir 😊",
  ],
  [
    /v[ií]deo|demonstra[cç][aã]o|funcionando|ver\s+funcionar|como\s+funciona/i,
    "Claro! Dá uma olhada aqui, 30 segundos mostrando o BoxCerto funcionando de verdade:\nhttps://ver.contatobtech.com.br\n\nQualquer dúvida, é só me chamar! 😊",
  ],
];

function detectAutoReply(text: string): string | null {
  for (const [re, reply] of AUTO_REPLIES) if (re.test(text)) return reply;
  return null;
}

serve(async (req) => {
  if (req.method !== "POST") return new Response("ok", { status: 200 });

  let body: any;
  try { body = await req.json(); } catch { return new Response("ok", { status: 200 }); }

  const msg = body?.message;
  if (!msg || msg.fromMe === true || msg.isGroup === true) return new Response("ok", { status: 200 });

  const messageType = String(msg.messageType || "").toLowerCase();
  // Qualquer tipo de mensagem individual conta -- texto, áudio, imagem com legenda etc.
  // Só ignora o que claramente não é conversa (ex: reações, status).
  if (["reactionmessage", "", "protocolmessage"].includes(messageType)) {
    return new Response("ok", { status: 200 });
  }

  const senderJid: string = msg.sender || msg.chatid || "";
  const phone = senderJid.replace(/@.*/, "").replace("+", "");
  const nome = msg.pushName || msg.pushname || msg.senderName || "";
  const text: string = msg.text || msg.caption || "";
  if (!phone) return new Response("ok", { status: 200 });

  const produto = detectProduct(text);
  const origem = text.trim() ? `WhatsApp — "${text.trim().slice(0, 80)}"` : "WhatsApp";

  console.log("BTECH-LEAD:", phone, "|", nome, "| produto:", produto, "| tipo:", messageType);

  try {
    const accessToken = await getGoogleAccessToken();
    await upsertLead(accessToken, phone, nome, produto, origem);
  } catch (e) {
    console.error("btech-leads (md-flooring-whatsapp) error:", e);
  }

  const resposta = detectAutoReply(text);
  if (resposta) {
    try {
      await enviarTexto(phone, resposta);
      console.log("LEXY-AUTO-REPLY:", phone);
    } catch (e) {
      console.error("lexy auto-reply error:", e);
    }
  }

  return new Response("ok", { status: 200 });
});

async function enviarTexto(phone: string, text: string) {
  const UAZAPI_URL = Deno.env.get("UAZAPI_URL") || "https://btechsoutoshop.uazapi.com";
  const UAZAPI_TOKEN = Deno.env.get("UAZAPI_TOKEN");
  if (!UAZAPI_TOKEN) throw new Error("Falta o secret UAZAPI_TOKEN nesta function");
  const res = await fetch(`${UAZAPI_URL}/send/text`, {
    method: "POST",
    headers: { "Content-Type": "application/json", token: UAZAPI_TOKEN },
    body: JSON.stringify({ number: phone, text }),
  });
  if (!res.ok) throw new Error(`UAZAPI send falhou: ${res.status} ${await res.text()}`);
}

// ─── Google Sheets (service account, JWT assinado na mão — sem lib externa) ──

async function getGoogleAccessToken(): Promise<string> {
  const saRaw = Deno.env.get("GOOGLE_SA_JSON");
  if (!saRaw) throw new Error("Falta o secret GOOGLE_SA_JSON nesta function");
  const sa = JSON.parse(saRaw);

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const enc = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const unsigned = `${enc(header)}.${enc(claims)}`;

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(String(sa.private_key).replace(/\\n/g, "\n")),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const jwt = `${unsigned}.${sigB64}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok) throw new Error(`Google OAuth falhou: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.access_token;
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s/g, "");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function upsertLead(accessToken: string, phone: string, nome: string, produto: string, origem: string) {
  const getUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${SHEET_TAB}!A2:G5000`;
  const getRes = await fetch(getUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!getRes.ok) throw new Error(`Sheets GET falhou: ${getRes.status} ${await getRes.text()}`);
  const getData = await getRes.json();
  const rows: string[][] = getData.values || [];

  // Já existe lead com esse telefone -- não duplica linha, conversa continua a mesma.
  if (rows.some((r) => r[2] === phone)) return;

  const today = new Date().toISOString().slice(0, 10);
  const line = [today, nome || "(sem nome)", phone, produto, origem, "1. Lead recebido", "Responder em até 5 min"];

  const appendUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${SHEET_TAB}!A:G:append?valueInputOption=USER_ENTERED`;
  const appendRes = await fetch(appendUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values: [line] }),
  });
  if (!appendRes.ok) throw new Error(`Sheets APPEND falhou: ${appendRes.status} ${await appendRes.text()}`);
}
