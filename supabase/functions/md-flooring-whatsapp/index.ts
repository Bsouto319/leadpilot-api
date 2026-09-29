import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

// Assistente pessoal do Bruno via WhatsApp pra organizar leads da MD Flooring
// Solutions que chegam por fora do fluxo automático (SMS/telefone direto,
// não passam pelo webhook do Thumbtack/site). A extração por IA e o
// salvamento acontecem no próprio LeadPilot (endpoint protegido por
// ADMIN_KEY, já tem a chave da OpenAI configurada) -- essa função só precisa
// falar com a UAZAPI.
//
// Payload real da UAZAPI (evento "messages", confirmado em
// https://docs.uazapi.com/webhook/messages -- NÃO é o formato
// body.data.key.remoteJid que o gz-whatsapp assume, esse formato causava
// falha silenciosa: remoteJid/messageType vinham undefined):
// { EventType, message: { sender, chatid, fromMe, isGroup, messageType,
//   text, messageid, ... } }

const UAZAPI_BASE = "https://btechsoutoshop.uazapi.com";
const LEADPILOT_API = "https://leads.btechsouto.shop";
const MD_FLOORING_CLIENT_ID = "2b917476-bda9-4e5e-9f4e-6bd0d1238b5a";
// Só o Bruno usa esse assistente -- qualquer outro remetente é ignorado.
// O WhatsApp às vezes identifica o remetente pelo número normal (@s.whatsapp.net)
// e às vezes por um LID (@lid, um ID interno opaco, não é o número de telefone) --
// aceita os dois, descobertos testando com mensagem real (não dá pra prever o LID).
const AUTHORIZED_IDS = ["5561982025951", "167091525132392"];
// Responder sempre pro número de telefone de verdade -- mandar reply pro LID
// não funciona no envio da UAZAPI (só serve pra identificar remetente recebido).
const REPLY_PHONE = "5561982025951";

serve(async (req) => {
  if (req.method !== "POST") return new Response("ok", { status: 200 });

  let body: any;
  try { body = await req.json(); } catch { return new Response("ok", { status: 200 }); }

  const msg = body?.message;
  if (!msg || msg.fromMe === true || msg.isGroup === true) return new Response("ok", { status: 200 });

  const senderJid: string = msg.sender || msg.chatid || "";
  const phone = senderJid.replace(/@.*/, "").replace("+", "");
  const messageType = String(msg.messageType || "").toLowerCase();
  const messageId: string = msg.messageid || msg.id || "";
  console.log("MDF-DEBUG sender:", senderJid, "| phone:", phone, "| type:", messageType);

  if (!AUTHORIZED_IDS.includes(phone)) {
    console.log("MDF-DEBUG rejected: id not authorized:", phone);
    return new Response("ok", { status: 200 });
  }

  const UAZAPI_TOKEN = Deno.env.get("UAZAPI_TOKEN")!;
  const ADMIN_KEY = Deno.env.get("LEADPILOT_ADMIN_KEY")!;

  try {
    let payload: any = { client_id: MD_FLOORING_CLIENT_ID, service_type: "flooring", timezone: "America/New_York" };

    if (messageType === "conversation" || messageType === "extendedtextmessage") {
      const text = msg.text || "";
      if (!text.trim()) return new Response("ok", { status: 200 });
      payload.raw_text = text;
    } else if (messageType === "audiomessage") {
      // Só baixa (fileURL) -- a UAZAPI não transcreve porque a instância não
      // tem chave de IA própria configurada. Quem transcreve é o LeadPilot,
      // que já tem a chave certa (Whisper via services/openai.js).
      const audioUrl = await baixarAudio(messageId, UAZAPI_TOKEN);
      if (!audioUrl) {
        await replyText(REPLY_PHONE, "Não consegui baixar o áudio. Manda por texto?", UAZAPI_TOKEN);
        return new Response("ok", { status: 200 });
      }
      payload.audio_url = audioUrl;
    } else {
      console.log("MDF-DEBUG ignored messageType:", messageType);
      return new Response("ok", { status: 200 });
    }

    const resp = await fetch(`${LEADPILOT_API}/api/cron/manual-lead`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-key": ADMIN_KEY },
      body: JSON.stringify(payload),
    });
    const result = await resp.json();

    if (!resp.ok || !result.ok) {
      await replyText(REPLY_PHONE, "⚠️ " + (result.error || `Erro ${resp.status}`), UAZAPI_TOKEN);
      return new Response("ok", { status: 200 });
    }

    const aviso = result.warning ? `⚠️ ${result.warning}\n\n` : "";
    await replyText(REPLY_PHONE, `${aviso}✅ ${result.message}`, UAZAPI_TOKEN);
  } catch (e) {
    console.error("md-flooring-whatsapp error:", e);
    await replyText(REPLY_PHONE, "Erro ao processar. Tenta de novo em instantes.", UAZAPI_TOKEN);
  }

  return new Response("ok", { status: 200 });
});

// ─── UAZAPI ──────────────────────────────────────────────────────────────────

async function replyText(phone: string, text: string, token: string) {
  try {
    const resp = await fetch(`${UAZAPI_BASE}/send/text`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "token": token },
      body: JSON.stringify({ number: phone, text }),
    });
    console.log("MDF UAZAPI-SEND:", resp.status);
  } catch (e) {
    console.error("replyText error:", e);
  }
}

// Pega só a URL pública do áudio (POST /message/download, sem transcribe --
// a instância da UAZAPI não tem chave de IA própria, transcribe:true
// voltava vazio sem erro nenhum). O LeadPilot baixa e transcreve com o
// Whisper dele, que já tem a chave certa configurada.
async function baixarAudio(messageId: string, token: string): Promise<string> {
  if (!messageId) return "";
  try {
    const resp = await fetch(`${UAZAPI_BASE}/message/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "token": token },
      body: JSON.stringify({ id: messageId }),
    });
    if (!resp.ok) {
      console.log("MDF-DEBUG download failed:", resp.status, await resp.text());
      return "";
    }
    const json = await resp.json();
    return json.fileURL || "";
  } catch (e) {
    console.error("baixarAudio error:", e);
    return "";
  }
}
