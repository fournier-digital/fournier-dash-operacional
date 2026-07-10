/* ==========================================================================
 * CLIENTE STORE — estado por cliente COMPARTILHADO (Supabase + fallback local).
 *
 * Guarda, por NOME CANÔNICO do cliente:
 *   • planilhaComercial : link da planilha comercial            (Módulo 4)
 *   • dashboard24h      : link do dashboard externo "24h"        (Módulo 4)
 *   • reuniaoTentativa  : timestamp (ms) da última "tentativa"    (Módulo 5d)
 *
 * CROSS-DEVICE: init() carrega tudo do Supabase para um cache em memória; as
 * leituras (get/tentativa) continuam SÍNCRONAS a partir do cache (o render NÃO
 * muda). As gravações são OTIMISTAS (cache na hora) e replicadas para o Supabase
 * E para o localStorage. Se o Supabase estiver fora, o localStorage segura tudo.
 * Realtime mantém os dispositivos em sincronia ao vivo (se habilitado na tabela).
 * ========================================================================== */
(function () {
  const FD = (window.FD = window.FD || {});
  const KEY = "FD_cliente_v1";                 // fallback local (offline)
  const TABLE = "cliente_estado";
  const TTL_TENTATIVA = 24 * 60 * 60 * 1000;   // 24h (reset automático da tentativa)

  let cache = null;   // { [canonNorm]: { planilhaComercial, dashboard24h, reuniaoTentativa } }
  const subs = [];    // callbacks p/ re-render (init/realtime)
  const notify = () => subs.forEach((cb) => { try { cb(); } catch (e) {} });
  const chave = (canon) => FD.lib.norm(canon || "");

  // ---- base local (offline-first) ----
  function localLoad() { try { return JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch (e) { return {}; } }
  function localSave(all) { try { localStorage.setItem(KEY, JSON.stringify(all)); } catch (e) {} }
  function cacheRef() { if (!cache) cache = localLoad(); return cache; }

  // ---- mapeamento Supabase (colunas) <-> registro (campos do app) ----
  const rowToReg = (row) => {
    const r = {};
    if (row.planilha_comercial) r.planilhaComercial = row.planilha_comercial;
    if (row.dashboard_24h) r.dashboard24h = row.dashboard_24h;
    if (row.reuniao_tentativa_at) { const t = Date.parse(row.reuniao_tentativa_at); if (!isNaN(t)) r.reuniaoTentativa = t; }
    return r;
  };
  const regToRow = (k, reg) => ({
    canon: k,
    planilha_comercial: reg.planilhaComercial || null,
    dashboard_24h: reg.dashboard24h || null,
    reuniao_tentativa_at: reg.reuniaoTentativa ? new Date(reg.reuniaoTentativa).toISOString() : null,
  });

  // grava 1 registro no Supabase (upsert), sem travar a UI (otimista).
  function pushRemote(k) {
    const sb = FD.supabase; if (!sb) return;
    const reg = cacheRef()[k] || {};
    Promise.resolve(sb.from(TABLE).upsert(regToRow(k, reg), { onConflict: "canon" }))
      .then((res) => { if (res && res.error) console.warn("[clienteStore] upsert falhou:", res.error.message); })
      .catch((e) => console.warn("[clienteStore] upsert erro:", e && e.message));
  }

  FD.clienteStore = {
    KEY,
    TTL_TENTATIVA,

    // Carrega do Supabase p/ o cache (mantendo o local como base) e liga o
    // realtime. Chamado 1x no boot do app. Não quebra se o Supabase estiver fora.
    async init() {
      cacheRef(); // garante a base local imediata
      const sb = FD.supabase;
      if (!sb) return;
      try {
        const { data, error } = await sb.from(TABLE).select("*");
        if (error) throw error;
        const merged = {};
        (data || []).forEach((row) => { if (row.canon) merged[row.canon] = rowToReg(row); });
        cache = merged;      // Supabase é a fonte compartilhada da verdade
        localSave(cache);    // espelha p/ offline
        notify();
        if (!this._rt) {     // realtime: outro dispositivo grava -> atualiza aqui
          this._rt = sb.channel("cliente_estado_rt")
            .on("postgres_changes", { event: "*", schema: "public", table: TABLE }, (p) => {
              const row = (p.new && p.new.canon) ? p.new : p.old;
              if (!row || !row.canon) return;
              if (p.eventType === "DELETE") delete cacheRef()[row.canon];
              else cacheRef()[row.canon] = rowToReg(p.new);
              localSave(cache); notify();
            })
            .subscribe();
        }
      } catch (e) {
        console.warn("[clienteStore] init Supabase falhou — usando local:", e && e.message);
      }
    },

    // Re-render quando os dados chegam do Supabase / mudam ao vivo. Retorna unsubscribe.
    subscribe(cb) { subs.push(cb); return () => { const i = subs.indexOf(cb); if (i >= 0) subs.splice(i, 1); }; },

    // ---- leituras SÍNCRONAS (do cache) — o render não mudou ----
    get(canon) { const k = chave(canon); return k ? (cacheRef()[k] || {}) : {}; },

    tentativa(canon) {
      const ts = this.get(canon).reuniaoTentativa;
      if (!ts) return { ativa: false, restanteMs: 0 };
      const restante = TTL_TENTATIVA - (FD.NOW.getTime() - ts);
      return restante > 0 ? { ativa: true, restanteMs: restante } : { ativa: false, restanteMs: 0 };
    },

    // ---- gravações OTIMISTAS (cache + local + Supabase) ----
    setLink(canon, campo, valor) {
      const k = chave(canon); if (!k) return {};
      const all = cacheRef();
      const reg = all[k] || (all[k] = {});
      const v = (valor || "").trim();
      if (v) reg[campo] = v; else delete reg[campo];
      localSave(all); pushRemote(k); notify();
      return reg;
    },

    marcarTentativa(canon) {
      const k = chave(canon); if (!k) return;
      const all = cacheRef();
      (all[k] || (all[k] = {})).reuniaoTentativa = Date.now();
      localSave(all); pushRemote(k); notify();
    },

    limparTentativa(canon) {
      const k = chave(canon); if (!k) return;
      const all = cacheRef();
      if (all[k]) { delete all[k].reuniaoTentativa; localSave(all); pushRemote(k); notify(); }
    },
  };
})();
