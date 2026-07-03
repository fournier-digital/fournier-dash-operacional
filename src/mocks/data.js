/* ==========================================================================
 * DADOS DE EXEMPLO (mockados) — 60 escolas, 30 por squad.
 *
 * Tudo aqui é fictício e gerado de forma determinística (seed por índice),
 * então os números não mudam a cada reload. Quando você plugar as APIs reais
 * (ClickUp, Agenda, NPS, Sheets), os módulos em src/integrations/ vão
 * SUBSTITUIR estes dados. Veja src/integrations/registry.js.
 * ========================================================================== */
(function () {
  const FD = (window.FD = window.FD || {});

  // PRNG determinístico (mulberry32) — mesma seed => mesma saída.
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const NOW = FD.NOW;
  function daysAgo(n) {
    const d = new Date(NOW);
    d.setDate(d.getDate() - n);
    return d.toISOString();
  }
  function daysAhead(n) {
    const d = new Date(NOW);
    d.setDate(d.getDate() + n);
    return d.toISOString();
  }
  function pick(arr, r) {
    return arr[Math.floor(r * arr.length)];
  }

  // 60 nomes distintos de escolas particulares (fictícios).
  const NOMES_ESCOLAS = [
    "Colégio Santa Inês", "Instituto Educacional Dom Bosco", "Colégio São Bento",
    "Escola Horizonte Azul", "Centro Educacional Aliança", "Colégio Madre Teresa",
    "Colégio Bilíngue Maple", "Escola Pequeno Príncipe", "Colégio Santo Antônio",
    "Instituto Saber Viver", "Colégio Monte Carmelo", "Escola Nova Geração",
    "Colégio Sagrado Coração", "Centro Educacional Vértice", "Colégio Anchieta",
    "Escola Girassol", "Colégio São Lucas", "Instituto Crescer",
    "Colégio Objetivo Sul", "Escola Recanto do Saber", "Colégio São José",
    "Centro Educacional Genesis", "Colégio Excelência", "Escola Arco-Íris",
    "Colégio Vila Nova", "Instituto Pensar", "Colégio Castelo Branco",
    "Escola Semente", "Colégio Futuro Brilhante", "Centro Educacional Âncora",
    "Colégio Imaculada Conceição", "Escola Raízes", "Colégio Dom Pedro II",
    "Instituto Logos", "Colégio Notre Dame", "Escola Caminho Suave",
    "Colégio Santa Mônica", "Centro Educacional Phoenix", "Colégio Albert Einstein",
    "Escola Curumim", "Colégio São Francisco", "Instituto Avanço",
    "Colégio Marista Central", "Escola Tempo de Aprender", "Colégio Cristo Rei",
    "Centro Educacional Atena", "Colégio Bom Pastor", "Escola Mundo Mágico",
    "Colégio Leonardo da Vinci", "Instituto Horizonte", "Colégio São Paulo",
    "Escola Vivência", "Colégio Nossa Senhora", "Centro Educacional Polo",
    "Colégio Stella Maris", "Escola Aprender+", "Colégio Galileu",
    "Instituto Conquista", "Colégio Santa Clara", "Escola Despertar",
  ];

  const TIMES = {
    azul: ["Marina", "Rafael", "Beatriz", "Thiago"],
    laranja: ["Lucas", "Camila", "Diego", "Aline"],
  };

  const TITULOS_DEMANDA = [
    "Subir campanha de matrículas",
    "Ajustar públicos do tráfego",
    "Criar criativos da campanha de bolsas",
    "Montar dashboard de resultados",
    "Revisar landing page de captação",
    "Configurar pixel e conversões",
    "Enviar relatório mensal de performance",
    "Planejar campanha de rematrícula",
    "Aprovar peças com a escola",
    "Otimizar campanha (CPL alto)",
    "Reunião de alinhamento mensal",
    "Gravar vídeos institucionais",
  ];

  const STATUS = ["aberta", "em andamento", "aguardando cliente", "concluída"];

  const ETAPAS_ONBOARDING = [
    "Contrato assinado",
    "Reunião de kickoff",
    "Acessos recebidos (anúncios/site)",
    "Configuração do tráfego",
    "Dashboard montado",
    "Primeira campanha no ar",
    "Primeira reunião de resultados",
  ];

  const ENTREGAVEIS = [
    { key: "trafego", label: "Tráfego ativo" },
    { key: "dashboard", label: "Dashboard entregue" },
    { key: "reunioes", label: "Reuniões acontecendo" },
    { key: "criativos", label: "Criativos aprovados" },
    { key: "relatorio", label: "Relatório mensal enviado" },
  ];

  function gerarEscola(i) {
    const r = rng(1000 + i);
    const squad = i < 30 ? "azul" : "laranja";
    const time = TIMES[squad];
    const fase = r() < 0.18 ? "onboarding" : "ativo";

    // Início do contrato: ativos entre 2-18 meses; onboarding 0-2 meses.
    const mesesContrato = fase === "ativo" ? 2 + Math.floor(r() * 16) : Math.floor(r() * 2);
    const inicioDias = mesesContrato * 30 + Math.floor(r() * 25);
    const inicioContrato = daysAgo(inicioDias);
    // Termo do contrato (maioria anual). Renovação = início + termo.
    const termoMeses = pick([12, 12, 12, 6, 24], r());
    const renovDias = termoMeses * 30 - inicioDias; // dias até renovar (negativo = vencido)
    const renovacaoEm = renovDias >= 0 ? daysAhead(renovDias) : daysAgo(-renovDias);

    // Última reunião: a maioria recente, parte > 15 dias (sinal de risco).
    let diasUltimaReuniao = Math.floor(r() * 22);
    if (r() < 0.15) diasUltimaReuniao += 18; // alguns casos extremos
    const semReuniaoNunca = fase === "onboarding" && r() < 0.4;
    const ultimaReuniao = semReuniaoNunca ? null : daysAgo(diasUltimaReuniao);

    // Próxima reunião agendada?
    const temProxima = r() < 0.55;
    const proximaReuniao = temProxima ? daysAhead(1 + Math.floor(r() * 12)) : null;

    // NPS (0-10). Externo = escola; Interno = avaliação do time. Alguns baixos.
    const npsExterno = fase === "onboarding" && r() < 0.5
      ? null
      : r() < 0.18
        ? 3 + Math.floor(r() * 4) // 3-6 (baixo)
        : 7 + Math.floor(r() * 4); // 7-10
    const npsInterno = r() < 0.2 ? 4 + Math.floor(r() * 3) : 7 + Math.floor(r() * 4);

    // Histórico/evolução mensal de NPS (coerente com o valor atual).
    // Clientes negativos hoje aparecem com QUEDA (estavam melhores antes).
    const npsColetaDias = 2 + Math.floor(r() * 24);
    function serieNps(atual, declinante) {
      if (atual == null) return null;
      const out = [];
      for (let m = 5; m >= 0; m--) {
        let v;
        if (m === 0) v = atual; // mês corrente = valor atual
        else if (declinante) v = Math.min(10, atual + Math.min(4, m)); // passado melhor
        else v = Math.max(0, Math.min(10, atual + (Math.floor(r() * 3) - 1)));
        out.push(v);
      }
      return out;
    }
    const serieExt = serieNps(npsExterno, npsExterno != null && npsExterno < 7);
    const serieInt = serieNps(npsInterno, npsInterno != null && npsInterno < 6);
    const npsHistorico = [];
    for (let m = 5; m >= 0; m--) {
      const idx = 5 - m;
      npsHistorico.push({
        data: daysAgo(npsColetaDias + m * 30),
        externo: serieExt ? serieExt[idx] : null,
        interno: serieInt ? serieInt[idx] : null,
      });
    }
    const npsAtualizadoEm = npsExterno != null || npsInterno != null ? daysAgo(npsColetaDias) : null;

    // Demandas
    const nDemandas = 1 + Math.floor(r() * 6);
    const demandas = [];
    for (let d = 0; d < nDemandas; d++) {
      const rd = rng(7000 + i * 50 + d);
      let status;
      const sroll = rd();
      if (sroll < 0.15) status = "concluída";
      else if (sroll < 0.45) status = "em andamento";
      else if (sroll < 0.7) status = "aguardando cliente";
      else status = "aberta";
      const prazoOffset = Math.floor(rd() * 22) - 9; // -9..+12 dias
      const prazo = prazoOffset >= 0 ? daysAhead(prazoOffset) : daysAgo(-prazoOffset);
      const atrasada = prazoOffset < 0 && status !== "concluída";
      demandas.push({
        id: `${i}-${d}`,
        titulo: pick(TITULOS_DEMANDA, rd()),
        status,
        responsavel: pick(time, rd()),
        prazo,
        atrasada,
      });
    }

    // Onboarding (passo a passo)
    const etapaAtual = fase === "ativo" ? ETAPAS_ONBOARDING.length : 1 + Math.floor(r() * 5);
    const onboarding = ETAPAS_ONBOARDING.map((label, idx) => ({
      label,
      feito: idx < etapaAtual,
    }));

    // Entregáveis (cliente 100% operante)
    const entregaveis = ENTREGAVEIS.map((e) => {
      let feito;
      if (fase === "onboarding") feito = r() < 0.25;
      else feito = r() < 0.82; // ativos: a maioria ok, alguns faltando
      return { key: e.key, label: e.label, feito };
    });

    return {
      id: i,
      nome: NOMES_ESCOLAS[i],
      squad,
      fase,
      inicioContrato,
      termoMeses,
      renovacaoEm,
      ultimaReuniao,
      proximaReuniao,
      npsExterno,
      npsInterno,
      npsHistorico,
      npsAtualizadoEm,
      demandas,
      onboarding,
      entregaveis,
      _source: "mock",
    };
  }

  const escolas = [];
  for (let i = 0; i < 60; i++) escolas.push(gerarEscola(i));

  FD.mocks.escolas = escolas;
  FD.mocks.times = TIMES;
})();
