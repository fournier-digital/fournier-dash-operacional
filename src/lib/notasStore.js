/* ==========================================================================
 * NOTAS STORE — ideias/anotações livres, PRÓXIMOS PASSOS e ATA de reunião
 * por cliente, guardados no Supabase (tabela cliente_notas). Compartilhado
 * no time e cross-device (mesmo padrão/RLS do clienteStore/snapshotStore) —
 * dado interno NÃO-secreto (nenhum token aqui).
 *
 * tipo: 'nota'  = ideia/observação livre
 *       'passo' = próximo passo acionável (feito + prazo)
 *       'ata'   = registro pós-reunião (ref_data = data da reunião)
 *
 * Tudo async e defensivo: se o Supabase falhar, devolve vazio/null e loga warn,
 * o dashboard segue funcionando.
 * ========================================================================== */
(function () {
  const FD = (window.FD = window.FD || {});
  const TABLE = "cliente_notas";
  const norm = (s) => (FD.lib && FD.lib.norm ? FD.lib.norm(s) : String(s || "").toLowerCase().trim());
  const agora = () => (FD.NOW ? FD.NOW.toISOString() : new Date().toISOString());

  FD.notasStore = {
    // Tudo de um cliente, separado por tipo.
    async listar(nome) {
      const vazio = { notas: [], passos: [], atas: [] };
      const sb = FD.supabase;
      if (!sb || !nome) return vazio;
      try {
        const { data, error } = await sb.from(TABLE)
          .select("id,tipo,texto,feito,prazo,ref_data,autor,criado_em")
          .eq("canon", norm(nome)).order("criado_em", { ascending: false }).limit(300);
        if (error || !data) return vazio;
        const notas = [], passos = [], atas = [];
        for (const r of data) {
          if (r.tipo === "passo") passos.push(r);
          else if (r.tipo === "ata") atas.push(r);
          else notas.push(r);
        }
        // passos: pendentes primeiro, depois por prazo (sem prazo no fim)
        passos.sort((a, b) => (a.feito - b.feito) || ((a.prazo || "9999") < (b.prazo || "9999") ? -1 : 1));
        // atas: reunião mais recente primeiro (ref_data, fallback criado_em)
        atas.sort((a, b) => ((b.ref_data || b.criado_em) > (a.ref_data || a.criado_em) ? 1 : -1));
        return { notas, passos, atas };
      } catch (e) { return vazio; }
    },

    // Insere um item. `dados`: { texto, prazo?, ref_data?, autor? }. Devolve a linha ou null.
    async adicionar(nome, tipo, dados) {
      const sb = FD.supabase;
      if (!sb || !nome || !tipo) return null;
      const d = dados || {};
      const row = {
        canon: norm(nome), tipo,
        texto: d.texto || "",
        prazo: d.prazo || null,
        ref_data: d.ref_data || null,
        autor: d.autor || null,
      };
      try {
        const { data, error } = await sb.from(TABLE).insert(row).select().limit(1);
        if (error) { console.warn("[notas] adicionar falhou:", error.message); return null; }
        return data && data[0];
      } catch (e) { console.warn("[notas] adicionar erro:", e && e.message); return null; }
    },

    // Atualiza campos (texto/feito/prazo/ref_data). Carimba atualizado_em.
    async atualizar(id, patch) {
      const sb = FD.supabase;
      if (!sb || !id || !patch) return false;
      try {
        const { error } = await sb.from(TABLE).update(Object.assign({}, patch, { atualizado_em: agora() })).eq("id", id);
        if (error) console.warn("[notas] atualizar falhou:", error.message);
        return !error;
      } catch (e) { return false; }
    },

    async remover(id) {
      const sb = FD.supabase;
      if (!sb || !id) return false;
      try {
        const { error } = await sb.from(TABLE).delete().eq("id", id);
        return !error;
      } catch (e) { return false; }
    },
  };
})();
