/* ==========================================================================
 * SNAPSHOT STORE — read-model + histórico datado da carteira no Supabase.
 *
 * gravar(escolas): a cada carga AO VIVO, grava 1 linha por cliente por DIA
 *   (upsert em cliente_snapshot, chave canon+dia) com o estado já normalizado
 *   (nível, score, chance, NPS, atrasos) + o objeto cru em `raw`. Isso:
 *     • acumula a EVOLUÇÃO cronológica (série por dia) p/ insights;
 *     • serve de CACHE (o snapshot mais recente é a carteira).
 * ler(): devolve o snapshot mais recente por cliente (p/ o boot ler do Supabase
 *   em vez de bater nas APIs). Re-avaliar a criticidade na leitura fica a cargo
 *   de quem consome (FD.NOW é congelado no load).
 *
 * Browser-driven com a anon key (mesmo padrão/RLS do clienteStore) — o snapshot
 * é dado interno NÃO-secreto (nenhum token aqui). Tudo é otimista e non-blocking:
 * se o Supabase estiver fora, só loga um warn e o dashboard segue no fluxo ao vivo.
 * ========================================================================== */
(function () {
  const FD = (window.FD = window.FD || {});
  const TABLE = "cliente_snapshot";

  // data local YYYY-MM-DD (usa FD.NOW, coerente com o resto do app)
  function diaLocal() {
    const d = new Date(FD.NOW.getTime() - FD.NOW.getTimezoneOffset() * 60000);
    return d.toISOString().slice(0, 10);
  }
  // YYYY-MM-DD de N dias atrás (corte das queries de janela)
  function diaMenos(n) {
    const d = new Date(FD.NOW.getTime() - FD.NOW.getTimezoneOffset() * 60000 - n * 86400000);
    return d.toISOString().slice(0, 10);
  }
  const num = (v) => (typeof v === "number" ? v : v == null ? 0 : parseFloat(v) || 0);
  // ordinal do nível: quanto MAIOR, pior (verde melhor -> vermelho pior)
  const NIVEL_ORD = { verde: 0, amarelo: 1, laranja: 2, vermelho: 3 };

  // PURO (testável): recebe linhas da carteira dentro da janela (asc por dia) e devolve
  // 1 resumo de tendência por cliente com >=2 pontos — compara o mais antigo vs o mais
  // recente da janela. Piorando/melhorando por nível, chance de renovar, NPS e atrasos.
  function calcTendencias(rows) {
    const porCanon = {};
    for (const r of rows || []) (porCanon[r.canon] = porCanon[r.canon] || []).push(r);
    const out = [];
    for (const canon in porCanon) {
      const serie = porCanon[canon];
      if (serie.length < 2) continue;
      const ini = serie[0], fim = serie[serie.length - 1];
      if (ini.dia === fim.dia) continue; // sem intervalo real
      const dNivel = (NIVEL_ORD[fim.nivel] ?? 0) - (NIVEL_ORD[ini.nivel] ?? 0);
      const dScore = num(fim.score) - num(ini.score);
      const dChance = num(fim.chance_renovar) - num(ini.chance_renovar);
      const dNps = fim.nps_externo != null && ini.nps_externo != null ? num(fim.nps_externo) - num(ini.nps_externo) : null;
      const dAtraso = num(fim.atrasadas) - num(ini.atrasadas);
      const motivos = [], bons = [];
      if (dNivel > 0) motivos.push(`nível piorou (${ini.nivel}→${fim.nivel})`);
      if (dChance <= -10) motivos.push(`chance de renovar −${Math.round(-dChance)}pp`);
      if (dNps != null && dNps <= -1) motivos.push(`NPS −${(-dNps).toFixed(1)}`);
      if (dAtraso >= 2) motivos.push(`+${dAtraso} atrasada(s)`);
      if (dNivel < 0) bons.push(`nível melhorou (${ini.nivel}→${fim.nivel})`);
      if (dChance >= 10) bons.push(`chance +${Math.round(dChance)}pp`);
      if (dNps != null && dNps >= 1) bons.push(`NPS +${dNps.toFixed(1)}`);
      if (dAtraso <= -2) bons.push(`−${-dAtraso} atrasada(s)`);
      out.push({
        canon, squad: fim.squad, pontos: serie.length, de: ini.dia, ate: fim.dia,
        piorando: motivos.length > 0, melhorando: bons.length > 0 && motivos.length === 0,
        motivos, bons,
        deltas: { nivel: dNivel, score: +dScore.toFixed(1), chance: Math.round(dChance), nps: dNps == null ? null : +dNps.toFixed(1), atraso: dAtraso },
      });
    }
    out.sort((a, b) => (b.piorando - a.piorando) || (b.motivos.length - a.motivos.length) || (b.deltas.score - a.deltas.score));
    return out;
  }

  // PURO (testável): agrega por mês x squad. Por cliente/mês usa o ÚLTIMO snapshot do mês
  // (estado de fim de mês) e então tira média entre os clientes daquele squad/mês.
  function agregarMensal(rows) {
    const ult = {}; // squad|mes|canon -> linha mais recente do mês
    for (const r of rows || []) {
      const mes = (r.dia || "").slice(0, 7);
      if (!mes || !r.squad) continue;
      const k = r.squad + "|" + mes + "|" + r.canon;
      if (!ult[k] || r.dia > ult[k].dia) ult[k] = Object.assign({}, r, { mes });
    }
    const acc = {}; // squad -> mes -> agg
    for (const k in ult) {
      const r = ult[k];
      const s = (acc[r.squad] = acc[r.squad] || {});
      const a = (s[r.mes] = s[r.mes] || { mes: r.mes, n: 0, somaScore: 0, somaChance: 0, somaNps: 0, nNps: 0, nCritico: 0, atrasos: 0 });
      a.n++; a.somaScore += num(r.score); a.somaChance += num(r.chance_renovar);
      if (r.nps_externo != null) { a.somaNps += num(r.nps_externo); a.nNps++; }
      if (r.nivel === "vermelho" || r.nivel === "laranja") a.nCritico++;
      a.atrasos += num(r.atrasadas);
    }
    const out = {};
    for (const squad in acc) {
      out[squad] = Object.keys(acc[squad]).map((m) => acc[squad][m]).map((a) => ({
        mes: a.mes, nClientes: a.n,
        avgScore: a.n ? +(a.somaScore / a.n).toFixed(1) : 0,
        avgChance: a.n ? Math.round(a.somaChance / a.n) : 0,
        avgNps: a.nNps ? +(a.somaNps / a.nNps).toFixed(1) : null,
        nCritico: a.nCritico, atrasos: a.atrasos,
      })).sort((x, y) => (x.mes < y.mes ? -1 : 1));
    }
    return out;
  }

  FD.snapshotStore = {
    // Grava o snapshot do dia (só carteira REAL — nunca mock nem os "out" de LTV).
    async gravar(escolas) {
      const sb = FD.supabase;
      if (!sb || !Array.isArray(escolas) || !escolas.length) return;
      const reais = escolas.filter((e) => e && e.squad && e._source === "clickup" && e.crit);
      if (!reais.length) return;
      const dia = diaLocal();
      const at = FD.NOW.toISOString();
      const rows = reais.map((e) => ({
        canon: FD.lib.norm(e.nome), squad: e.squad, dia, capturado_em: at,
        nivel: e.crit.nivel, score: e.crit.score, chance_renovar: e.crit.chanceRenovar,
        risco_churn: !!e.crit.riscoChurn, fase: e.fase || null,
        nps_externo: e.npsExterno != null ? e.npsExterno : null,
        nps_interno: e.npsInterno != null ? e.npsInterno : null,
        atrasadas: (e.crit.atrasadas || []).length,
        dias_sem_reuniao: e.crit.diasSemReuniao || 0,
        raw: e,
      }));
      try {
        const { error } = await sb.from(TABLE).upsert(rows, { onConflict: "canon,dia" });
        if (error) console.warn("[snapshot] gravar falhou:", error.message);
      } catch (e) { console.warn("[snapshot] gravar erro:", e && e.message); }
    },

    // Snapshot mais recente POR cliente -> { escolas:[raw...], capturadoEm } ou null.
    async ler() {
      const sb = FD.supabase;
      if (!sb) return null;
      try {
        const { data, error } = await sb.from(TABLE)
          .select("canon,capturado_em,raw").order("capturado_em", { ascending: false }).limit(400);
        if (error || !data || !data.length) return null;
        const seen = {}, escolas = [];
        let maxAt = null;
        for (const r of data) {
          if (seen[r.canon] || !r.raw) continue;
          seen[r.canon] = 1; escolas.push(r.raw);
          if (!maxAt || r.capturado_em > maxAt) maxAt = r.capturado_em;
        }
        return escolas.length ? { escolas, capturadoEm: maxAt } : null;
      } catch (e) { return null; }
    },

    // Série histórica de UM cliente (p/ a linha do tempo no detalhe) — pior->melhor por dia.
    async historico(canon) {
      const sb = FD.supabase;
      if (!sb || !canon) return [];
      try {
        const { data, error } = await sb.from(TABLE)
          .select("dia,nivel,score,chance_renovar,nps_externo,nps_interno,atrasadas,dias_sem_reuniao")
          .eq("canon", FD.lib.norm(canon)).order("dia", { ascending: true }).limit(400);
        return (error || !data) ? [] : data;
      } catch (e) { return []; }
    },

    // Fase 4 — tendências da carteira toda num único fetch (janela de `dias`).
    async tendenciasCarteira(dias = 30) {
      const sb = FD.supabase;
      if (!sb) return [];
      try {
        const { data, error } = await sb.from(TABLE)
          .select("canon,squad,dia,nivel,score,chance_renovar,nps_externo,atrasadas")
          .gte("dia", diaMenos(dias)).order("dia", { ascending: true }).limit(6000);
        if (error || !data) return [];
        return calcTendencias(data);
      } catch (e) { return []; }
    },

    // Fase 5 — agregado mensal por squad num único fetch (últimos `meses` meses).
    async mensalPorSquad(meses = 12) {
      const sb = FD.supabase;
      if (!sb) return {};
      try {
        const { data, error } = await sb.from(TABLE)
          .select("canon,squad,dia,nivel,score,chance_renovar,nps_externo,atrasadas")
          .gte("dia", diaMenos(meses * 31)).order("dia", { ascending: true }).limit(12000);
        if (error || !data) return {};
        return agregarMensal(data);
      } catch (e) { return {}; }
    },

    // expostos p/ teste unitário em Node (lógica pura, sem query)
    _calcTendencias: calcTendencias,
    _agregarMensal: agregarMensal,

    staleMs(capturadoEm) {
      if (!capturadoEm) return Infinity;
      const t = Date.parse(capturadoEm);
      return isNaN(t) ? Infinity : (FD.NOW.getTime() - t);
    },
  };
})();
