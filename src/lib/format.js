/* ==========================================================================
 * Fournier Dash Operacional — helpers de formatação
 * Cria o namespace global window.FD usado por todos os módulos.
 * ========================================================================== */
(function () {
  const FD = (window.FD = window.FD || {});
  FD.integrations = FD.integrations || {};
  FD.mocks = FD.mocks || {};
  FD.engine = FD.engine || {};
  FD.lib = FD.lib || {};
  FD.config = FD.config || {};

  // "Agora" da operação. Usa a data real da máquina; os mocks são gerados
  // relativos a esta data, então os cenários (ex: "sem reunião há +15d")
  // continuam válidos não importa quando você abrir o dashboard.
  FD.NOW = new Date();

  FD.lib.diasDesde = function (isoDate) {
    if (!isoDate) return null;
    const d = new Date(isoDate);
    const ms = FD.NOW - d;
    return Math.floor(ms / (1000 * 60 * 60 * 24));
  };

  FD.lib.diasAte = function (isoDate) {
    if (!isoDate) return null;
    const d = new Date(isoDate);
    const ms = d - FD.NOW;
    return Math.ceil(ms / (1000 * 60 * 60 * 24));
  };

  FD.lib.dataCurta = function (isoDate) {
    if (!isoDate) return "—";
    return new Date(isoDate).toLocaleDateString("pt-BR", {
      day: "2-digit",
      month: "short",
    });
  };

  // "há X dias" / "em X dias" legível
  FD.lib.relativo = function (isoDate) {
    if (!isoDate) return "nunca";
    const d = FD.lib.diasDesde(isoDate);
    if (d === 0) return "hoje";
    if (d === 1) return "ontem";
    if (d > 0) return `há ${d} dias`;
    return `em ${Math.abs(d)} dias`;
  };

  // Normaliza texto p/ busca/comparação: sem acento, minúsculo, só letras/números.
  FD.lib.norm = function (s) {
    s = (s || "").toString().normalize("NFD");
    var out = "";
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c >= 0x300 && c <= 0x36f) continue; // remove diacríticos combinantes
      out += s[i];
    }
    return out.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  };

  FD.lib.SQUADS = {
    azul: {
      key: "azul",
      nome: "Squad Azul",
      cor: "#3b82f6",
      bg: "bg-blue-600",
      bgSoft: "bg-blue-50",
      text: "text-blue-700",
      border: "border-blue-200",
      dot: "bg-blue-600",
    },
    laranja: {
      key: "laranja",
      nome: "Squad Laranja",
      cor: "#fb7a1e",
      bg: "bg-orange-500",
      bgSoft: "bg-orange-50",
      text: "text-orange-700",
      border: "border-orange-200",
      dot: "bg-orange-500",
    },
  };
})();
