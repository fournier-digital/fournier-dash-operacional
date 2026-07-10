/* ==========================================================================
 * INTEGRAÇÃO: LTV / CHURN / SAÍDAS (Google Sheet, lida via proxy/CSV)
 *
 * A planilha tem uma aba-MESTRE ("Clientes_Ativos_e_Inativos") com TODOS os
 * clientes — ativos + inativos (os que saíram) — cada linha com data de início,
 * data final (encerramento), situação, motivo da saída e "Meses ativo" (tempo
 * de vida). As abas por squad ("Squad Azul"/"Laranja") só listam ATIVOS, então
 * a base de saídas/LTV é a aba-mestre. Como ela NÃO separa as saídas por squad,
 * as métricas de LTV/churn/saídas são da EMPRESA (Azul + Laranja juntos).
 *
 * O painel calcula sozinho:
 *   • LTV médio  — média do tempo de vida (meses) de TODOS os clientes, calculado
 *                  AO VIVO por início→(saída ou hoje) a cada carga (a coluna
 *                  "Meses ativo" da planilha vira só fallback se faltar a data).
 *   • LTV 2m+    — média do tempo de vida só de quem passou de 2 meses.
 *   • Churn      — saídas por CHURN (motivo = churn), separado de "fim de contrato".
 *   • Saídas     — total de inativos + distribuição por motivo.
 *   • Clientes Out — a lista dos que saíram (motivo, "por que saiu", datas, tempo).
 *
 * Colunas detectadas por palavra-chave (tolerante); "Testar" mostra o que leu.
 * Config (config[squad].ltv): { link }
 * ========================================================================== */
(function () {
  const FD = (window.FD = window.FD || {});
  const norm = FD.clientes.norm;
  const nomeCanonico = FD.clientes.nomeCanonico;

  // Aba-mestre (ativos + inativos). Tenta variações; por fim a aba padrão do link.
  const ABAS_MESTRE = [
    "Clientes_Ativos_e_Inativos", "Clientes Ativos e Inativos", "clientes ativos e inativos",
    "Ativos e Inativos", "Clientes Ativos/Inativos", "Base de Clientes", "Clientes",
  ];
  const MS_MES = 30.44 * 864e5;

  const colIdx = (headers, re) => (headers || []).findIndex((h) => re.test(norm(h)));
  const cel = FD.lib.cel; // (era cópia local; agora compartilhada em format.js)

  // NOTA: intencionalmente diferente do parseData do nps.js — aqui datas ISO com hora são
  // tratadas como data-só (contrato/saída). NÃO consolidar com o do NPS (que preserva a hora).
  function parseData(v) {
    const s = String(v == null ? "" : v).trim();
    if (!s) return null;
    const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (iso) { const d = new Date(+iso[1], +iso[2] - 1, +iso[3]); return isNaN(d.getTime()) ? null : d.getTime(); }
    const m = s.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/); // dd/mm/aaaa
    if (m) { let y = +m[3]; if (y < 100) y += 2000; const mes = +m[2], dia = +m[1]; if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return null; const d = new Date(y, mes - 1, dia); return isNaN(d.getTime()) ? null : d.getTime(); }
    const d = new Date(s); return isNaN(d.getTime()) ? null : d.getTime();
  }
  const numMeses = (v) => { const s = String(v == null ? "" : v).replace(",", ".").replace(/[^\d.-]/g, ""); const n = Number(s); return (s !== "" && !isNaN(n)) ? n : null; };
  // situação/coluna que indica que o cliente SAIU (inativo).
  const textoInativo = (v) => /inativ|saiu|saida|cancel|churn|encerr|desligad|perdid|rescind/.test(norm(v));
  // é CHURN (saída ruim) pela COLUNA de motivo — separado de "fim de contrato" (natural),
  // igual ao Dashboard da planilha (categoria "Churn").
  const ehChurn = (motivo) => /churn/.test(norm(motivo));
  // Squad a partir de uma célula de texto ("Squad Azul", "azul", "Laranja"…) — usado
  // para o LTV por squad quando a planilha traz a coluna. Sem match -> null.
  const normSquad = (v) => { const n = norm(v); if (/laranja|orange/.test(n)) return "laranja"; if (/azul|blue/.test(n)) return "azul"; return null; };

  async function lerAba(link, aba) {
    const params = ["src=ltv"]; // sem url -> o servidor usa o ltv_link do Supabase
    if (link) params.push(`url=${encodeURIComponent(link)}`);
    if (aba) params.push(`sheet=${encodeURIComponent(aba)}`);
    const resp = await fetch(`/api/sheet/azul?${params.join("&")}`); // o segmento do squad é só placeholder (usamos ?url=)
    let data = null; try { data = await resp.json(); } catch (e) { data = null; }
    if (!resp.ok) throw new Error((data && data.error) || `HTTP ${resp.status}`);
    return data; // { headers, rows, vazio? }
  }
  async function lerMestre(link) {
    for (const aba of ABAS_MESTRE) {
      try { const d = await lerAba(link, aba); if (d && !d.vazio && d.rows && d.rows.length) return { data: d, aba }; } catch (e) { /* próxima */ }
    }
    try { const d = await lerAba(link, null); if (d && d.rows && d.rows.length) return { data: d, aba: "(aba padrão do link)" }; } catch (e) { /* sem fallback */ }
    return null;
  }

  function mapearColunas(headers) {
    const iNome = colIdx(headers, /cliente|escola|colegio|instituic|nome|unidade/);
    return {
      iNome: iNome >= 0 ? iNome : 0,
      iEntrada: colIdx(headers, /data de inicio|inicio|entrada|comeco|adesao|data.*inic/),
      iSaida: colIdx(headers, /data final|encerrament|data.*fim|termino|data.*sai|saida/),
      iSituacao: colIdx(headers, /situacao|status|estado/),
      iMotivo: colIdx(headers, /motivo/),
      iPorque: colIdx(headers, /por que|porque|por.?que saiu/),
      iMeses: colIdx(headers, /meses ativo|meses de casa|tempo.*casa|\bmeses\b|\bltv\b/),
      iSquad: colIdx(headers, /squad|equipe|celula|\bgrupo\b|\btime\b/),
      // Fim de CONTRATO (renovação) — exige o contexto "contrato"/"renova" p/ não
      // colidir com a coluna de saída/encerramento (iSaida).
      iFimContrato: colIdx(headers, /fim.*contrato|contrato.*fim|contrato.*termino|vencimento.*contrato|renova/),
    };
  }

  function parseLinhas(headers, rows) {
    const C = mapearColunas(headers);
    const hoje = FD.NOW.getTime();
    const out = [];
    for (const r of rows) {
      const nome = cel(r, C.iNome);
      // pula vazios e linhas de seção/agregação ("CLIENTES ATIVOS", "TOTAL", "MÉDIA"…)
      if (!nome || /^(total|m[eé]dia|resumo|situa|clientes (ativos|inativos)|base)\b/.test(norm(nome))) continue;
      const entradaMs = C.iEntrada >= 0 ? parseData(r[C.iEntrada]) : null;
      const mesesCol = C.iMeses >= 0 ? numMeses(r[C.iMeses]) : null;
      const saidaMs = C.iSaida >= 0 ? parseData(r[C.iSaida]) : null;
      const situacao = cel(r, C.iSituacao);
      const saiu = textoInativo(situacao) || !!saidaMs;
      // Cliente real = tem data de início OU já saiu (ignora linhas em branco).
      if (entradaMs == null && !saiu) continue;
      const fimMs = saidaMs || hoje;
      // LTV AO VIVO: tempo de vida = início -> (saída ou HOJE), recalculado a cada
      // carga. Não depende de ninguém atualizar a coluna "Meses ativo" na planilha
      // (essa vira só fallback quando a data de início está faltando).
      const tenureDatas = entradaMs != null ? Math.max(0, Math.round(((fimMs - entradaMs) / MS_MES) * 10) / 10) : null;
      const tenureMeses = tenureDatas != null ? tenureDatas : (mesesCol != null ? Math.round(mesesCol * 10) / 10 : null);
      const motivo = cel(r, C.iMotivo);
      const porque = cel(r, C.iPorque);
      const squad = C.iSquad >= 0 ? normSquad(cel(r, C.iSquad)) : null; // squad da planilha (se houver a coluna)
      const fimContratoMs = C.iFimContrato >= 0 ? parseData(r[C.iFimContrato]) : null; // fim de contrato = 2ª fonte de renovação
      out.push({
        nome, canon: nomeCanonico(nome),
        entradaMs, saidaMs, saiu, situacao,
        motivo: motivo || (saiu ? "(sem motivo informado)" : ""),
        porque,
        churn: saiu && ehChurn(motivo),
        tenureMeses, tenureDatas, mesesCol,
        squad, fimContratoMs,
        ltv: null, valorMensal: null, // esta planilha não tem valor $ -> LTV é em MESES
      });
    }
    return { colunas: C, clientes: out };
  }

  function resumir(clientes) {
    const total = clientes.length;
    const saidasL = clientes.filter((c) => c.saiu);
    const churnL = saidasL.filter((c) => c.churn);
    const med = (a) => { const v = a.filter((x) => x != null); return v.length ? Math.round((v.reduce((s, x) => s + x, 0) / v.length) * 100) / 100 : null; };
    const tens = clientes.map((c) => c.tenureMeses);
    const t2 = clientes.filter((c) => c.tenureMeses != null && c.tenureMeses >= 2);
    const motivosMap = {};
    saidasL.forEach((c) => { const m = c.motivo || "(sem motivo informado)"; motivosMap[m] = (motivosMap[m] || 0) + 1; });
    const motivos = Object.keys(motivosMap).map((m) => ({ motivo: m, n: motivosMap[m] })).sort((a, b) => b.n - a.n);
    return {
      total, ativos: total - saidasL.length, saidas: saidasL.length,
      churn: churnL.length,
      churnRate: total ? Math.round((churnL.length / total) * 1000) / 10 : 0,
      saidaRate: total ? Math.round((saidasL.length / total) * 1000) / 10 : 0,
      ltvMedio: med(tens),              // meses
      ltv2m: med(t2.map((c) => c.tenureMeses)),
      retidos2m: t2.length,
      moeda: false,                     // LTV em MESES (planilha sem valor $)
      motivos,
    };
  }

  FD.integrations.ltv = {
    nome: "LTV / Churn / Saídas",
    descricao: "LTV médio, churn e clientes que saíram (aba mestre — empresa)",
    campos: [{ key: "link", label: "Link da planilha de LTV / Saídas", placeholder: "https://docs.google.com/spreadsheets/..." }],
    conectado(squad) { const c = FD.config?.[squad]?.ltv; return !!(c && c.link); },
    resumir, parseLinhas,

    async inspect(squad, link) {
      const lk = link || (FD.config?.[squad]?.ltv?.link);
      if (!lk) throw new Error("Sem link da planilha de LTV.");
      const res = await lerMestre(lk);
      if (!res) throw new Error("Não consegui ler a aba de clientes. Confira o compartilhamento ('qualquer pessoa com o link pode ver') — a aba esperada é 'Clientes_Ativos_e_Inativos'.");
      const p = parseLinhas(res.data.headers || [], res.data.rows || []);
      return { aba: res.aba, headers: res.data.headers || [], colunas: p.colunas, clientes: p.clientes, resumo: resumir(p.clientes) };
    },

    // Global: uma leitura (a planilha não separa saídas por squad).
    async fetchGlobal(link) {
      if (!link && !(FD.integrations.serverTem("azul", "ltv") || FD.integrations.serverTem("laranja", "ltv"))) return null;
      try {
        const res = await lerMestre(link);
        if (!res) return null;
        const p = parseLinhas(res.data.headers || [], res.data.rows || []);
        return { source: "ltv", aba: res.aba, colunas: p.colunas, clientes: p.clientes, resumo: resumir(p.clientes) };
      } catch (e) { console.warn("[ltv] falhou:", e.message); return null; }
    },
    async fetch(squad) { // compat: usa o link do squad, mas lê a aba-mestre (global)
      if (!this.conectado(squad)) return null;
      return this.fetchGlobal(FD.config[squad].ltv.link);
    },
  };
})();
