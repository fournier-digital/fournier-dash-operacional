/* ==========================================================================
 * AUTENTICAÇÃO POR SQUAD (simples, client-side para o uso interno)
 *
 * - Diretoria: vê TUDO (consolidado + filtro por squad).
 * - Squad Azul / Laranja: veem APENAS a própria carteira (isolamento total).
 *
 * ⚠️ Troque as senhas abaixo. Como é um app só de front, isto é um controle
 * de acesso leve (não use as mesmas senhas de sistemas sensíveis).
 * ========================================================================== */
(function () {
  const FD = (window.FD = window.FD || {});
  const KEY = "FD_session_v1";

  // EDITE AQUI os usuários e senhas de cada perfil:
  const USERS = {
    diretoria: { senha: "fournier@2026", papel: "diretoria", nome: "Diretoria", squads: ["azul", "laranja"] },
    azul: { senha: "azul@2026", papel: "squad", nome: "Squad Azul", squad: "azul", squads: ["azul"] },
    laranja: { senha: "laranja@2026", papel: "squad", nome: "Squad Laranja", squad: "laranja", squads: ["laranja"] },
  };

  FD.auth = {
    perfis: [
      { id: "diretoria", label: "Diretoria" },
      { id: "azul", label: "Squad Azul" },
      { id: "laranja", label: "Squad Laranja" },
    ],

    login(perfilId, senha) {
      const u = USERS[perfilId];
      if (!u || u.senha !== senha) return { ok: false, erro: "Perfil ou senha inválidos." };
      const sess = { perfil: perfilId, papel: u.papel, nome: u.nome, squad: u.squad || null, squads: u.squads };
      try { localStorage.setItem(KEY, JSON.stringify(sess)); } catch (e) {}
      return { ok: true, sessao: sess };
    },

    sessao() {
      try {
        const s = JSON.parse(localStorage.getItem(KEY) || "null");
        // Valida a forma: sessão corrompida/antiga é descartada -> cai no Login.
        if (!s || typeof s !== "object" || !Array.isArray(s.squads) || s.squads.length === 0 || !USERS[s.perfil]) {
          if (s) localStorage.removeItem(KEY);
          return null;
        }
        return s;
      } catch (e) { return null; }
    },

    logout() {
      localStorage.removeItem(KEY);
    },
  };
})();
