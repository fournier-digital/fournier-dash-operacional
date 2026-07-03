/* ==========================================================================
 * INTEGRAÇÃO: Google Agenda — reuniões por cliente
 *
 * O cliente de cada reunião sai do TÍTULO do evento (tema + nome do cliente).
 * A agenda precisa ser PÚBLICA (a API key só lê calendário público).
 *
 * Credenciais por squad: config[squad].googleCalendar = { calendarId, apiKey }
 * Navegador -> proxy local (server.py) -> Google Calendar API:
 *   /api/gcal/<squad>/events?calendarId=...   (header X-GC-Key: <apiKey>)
 *   /api/gcal/<squad>/inspect?calendarId=...
 * ========================================================================== */
(function () {
  const FD = (window.FD = window.FD || {});

  async function chamarProxy(acao, { apiKey, calendarId, squad }) {
    if (!apiKey) throw new Error("Preencha a API Key do Google.");
    if (!calendarId) throw new Error("Preencha o Calendar ID.");
    const url = `/api/gcal/${encodeURIComponent(squad)}/${acao}?calendarId=${encodeURIComponent(calendarId)}`;
    let resp;
    try {
      resp = await fetch(url, { headers: { "X-GC-Key": apiKey } });
    } catch (e) {
      throw new Error("Não consegui falar com o proxy local. O servidor está rodando? (python3 server.py)");
    }
    let data = null;
    try { data = await resp.json(); } catch (e) { data = null; }
    if (!resp.ok) {
      const msg = data && data.error ? data.error : `HTTP ${resp.status}`;
      const det = data && data.detalhe ? ` — ${String(data.detalhe).slice(0, 240)}` : "";
      throw new Error(msg + det);
    }
    return data;
  }

  FD.integrations.googleCalendar = {
    nome: "Google Agenda",
    descricao: "Reuniões (o cliente vem do título do evento)",
    campos: [
      { key: "calendarId", label: "Calendar ID", placeholder: "abc@group.calendar.google.com" },
      { key: "apiKey", label: "API Key", placeholder: "AIza...", tipo: "password" },
    ],
    conectado(squad) {
      const c = FD.config?.[squad]?.googleCalendar;
      return !!(c && c.calendarId && c.apiKey);
    },
    async inspect(creds) {
      return chamarProxy("inspect", creds);
    },
    async fetch(squad) {
      if (!this.conectado(squad)) return null;
      const { apiKey, calendarId } = FD.config[squad].googleCalendar;
      try {
        const { events } = await chamarProxy("events", { apiKey, calendarId, squad });
        return { source: "googleCalendar", eventos: events || [] };
      } catch (e) {
        console.warn("[gcal] fetch falhou:", e.message);
        return null;
      }
    },
  };
})();
