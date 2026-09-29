import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

// Assistente pessoal do Bruno via WhatsApp pra organizar leads da MD Flooring
// Solutions que chegam por fora do fluxo automático (SMS/telefone direto,
// não passam pelo webhook do Thumbtack/site). Mesmo padrão do gz-whatsapp
// (GastoZap): recebe áudio/texto, extrai dados com IA, mas aqui o
// salvamento em si é feito chamando a própria API do LeadPilot (endpoint
// protegido por ADMIN_KEY) -- evita guardar uma chave de banco de outro
// projeto Supabase dentro desta função.

const UAZAPI_BASE = "https://btechsoutoshop.uazapi.com";
const LEADPILOT_API = "https://leads.btechsouto.shop";
const MD_FLOORING_CLIENT_ID = "2b917476-bda9-4e5e-9f4e-6bd0d1238b5a";
// Só o Bruno usa esse assistente -- qualquer outro remetente é ignorado.
const AUTHORIZED_PHONE = "5561982025951";

serve(async (req) => {
  if (req.method !== "POST") return new Response("ok", { status: 200 });

  let body: any;
  try { body = await req.json(); } catch { return new Response("ok", { status: 200 }); }

  // UAZAPI pode enviar payload na raiz OU em body.data (mesma variação do gz-whatsapp)
  const data = body?.data ?? body;
  if (!data || data?.key?.fromMe === true) return new Response("ok", { status: 200 });

  const remoteJid: string = data?.key?.remoteJid || "";
  if (remoteJid.endsWith("@g.us")) return new Response("ok", { status: 200 });

  const phone = remoteJid.replace("@s.whatsapp.net", "").replace("+", "");
  if (phone !== AUTHORIZED_PHONE) return new Response("ok", { status: 200 });

  const messageType: string = data?.messageType || "conversation";
  const messageId: string = data?.key?.id || "";

  const UAZAPI_TOKEN = Deno.env.get("UAZAPI_TOKEN")!;
  const OPENAI_KEY = Deno.env.get("OPENAI_API_KEY")!;
  const ADMIN_KEY = Deno.env.get("LEADPILOT_ADMIN_KEY")!;

  try {
    let text = "";
    if (messageType === "conversation" || messageType === "extendedTextMessage") {
      text = data.message?.conversation || data.message?.extendedTextMessage?.text || "";
    } else if (messageType === "audioMessage") {
      text = await transcreverAudio(messageId, UAZAPI_TOKEN);
      if (!text) {
        await replyText(phone, "Não consegui transcrever o áudio. Manda por texto?", UAZAPI_TOKEN);
        return new Response("ok", { status: 200 });
      }
    } else {
      return new Response("ok", { status: 200 });
    }

    if (!text.trim()) return new Response("ok", { status: 200 });

    const campos = await extrairLead(text, OPENAI_KEY);
    if (!campos || !campos.cliente_nome) {
      await replyText(phone, "Não entendi o cliente/orçamento. Tenta de novo com o nome do cliente?", UAZAPI_TOKEN);
      return new Response("ok", { status: 200 });
    }

    const resp = await fetch(`${LEADPILOT_API}/api/cron/manual-lead`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-key": ADMIN_KEY },
      body: JSON.stringify({
        client_id: MD_FLOORING_CLIENT_ID,
        acao: campos.acao,
        cliente_nome: campos.cliente_nome,
        telefone: campos.telefone,
        resumo: campos.resumo,
        data_retorno_iso: parseDataBR(campos.data_retorno),
        endereco: campos.endereco,
        service_type: "flooring",
      }),
    });
    const result = await resp.json();

    if (!resp.ok || !result.ok) {
      await replyText(phone, "Erro ao salvar no Kanban: " + (result.error || resp.status), UAZAPI_TOKEN);
      return new Response("ok", { status: 200 });
    }

    const aviso = result.warning ? `⚠️ ${result.warning}\n\n` : "";
    await replyText(phone,
      `${aviso}✅ ${result.message}` +
      (campos.data_retorno ? `\n📅 Retorno: ${campos.data_retorno}` : "") +
      (campos.telefone ? `\n📞 ${campos.telefone}` : ""),
      UAZAPI_TOKEN);
  } catch (e) {
    console.error("md-flooring-whatsapp error:", e);
    await replyText(phone, "Erro ao processar. Tenta de novo em instantes.", UAZAPI_TOKEN);
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
    console.log("UAZAPI-SEND:", resp.status);
  } catch (e) {
    console.error("replyText error:", e);
  }
}

// Transcrição embutida da própria UAZAPI (POST /message/download com
// transcribe:true) -- mais simples que baixar base64 e chamar Whisper na mão.
async function transcreverAudio(messageId: string, token: string): Promise<string> {
  if (!messageId) return "";
  try {
    const resp = await fetch(`${UAZAPI_BASE}/message/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "token": token },
      body: JSON.stringify({ id: messageId, transcribe: true }),
    });
    if (!resp.ok) return "";
    const json = await resp.json();
    return json.transcription || "";
  } catch (e) {
    console.error("transcreverAudio error:", e);
    return "";
  }
}

// ─── OpenAI ──────────────────────────────────────────────────────────────────

async function extrairLead(text: string, apiKey: string): Promise<{
  acao: "novo" | "atualizar"; cliente_nome: string; telefone: string | null;
  resumo: string; data_retorno: string | null; endereco: string | null;
} | null> {
  const hoje = new Date().toLocaleDateString("pt-BR", { timeZone: "America/New_York" });
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      max_tokens: 400,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `Você organiza leads de orçamento de piso (MD Flooring Solutions) a partir de um áudio/texto do Bruno. Extraia e retorne APENAS JSON:
{"acao":"novo"|"atualizar","cliente_nome":"string","telefone":"string ou null","resumo":"string curto do que foi combinado","data_retorno":"DD/MM/YYYY ou null","endereco":"string ou null"}
"acao" é "atualizar" só se o texto disser explicitamente pra atualizar/adicionar em um cliente que já existe; caso contrário "novo".
Data de hoje: ${hoje}. Converta datas relativas (ex: "quinta que vem", "dia 6") pra DD/MM/YYYY usando essa referência.`,
        },
        { role: "user", content: text },
      ],
    }),
  });
  if (!resp.ok) return null;
  const json = await resp.json();
  try { return JSON.parse(json.choices?.[0]?.message?.content || "{}"); } catch { return null; }
}

function parseDataBR(dateStr: string | null): string | null {
  if (!dateStr) return null;
  const m = dateStr.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}
