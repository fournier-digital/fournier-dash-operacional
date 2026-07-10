/* ==========================================================================
 * CLIENTE STORE — estado por cliente guardado no navegador (localStorage).
 *
 * Guarda, por NOME CANÔNICO do cliente:
 *   • planilhaComercial : link da planilha comercial            (Módulo 4)
 *   • dashboard24h      : link do dashboard externo "24h"        (Módulo 4)
 *   • reuniaoTentativa  : timestamp (ms) da última "tentativa de reunião"
 *                         marcada; some sozinho 24h depois        (Módulo 5d)
 *
 * Igual à config das integrações: nada vai para o servidor — fica só neste
 * navegador/dispositivo (localStorage). A chave é o nome canônico normalizado,
 * então sobrevive a re-sincronizações do ClickUp (o id da pasta pode mudar).
 * ========================================================================== */
(function () {
  const FD = (window.FD = window.FD || {});
  const KEY = "FD_cliente_v1";
  const TTL_TENTATIVA = 24 * 60 * 60 * 1000; // 24h (reset automático da tentativa)

  // PERF: cache em memória do JSON parseado — get()/tentativa() são chamados por LINHA
  // nas listas (Reuniões), e cada chamada re-parseava o localStorage inteiro. Toda
  // escrita passa por persistir() (que atualiza o cache); escrita de OUTRA aba invalida
  // via evento "storage". Comportamento observável idêntico.
  let cache = null;
  function carregar() {
    if (cache) return cache;
    try { cache = JSON.parse(localStorage.getItem(KEY) || "{}") || {}; }
    catch (e) { cache = {}; }
    return cache;
  }
  function persistir(all) {
    cache = all;
    try { localStorage.setItem(KEY, JSON.stringify(all)); }
    catch (e) {
      cache = null; // gravação falhou (quota/privado): invalida p/ reler o estado real
      console.warn("[clienteStore] não foi possível salvar:", e);
    }
  }
  // outra aba escreveu -> invalida (mantém a semântica multi-aba do localStorage)
  window.addEventListener("storage", (e) => { if (e.key === KEY) cache = null; });
  // chave estável por cliente (nome canônico, sem acento/maiúscula)
  function chave(canon) { return FD.lib.norm(canon || ""); }

  FD.clienteStore = {
    KEY,
    TTL_TENTATIVA,

    // registro bruto do cliente (objeto; vazio se não houver nada guardado)
    get(canon) {
      const k = chave(canon);
      if (!k) return {};
      return carregar()[k] || {};
    },

    // grava/atualiza um link (campo = "planilhaComercial" | "dashboard24h").
    // Valor vazio REMOVE o campo. Retorna o registro atualizado.
    setLink(canon, campo, valor) {
      const k = chave(canon); if (!k) return {};
      const all = carregar();
      const reg = all[k] || (all[k] = {});
      const v = (valor || "").trim();
      if (v) reg[campo] = v; else delete reg[campo];
      persistir(all);
      return reg;
    },

    // marca "tentativa de reunião" AGORA (Módulo 5d)
    marcarTentativa(canon) {
      const k = chave(canon); if (!k) return;
      const all = carregar();
      (all[k] || (all[k] = {})).reuniaoTentativa = Date.now();
      persistir(all);
    },

    // desfaz a marcação manualmente (antes das 24h)
    limparTentativa(canon) {
      const k = chave(canon); if (!k) return;
      const all = carregar();
      if (all[k]) { delete all[k].reuniaoTentativa; persistir(all); }
    },

    // { ativa, restanteMs }: a tentativa "vale" por 24h e some sozinha depois.
    // Compara com FD.NOW (hora da carga da página) — reseta na 1ª recarga após 24h.
    tentativa(canon) {
      const ts = this.get(canon).reuniaoTentativa;
      if (!ts) return { ativa: false, restanteMs: 0 };
      const restante = TTL_TENTATIVA - (FD.NOW.getTime() - ts);
      return restante > 0 ? { ativa: true, restanteMs: restante } : { ativa: false, restanteMs: 0 };
    },
  };
})();
