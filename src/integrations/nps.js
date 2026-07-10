/* ==========================================================================
 * INTEGRAÇÃO: NPS — duas planilhas (Google Sheets, lidas via proxy/CSV)
 *   • externa: o CLIENTE avalia nosso serviço (perguntas de 1 a 5)
 *   • interna: NOSSA nota para o cliente
 *
 * A planilha precisa estar compartilhada ("Qualquer pessoa com o link pode ver").
 * O parser detecta sozinho a coluna do NOME e as colunas de NOTA (valores 1–5),
 * tira a média e converte para a escala 0–10 do painel. Colunas que não são
 * nota (ex.: a "cheat") são ignoradas automaticamente.
 *
 * Campos (config[squad].nps): { linkInterna, linkExterna }
 * ========================================================================== */
(function () {
  const FD = (window.FD = window.FD || {});

  // Abas de mês: "Julho de 2027" (mês capitalizado + " de " + ano).
  const MESES_PT = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
  const nomeAba = (ano, mes0) => `${MESES_PT[mes0]} de ${ano}`;
  function ultimosMeses(n) {
    const base = new Date(FD.NOW); base.setDate(1);
    const out = [];
    for (let i = 0; i < n; i++) {
      const d = new Date(base.getFullYear(), base.getMonth() - i, 1);
      out.push({ ym: d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"), label: nomeAba(d.getFullYear(), d.getMonth()) });
    }
    return out; // mais recente primeiro
  }

  async function lerPlanilha(squad, which, link, sheet) {
    const params = [];
    if (link) params.push(`url=${encodeURIComponent(link)}`);
    if (sheet) params.push(`sheet=${encodeURIComponent(sheet)}`);
    const q = params.length ? `?${params.join("&")}` : "";
    const resp = await fetch(`/api/nps/${encodeURIComponent(squad)}/${which}${q}`);
    let data = null;
    try { data = await resp.json(); } catch (e) { data = null; }
    if (!resp.ok) {
      const msg = data && data.error ? data.error : `HTTP ${resp.status}`;
      throw new Error(msg + (data && data.detalhe ? ` — ${data.detalhe}` : ""));
    }
    return data; // { headers, rows, total, vazio? }
  }

  // Lê as abas dos últimos N meses ("Julho de 2027"). Só as que existem,
  // em ordem ASCENDENTE (mais antigo -> mais novo), já parseadas por mês.
  //
  // PERFORMANCE: em vez de tentar SEMPRE 2 variantes de caixa por mês (o que
  // dobrava as requisições — e todo mês ausente custava 2), descobrimos a
  // GRAFIA da aba UMA vez (no mês mais recente) e reusamos nos demais. Menos
  // meses (n=4) também: a UI usa "este mês" + média dos últimos 3.
  async function lerMeses(squad, which, link, n) {
    const meses = ultimosMeses(n || 4);
    const variante = (m, tipo) => (tipo === "lower" ? m.label.toLowerCase() : m.label);
    const carregarMes = async (m, tipo) => {
      try {
        const data = await lerPlanilha(squad, which, link, variante(m, tipo));
        if (data && !data.vazio && data.rows && data.rows.length) {
          const p = parsearNotas(data.headers || [], data.rows || [], which);
          return { ym: m.ym, label: m.label, formato: p.formato, escala: p.escala, respostas: (p.respostas || []).map((r) => ({ nome: r.nome, score: r.score, setores: r.setores, comentarios: r.comentarios })) };
        }
      } catch (e) { /* aba ausente/erro -> pula o mês */ }
      return null;
    };
    // Descobre a caixa no mês mais recente (tenta capitalizada e, se vazia, minúscula).
    // PERF: as variantes "label" de TODOS os meses já saem em paralelo com a sonda; no
    // caso comum (aba capitalizada) o resto já está no ar — corta um estágio serial
    // inteiro do caminho crítico. Se a sonda cair p/ "lower", refaz o resto em "lower"
    // (comportamento idêntico ao anterior; as respostas "label" extras são descartadas).
    const pLabel = meses.map((m) => carregarMes(m, "label"));
    const recente = meses[0];
    let mesRecente = await pLabel[0];
    let resto = null;
    if (!mesRecente) {
      const low = await carregarMes(recente, "lower");
      if (low) { mesRecente = low; resto = await Promise.all(meses.slice(1).map((m) => carregarMes(m, "lower"))); }
    }
    if (!resto) resto = await Promise.all(pLabel.slice(1));
    return [mesRecente].concat(resto).filter(Boolean).sort((a, b) => (a.ym < b.ym ? -1 : 1));
  }

  // Detecta o FORMATO da planilha e devolve { formato, nameIdx, ratingIdx, linhas },
  // onde cada linha = { nome (cliente), score (0-10), media5, votos? }.
  //  - "longo" (NPS externa): 1 coluna de NOME + colunas de nota; 1 linha por resposta.
  //  - "largo" (NPS interna): cada CLIENTE é uma COLUNA; cada linha é um colaborador.
  //            A nota do cliente = média da coluna (todos que votaram nele).
  function parsearNotas(headers, rows, which) {
    const norm = FD.clientes.norm;
    const forcaLongo = which === "externa", forcaLargo = which === "interna";
    // ESCALA detectada pela DISTRIBUIÇÃO das notas: se ≥5% passam de 5 -> 0–10;
    // senão -> 1–5 (o caso da Fournier). Robusto a um dígito errado isolado e não
    // depende de adivinhar pela fonte. 1–5 é convertida p/ exibição 0–10 dobrando.
    const rawNum = (v) => {
      const s = String(v == null ? "" : v).trim().replace(",", ".");
      if (s === "") return null;
      const n = Number(s);
      return (!isNaN(n) && n >= 0 && n <= 10) ? n : null;
    };
    let _acima5 = 0, _totN = 0;
    for (const r of rows) for (const v of r) { const n = rawNum(v); if (n != null) { _totN++; if (n > 5) _acima5++; } }
    const escala10 = _totN > 0 && (_acima5 / _totN) >= 0.05;
    const minNota = escala10 ? 0 : 1, maxNota = escala10 ? 10 : 5; // 1–5 rejeita 0 (inválido); 0–10 aceita 0 (detrator)
    // Nota válida = número na escala. VAZIO -> null (senão Number("")===0 contaria quem NÃO preencheu).
    const numNota = (v) => { const n = rawNum(v); return (n != null && n >= minNota && n <= maxNota) ? n : null; };
    const clamp = (x) => Math.max(0, Math.min(10, x));
    const r1 = (x) => Math.round(clamp(x) * 10) / 10; // 0–10 com 1 casa decimal
    const conv = (n) => (escala10 ? n : n * 2);   // 1 nota -> escala de exibição 0–10
    const score1 = (n) => r1(conv(n));
    const media = (notas) => r1(conv(notas.reduce((s, n) => s + n, 0) / notas.length));
    const mediaRaw = (notas) => Math.round((notas.reduce((s, n) => s + n, 0) / notas.length) * 100) / 100;
    const ehTimestamp = (h) => /carimbo|timestamp|data|hora/.test(norm(h));
    // NOTA: intencionalmente diferente do parseData do ltv.js — aqui "2026-07-03T10:00"
    // PRESERVA a hora (carimbo do NPS). NÃO consolidar com o do LTV (que zera a hora).
    const parseData = (v) => {
      const s = String(v == null ? "" : v).trim();
      const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
      if (iso && s.indexOf("T") < 0) { const d = new Date(+iso[1], +iso[2] - 1, +iso[3]); return isNaN(d.getTime()) ? null : d.getTime(); } // ISO data-só -> LOCAL (evita -1 dia no fuso)
      if (iso || s.indexOf("T") >= 0) { const d = new Date(s); return isNaN(d.getTime()) ? null : d.getTime(); } // ISO com hora
      const m = s.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/); // dd/mm/aaaa
      if (m) { let y = +m[3]; if (y < 100) y += 2000; const mes = +m[2], dia = +m[1]; if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return null; const d = new Date(y, mes - 1, dia); return isNaN(d.getTime()) ? null : d.getTime(); }
      const d = new Date(s); return isNaN(d.getTime()) ? null : d.getTime();
    };
    const tsIdx = (headers || []).findIndex((h) => ehTimestamp(h));

    // classifica cada coluna por % de valores numéricos 1–5 (nota) vs texto
    const cols = (headers || []).map((h, c) => {
      let num = 0, txt = 0, tot = 0;
      for (const r of rows) {
        const v = r[c];
        if (v == null || String(v).trim() === "") continue;
        tot++;
        if (numNota(v) != null) num++; else txt++;
      }
      return { c, header: h, tot, fracNum: tot ? num / tot : 0, fracTxt: tot ? txt / tot : 0 };
    });
    const ratingCols = cols.filter((x) => x.tot > 0 && x.fracNum >= 0.7).map((x) => x.c);

    // coluna de NOME (texto): 1) header de cliente/escola; 2) 1ª coluna de texto
    // não-timestamp. Se não houver nenhuma -> formato "largo".
    let nameIdx = (headers || []).findIndex((h, c) => ratingCols.indexOf(c) < 0 && !ehTimestamp(h) && /escola|cliente|col[eé]gio|institui|unidade/.test(norm(h)));
    if (nameIdx < 0) {
      const t = cols.find((x) => ratingCols.indexOf(x.c) < 0 && !ehTimestamp(x.header) && x.fracTxt >= 0.6);
      nameIdx = t ? t.c : -1;
    }

    // FORMATO LARGO: clientes nas colunas -> nota = média da coluna
    if (!forcaLongo && (forcaLargo || nameIdx < 0) && ratingCols.length >= (forcaLargo ? 1 : 3)) {
      const linhas = [];
      for (const c of ratingCols) {
        const notas = rows.map((r) => numNota(r[c])).filter((n) => n != null);
        if (!notas.length) continue;
        linhas.push({ nome: headers[c], mediaRaw: mediaRaw(notas), score: media(notas), votos: notas.length });
      }
      const respostas = [];
      for (const r of rows) {
        const dm = tsIdx >= 0 ? parseData(r[tsIdx]) : null;
        for (const c of ratingCols) {
          const n = numNota(r[c]); if (n == null) continue;
          respostas.push({ nome: headers[c], score: score1(n), dataMs: dm });
        }
      }
      return { formato: "largo", escala: escala10 ? 10 : 5, nameIdx: -1, ratingIdx: ratingCols, linhas, respostas };
    }

    // FORMATO LONGO: 1 coluna de nome + colunas de nota, 1 linha por resposta
    if (nameIdx < 0) nameIdx = 0;
    const ratingIdx = ratingCols.filter((c) => c !== nameIdx);
    // Colunas de COMENTÁRIO (pergunta aberta = o cliente justifica a nota): texto
    // livre que NÃO é nome, nota nem carimbo. Se houver colunas com header de
    // comentário ("justificativa", "o que melhorar"…), usamos só essas; senão,
    // qualquer coluna de texto sobrando (menos campos de contato) vira comentário.
    const ehContato = (h) => /email|e mail|telefone|whatsapp|contato|celular|cargo|funcao|\bnome\b/.test(norm(h));
    const ehComentHeader = (h) => /coment|justif|observ|sugest|feedback|melhor|aberta|porque|por que|deixe|conte|relato|cr[ií]tica/.test(norm(h));
    const comentCols = (headers || []).map((h, c) => ({ h, c }))
      .filter((x) => x.c !== nameIdx && x.c !== tsIdx && ratingCols.indexOf(x.c) < 0 && !ehContato(x.h));
    const comKw = comentCols.filter((x) => ehComentHeader(x.h));
    const comentarioIdx = (comKw.length ? comKw : comentCols).map((x) => x.c);
    const linhas = [];
    const respostas = [];
    for (const r of rows) {
      const nome = String(r[nameIdx] == null ? "" : r[nameIdx]).trim();
      if (!nome) continue;
      const notas = [], setores = {}; // cada coluna de nota = uma PERGUNTA (setor): design, atendimento, etc.
      for (const c of ratingIdx) {
        const v = numNota(r[c]); if (v == null) continue;
        notas.push(v);
        const h = (String(headers[c] == null ? "" : headers[c]).trim()) || ("Pergunta " + (c + 1));
        setores[h] = score1(v); // nota da pergunta na escala de exibição 0–10
      }
      if (!notas.length) continue;
      const score = media(notas);
      const comentarios = []; // pergunta aberta: [{ pergunta, texto }]
      for (const c of comentarioIdx) {
        const txt = String(r[c] == null ? "" : r[c]).trim();
        if (txt) comentarios.push({ pergunta: (String(headers[c] == null ? "" : headers[c]).trim()) || "Comentário", texto: txt });
      }
      linhas.push({ nome, mediaRaw: mediaRaw(notas), score });
      respostas.push({ nome, score, dataMs: tsIdx >= 0 ? parseData(r[tsIdx]) : null, setores, comentarios });
    }
    return { formato: "longo", escala: escala10 ? 10 : 5, nameIdx, ratingIdx, comentarioIdx, linhas, respostas };
  }

  FD.integrations.nps = {
    nome: "NPS",
    descricao: "Interna (nossa nota p/ o cliente) e externa (nota do cliente p/ nós)",
    campos: [
      { key: "linkInterna", label: "Link NPS interna (nossa nota p/ o cliente)", placeholder: "https://docs.google.com/spreadsheets/..." },
      { key: "linkExterna", label: "Link NPS externa (nota do cliente p/ nós)", placeholder: "https://docs.google.com/spreadsheets/..." },
    ],
    conectado(squad) {
      const c = FD.config?.[squad]?.nps;
      return !!(c && (c.linkInterna || c.linkExterna)) || FD.integrations.serverTem(squad, "nps");
    },
    parsearNotas, // usado pelo diagnóstico

    async inspect({ squad, link, which }) {
      const data = await lerPlanilha(squad, which || "externa", link);
      const parsed = parsearNotas(data.headers || [], data.rows || [], which || "externa");
      return { ...data, parsed };
    },

    async fetch(squad) {
      if (!this.conectado(squad)) return null;
      const c = FD.config[squad].nps;
      const out = { source: "nps", externa: null, interna: null };
      const carregar = async (which, link) => {
        if (!link && !FD.integrations.serverTem(squad, "nps")) return null; // link vem do Supabase no servidor
        try {
          const meses = await lerMeses(squad, which, link, 4); // abas de mês ("Julho de 2027")
          if (meses.length) return { formato: meses[meses.length - 1].formato, escala: meses[meses.length - 1].escala, meses };
          // sem abas de mês -> aba única (comportamento atual; mostra erro se não compartilhada)
          const d = await lerPlanilha(squad, which, link);
          const p = parsearNotas(d.headers || [], d.rows || [], which);
          return { formato: p.formato, escala: p.escala, meses: null, respostas: p.respostas };
        } catch (e) { console.warn("[nps] " + which + " falhou:", e.message); return null; }
      };
      const [externa, interna] = await Promise.all([carregar("externa", c.linkExterna), carregar("interna", c.linkInterna)]);
      out.externa = externa; out.interna = interna;
      return out;
    },
  };
})();
