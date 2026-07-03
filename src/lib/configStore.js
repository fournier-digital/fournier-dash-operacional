/* ==========================================================================
 * CONFIG STORE — guarda as credenciais/links de cada squad no navegador
 * (localStorage). É isto que a aba "Integrações" do dashboard edita.
 *
 * Estrutura: config por SQUAD, cada squad com suas 4 fontes.
 * Nada vai para o servidor — fica só neste navegador/dispositivo.
 * ========================================================================== */
(function () {
  const FD = (window.FD = window.FD || {});
  const KEY = "FD_config_v1";

  function squadVazio() {
    return {
      clickup: { token: "", spaceId: "" },
      googleCalendar: { calendarId: "", apiKey: "" },
      nps: { linkInterna: "", linkExterna: "" },
      controle: { link: "" },
      ltv: { link: "" },
    };
  }

  function padrao() {
    return { azul: squadVazio(), laranja: squadVazio() };
  }

  // merge raso garantindo todas as chaves (evita quebrar se mudar o schema)
  function normalizar(saved) {
    const base = padrao();
    if (!saved) return base;
    ["azul", "laranja"].forEach((sq) => {
      if (!saved[sq]) return;
      Object.keys(base[sq]).forEach((fonte) => {
        base[sq][fonte] = { ...base[sq][fonte], ...(saved[sq][fonte] || {}) };
      });
    });
    return base;
  }

  FD.configStore = {
    KEY,
    load() {
      let saved = null;
      try {
        saved = JSON.parse(localStorage.getItem(KEY) || "null");
      } catch (e) {
        saved = null;
      }
      return normalizar(saved);
    },
    save(cfg) {
      const norm = normalizar(cfg);
      try {
        localStorage.setItem(KEY, JSON.stringify(norm));
      } catch (e) {
        console.warn("Não foi possível salvar config:", e);
      }
      FD.config = norm;
      return norm;
    },
    limpar() {
      localStorage.removeItem(KEY);
      FD.config = padrao();
      return FD.config;
    },
    padrao,
  };

  // hidrata FD.config no carregamento
  FD.config = FD.configStore.load();
})();
