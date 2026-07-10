/* ==========================================================================
 * INTEGRAÇÃO: CONTROLE / ONBOARDING (Google Sheet, lida via proxy/CSV)
 *
 * Planilha "FD - Controle Clientes Onboarding" com 1 aba por squad
 * ("Squad Azul" / "Squad Laranja"; fallback: aba padrão do link).
 * Cada linha = um cliente. Colunas (status em texto):
 *   Clientes | Data de início | Onboarding | Forms | Plano de Ação | Material |
 *   Criativos | Meta Ads | Google Meu Negócio | Campanha Google | Cronograma |
 *   Posicionamento de Marca | Treinamento de Atendimento |
 *   Orientações para o Instagram | Mentoria retenção e rematrículas | Linha Editorial
 *
 * PRIORIDADE = planilha (onboarding + entregáveis + Linha Editorial + Campanha
 * Google). Quem NÃO está na planilha mantém o que vem do ClickUp.
 *
 * Config (config[squad].controle): { link }
 * ========================================================================== */
(function () {
  const FD = (window.FD = window.FD || {});
  const norm = FD.clientes.norm;
  const nomeCanonico = FD.clientes.nomeCanonico;

  // Colunas que formam o CHECKLIST de onboarding (cada uma = um passo, com status).
  const PASSOS = ["Onboarding", "Forms", "Plano de Ação", "Material", "Criativos", "Meta Ads", "Google Meu Negócio", "Campanha Google", "Cronograma"];
  // 4 "entregáveis de reuniões" (feito / não feito).
  const ENTREGAVEIS = ["Posicionamento de Marca", "Treinamento de Atendimento", "Orientações para o Instagram", "Mentoria retenção e rematrículas"];
  // Abas por squad (tenta variações de grafia).
  const ABAS = { azul: ["Squad Azul", "squad azul", "Azul"], laranja: ["Squad Laranja", "squad laranja", "Laranja"] };

  // Status em texto -> feito? (vazio=pendente; "sem google"/"não fazemos"=N/A não conta;
  // "tentando/ainda não/em andamento/aguardando"=pendente; qualquer outro texto=feito).
  function statusFeito(valor) {
    const v = norm(valor);
    if (!v) return { feito: false, na: false };
    if (/sem google|nao fazemos/.test(v)) return { feito: true, na: true };
    if (/tentando|ainda nao|em andamento|aguardando|nao enviou|pendente|nao$/.test(v)) return { feito: false, na: false };
    return { feito: true, na: false };
  }

  // "Fora do padrão": a célula traz uma OBSERVAÇÃO de como é feito naquele cliente
  // específico (ex.: Onis -> "Não fazemos os criativos"). Deve ser destacada.
  function ehExcecao(valor) {
    const v = norm(valor);
    if (!v) return false;
    return /nao fazemos|nao fazem|nao faz|nao aplic|nao se aplica|cliente (faz|envia|fornece|cuida|manda|tem)|por conta|propri|terceir|externo|fora do padrao|exce[cs]/.test(v);
  }

  const colIdx = (headers, nome) => { const a = norm(nome); return (headers || []).findIndex((h) => norm(h) === a); };
  const cel = FD.lib.cel; // (era cópia local; agora compartilhada em format.js)

  async function lerAba(squad, link, aba) {
    const params = ["src=controle"]; // sem url -> o servidor usa o controle_link do Supabase
    if (link) params.push(`url=${encodeURIComponent(link)}`);
    if (aba) params.push(`sheet=${encodeURIComponent(aba)}`);
    const resp = await fetch(`/api/sheet/${encodeURIComponent(squad)}?${params.join("&")}`);
    let data = null; try { data = await resp.json(); } catch (e) { data = null; }
    if (!resp.ok) throw new Error((data && data.error) || `HTTP ${resp.status}`);
    return data; // { headers, rows, vazio? }
  }

  // Lê a aba do squad (tenta variações); se nenhuma, cai na aba padrão do link.
  // Retorna { data, aba } (aba = qual nome funcionou) ou null.
  async function lerSquad(squad, link) {
    for (const aba of (ABAS[squad] || [])) {
      try { const d = await lerAba(squad, link, aba); if (d && !d.vazio && d.rows && d.rows.length) return { data: d, aba }; } catch (e) { /* próxima */ }
    }
    try { const d = await lerAba(squad, link, null); if (d && d.rows && d.rows.length) return { data: d, aba: "(aba padrão do link)" }; } catch (e) { /* sem fallback */ }
    return null;
  }

  function parseLinhas(headers, rows) {
    const iNome = colIdx(headers, "Clientes") >= 0 ? colIdx(headers, "Clientes") : 0;
    const iInicio = colIdx(headers, "Data de início");
    const iLinha = colIdx(headers, "Linha Editorial");
    const iGoogle = colIdx(headers, "Campanha Google");
    const passos = PASSOS.map((p) => ({ label: p, idx: colIdx(headers, p) })).filter((p) => p.idx >= 0);
    const entreg = ENTREGAVEIS.map((p) => ({ label: p, idx: colIdx(headers, p) })).filter((p) => p.idx >= 0);
    const out = [];
    for (const r of rows) {
      const nome = cel(r, iNome);
      if (!nome) continue;
      const onboarding = passos.map((p) => { const val = cel(r, p.idx); const st = statusFeito(val); return { label: p.label, feito: st.feito, na: st.na, status: val, excecao: ehExcecao(val) }; });
      const entregaveis = entreg.map((p) => { const val = cel(r, p.idx); const st = statusFeito(val); return { label: p.label, feito: st.feito, status: val, excecao: ehExcecao(val) }; });
      const valGoogle = cel(r, iGoogle);
      out.push({
        nome,
        canon: nomeCanonico(nome),
        inicio: cel(r, iInicio),
        onboarding,
        entregaveis,
        linhaEditorial: cel(r, iLinha) ? "Sim" : "Não",
        campanhaGoogle: /sem google/.test(norm(valGoogle)) ? "Não" : (valGoogle || "—"),
      });
    }
    return out;
  }

  FD.integrations.controle = {
    nome: "Controle / Onboarding",
    descricao: "Onboarding, entregáveis e Linha Editorial por cliente (aba do squad)",
    campos: [{ key: "link", label: "Link da planilha de Controle/Onboarding", placeholder: "https://docs.google.com/spreadsheets/..." }],
    conectado(squad) { const c = FD.config?.[squad]?.controle; return !!(c && c.link) || FD.integrations.serverTem(squad, "controle"); },
    parseLinhas,

    // Diagnóstico p/ a aba Integrações ("Testar"): qual aba leu + amostra.
    async inspect(squad, link) {
      const lk = link || (FD.config?.[squad]?.controle?.link);
      if (!lk) throw new Error("Sem link da planilha de Controle.");
      const res = await lerSquad(squad, lk);
      if (!res) throw new Error("Não consegui ler nenhuma aba. Confira o compartilhamento ('qualquer pessoa com o link pode ver') e o nome da aba ('Squad " + (squad === "azul" ? "Azul" : "Laranja") + "').");
      const linhas = parseLinhas(res.data.headers || [], res.data.rows || []);
      return { aba: res.aba, headers: res.data.headers || [], total: linhas.length, linhas };
    },

    async fetch(squad) {
      if (!this.conectado(squad)) return null;
      const link = FD.config[squad].controle.link;
      try {
        const res = await lerSquad(squad, link);
        if (!res) return null;
        return { source: "controle", aba: res.aba, linhas: parseLinhas(res.data.headers || [], res.data.rows || []) };
      } catch (e) { console.warn("[controle] falhou:", e.message); return null; }
    },
  };
})();
