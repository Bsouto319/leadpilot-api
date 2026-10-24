import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

// Função reaproveitada: era o assistente pessoal da MD Flooring, agora recebe
// toda mensagem nova no WhatsApp da BTech (93988147), cria card no Kanban do
// LeadPilot (client B2B Prospector) e a Lexy responde sozinha só preço/vídeo.
// Mantém o mesmo slug/URL (md-flooring-whatsapp) pra não precisar reconfigurar
// o webhook na UAZAPI -- só troca o que ela faz quando a mensagem chega.
//
// Regra do Bruno: no número da BTech só fala quem é de verdade um lead -- o
// resto é grupo/comunidade. Qualquer mensagem individual que não seja do
// próprio Bruno já conta como lead em potencial.
//
// Payload real da UAZAPI (evento "messages", confirmado em
// https://docs.uazapi.com/webhook/messages + schema OpenAPI):
// { EventType, message: { sender, sender_pn, sender_lid, chatid, fromMe,
//   isGroup, messageType, text, pushName, messageid, ... } }

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

// A Lexy agora responde livre (IA de verdade), mas só pra tirar dúvida sobre
// o sistema -- nunca negocia preço, nunca inventa política que não está
// aqui embaixo. O vídeo e o checkout já ficam no site; ela é o suporte.
const LEXY_SYSTEM = `Você é a Lexy, assistente virtual da BTech, respondendo no WhatsApp sobre o BoxCerto (sistema de controle de pátio pra oficina mecânica, por QR code).

Seu papel é só tirar dúvida. Você NUNCA:
- negocia preço, desconto ou condição especial diferente do que está aqui
- promete prazo, funcionalidade ou política que não está descrita abaixo
- inventa informação -- se não souber, diga que o Bruno (fundador) confirma direto

FATOS SOBRE O BOXCERTO:
- O que é: cada vaga da oficina tem um QR. O mecânico escaneia, fala o serviço por áudio, a IA organiza e lança a Ordem de Serviço com valor. O cliente acompanha o status pelo celular, sem instalar app.
- Preço: R$670 no 1º ano (renova a R$800/ano) ou R$67/mês sem compromisso anual. Inclui tags físicas reutilizáveis, IA do áudio, e implantação presencial.
- Como ver funcionando: vídeo de 30s em https://ver.contatobtech.com.br
- Como assinar: pelo link de checkout no mesmo site (botão "Assinar agora"), via Hotmart -- aceita Pix, boleto e cartão (até 12x).
- Depois do pagamento: a Hotmart confirma a compra por e-mail. Como o BoxCerto precisa de tags físicas instaladas na oficina, o Bruno entra em contato pra agendar a implantação presencial (geralmente em Brasília-DF e região).
- Cancelamento: pode cancelar a assinatura direto na área de membros da Hotmart (vem no e-mail de confirmação da compra), a qualquer momento. Garantia de 7 dias (direito de arrependimento padrão).
- Dúvida técnica fora disso, ou pedido de condição especial: diga que vai confirmar com o Bruno e que ele retorna.

Responda curto (2-4 frases), tom direto e simpático, como mensagem de WhatsApp de verdade. Pode usar emoji com moderação.`;

async function geraRespostaLexy(text: string): Promise<string | null> {
  const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
  if (!OPENAI_API_KEY) return null;
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: LEXY_SYSTEM },
        { role: "user", content: text },
      ],
      temperature: 0.4,
      max_tokens: 220,
    }),
  });
  if (!res.ok) throw new Error(`OpenAI falhou: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || null;
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

  // A UAZAPI resolve o LID pro número real sozinha quando possível: o campo
  // sender_pn já vem com o JID de telefone resolvido, mesmo quando o remetente
  // aparece como LID (sender_lid). Usa sender_pn primeiro; só cai pro
  // sender/chatid (que pode ser o LID puro) se sender_pn não vier.
  const senderJid: string = msg.sender_pn || msg.sender || msg.chatid || "";
  const isLid = !msg.sender_pn && /@lid$/i.test(msg.sender || msg.chatid || "");
  const phone = senderJid.replace(/@.*/, "").replace("+", "");
  const nome = msg.pushName || msg.pushname || msg.senderName || "";
  const messageId: string = msg.messageid || msg.id || "";

  let text: string = msg.text || msg.caption || "";
  if (!text.trim() && ["audiomessage", "pttmessage", "audio", "ptt", "voice", "voicemessage"].includes(messageType)) {
    try {
      text = await transcreveAudio(messageId);
    } catch (e) {
      console.error("transcrição de áudio falhou:", e);
    }
  }
  if (!phone) return new Response("ok", { status: 200 });

  const produto = detectProduct(text);
  const origemBase = text.trim() ? `WhatsApp — "${text.trim().slice(0, 80)}"` : "WhatsApp";
  const origem = isLid ? `⚠️ LID, sem telefone direto — ${origemBase}` : origemBase;

  console.log("BTECH-LEAD:", phone, "|", nome, "| produto:", produto, "| tipo:", messageType);

  try {
    await criarCardLeadPilot(phone, nome, produto, origem);
  } catch (e) {
    console.error("btech-leads (LeadPilot) error:", e);
  }

  if (!isLid && text.trim()) {
    try {
      const resposta = await geraRespostaLexy(text);
      if (resposta) {
        await enviarTexto(phone, resposta);
        console.log("LEXY-AUTO-REPLY:", phone);
      }
    } catch (e) {
      console.error("lexy auto-reply error:", e);
    }
  }

  return new Response("ok", { status: 200 });
});

// Cria card no Kanban do LeadPilot (client B2B Prospector, mesmo do iVox).
async function criarCardLeadPilot(phone: string, nome: string, produto: string, origem: string) {
  const res = await fetch("https://leads.btechsouto.shop/webhook/btech-lead", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-btech-secret": "btech-lead-2026" },
    body: JSON.stringify({ phone, nome, produto, origem }),
  });
  if (!res.ok) throw new Error(`LeadPilot webhook falhou: ${res.status} ${await res.text()}`);
}

async function enviarTexto(phone: string, text: string) {
  const UAZAPI_URL = Deno.env.get("UAZAPI_URL") || "https://btechsoutoshop.uazapi.com";
  const UAZAPI_TOKEN = Deno.env.get("UAZAPI_TOKEN");
  if (!UAZAPI_TOKEN) throw new Error("Falta o secret UAZAPI_TOKEN nesta function");
  // delay em ms: a UAZAPI mostra "Digitando..." nesse tempo antes de entregar --
  // evita resposta instantânea demais (sinal clássico de bot, risco de banimento).
  // Varia aleatório pra não ficar sempre o mesmo tempo redondo.
  const delay = 2500 + Math.floor(Math.random() * 3500);
  const res = await fetch(`${UAZAPI_URL}/send/text`, {
    method: "POST",
    headers: { "Content-Type": "application/json", token: UAZAPI_TOKEN },
    body: JSON.stringify({ number: phone, text, delay }),
  });
  if (!res.ok) throw new Error(`UAZAPI send falhou: ${res.status} ${await res.text()}`);
}

// Baixa o áudio pela UAZAPI e transcreve com o Whisper da OpenAI.
async function transcreveAudio(messageId: string): Promise<string> {
  if (!messageId) return "";
  const UAZAPI_URL = Deno.env.get("UAZAPI_URL") || "https://btechsoutoshop.uazapi.com";
  const UAZAPI_TOKEN = Deno.env.get("UAZAPI_TOKEN");
  const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
  if (!UAZAPI_TOKEN || !OPENAI_API_KEY) return "";

  const dlRes = await fetch(`${UAZAPI_URL}/message/download`, {
    method: "POST",
    headers: { "Content-Type": "application/json", token: UAZAPI_TOKEN },
    body: JSON.stringify({ id: messageId }),
  });
  if (!dlRes.ok) { console.error("download áudio falhou:", dlRes.status, await dlRes.text()); return ""; }
  const { fileURL } = await dlRes.json();
  if (!fileURL) return "";

  const audioRes = await fetch(fileURL);
  if (!audioRes.ok) return "";
  const audioBlob = await audioRes.blob();

  const form = new FormData();
  form.append("file", audioBlob, "audio.ogg");
  form.append("model", "whisper-1");
  form.append("language", "pt");

  const whisperRes = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: form,
  });
  if (!whisperRes.ok) { console.error("whisper falhou:", whisperRes.status, await whisperRes.text()); return ""; }
  const data = await whisperRes.json();
  return data.text || "";
}
