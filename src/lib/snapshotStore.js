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

    staleMs(capturadoEm) {
      if (!capturadoEm) return Infinity;
      const t = Date.parse(capturadoEm);
      return isNaN(t) ? Infinity : (FD.NOW.getTime() - t);
    },
  };
})();
