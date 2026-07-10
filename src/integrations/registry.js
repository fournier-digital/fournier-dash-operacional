/* ==========================================================================
 * REGISTRY DE INTEGRAÇÕES — orquestra as fontes de dados (por squad).
 *
 * Regra de ouro: o dashboard SEMPRE funciona. Cada fonte que ainda não
 * estiver configurada/implementada cai no mock (data.js), marcado como
 * "dados de exemplo". As credenciais vêm da aba "Integrações" (por squad).
 * ========================================================================== */
(function () {
  const FD = (window.FD = window.FD || {});

  const FONTES = ["clickup", "googleCalendar", "nps", "controle", "ltv"];
  const SQUADS = ["azul", "laranja"];

  // Config que vive no SERVIDOR (Supabase) — o front recebe só BOOLEANS por
  // squad/fonte (nunca os segredos). Usado por conectado() p/ um dispositivo novo
  // já vir configurado, sem nada no localStorage.
  FD.integrations._serverCfg = {};
  FD.integrations.serverTem = function (squad, fonte) {
    const s = FD.integrations._serverCfg;
    return !!(s && s[squad] && s[squad][fonte]);
  };

  FD.integrations.lista = function () {
    return FONTES.map((key) => FD.integrations[key]).map((m, i) => ({ key: FONTES[i], ...m }));
  };


  // Carrega dados por squad. Se o ClickUp do squad estiver conectado, usa os
  // CLIENTES REAIS (pastas do Space). Senão, mantém o mock daquele squad.
  //
  // PERFORMANCE (tempo de espera): TODAS as fontes de TODOS os squads são
  // disparadas EM PARALELO (nenhum fetch depende de outro). Assim o tempo de
  // carga vira ~o da fonte mais lenta, não a SOMA de 8 grupos em série. Além
  // disso há RENDER PROGRESSIVO: assim que o ClickUp volta, a carteira já é
  // pintada via onParcial(); Agenda/NPS/Controle "entram" quando chegam.
  FD.integrations.carregar = async function (onParcial) {
    // Se ALGUM squad está configurado, não usamos mais o mock em lugar nenhum:
    // squad conectado mostra os clientes REAIS; squad não-configurado fica
    // vazio (nunca escolas genéricas). O mock só aparece se NADA estiver
    // conectado (modo demonstração inicial).
    // Status (não-secreto) da config central -> conectado() enxerga o Supabase
    // mesmo sem localStorage (dispositivo novo já vem configurado).
    try {
      const rc = await fetch("/api/config");
      if (rc.ok) FD.integrations._serverCfg = await rc.json();
    } catch (e) { /* sem status -> segue no localStorage */ }
    const algumConectado = SQUADS.some((sq) => FD.integrations.clickup.conectado(sq));
    const escolas = [];

    // Dispara já (sem await encadeado) — cada fetch trata o próprio erro -> null.
    const pFetch = (mod, sq) => {
      try { return Promise.resolve(mod && mod.fetch(sq)).catch(() => null); }
      catch (e) { return Promise.resolve(null); }
    };
    const pClickup  = SQUADS.map((sq) => pFetch(FD.integrations.clickup, sq));
    const pGcal     = SQUADS.map((sq) => pFetch(FD.integrations.googleCalendar, sq));
    const pNps      = SQUADS.map((sq) => pFetch(FD.integrations.nps, sq));
    const pControle = SQUADS.map((sq) => pFetch(FD.integrations.controle, sq));
    // LTV é GLOBAL: a planilha-mestre (ativos + inativos) não separa saídas por
    // squad, então lemos UMA vez (usando o link de qualquer squad configurado).
    const ltvLink = FD.config && ((FD.config.azul && FD.config.azul.ltv && FD.config.azul.ltv.link) || (FD.config.laranja && FD.config.laranja.ltv && FD.config.laranja.ltv.link));
    const ltvServer = FD.integrations.serverTem("azul", "ltv") || FD.integrations.serverTem("laranja", "ltv");
    const pLtvG = ((ltvLink || ltvServer) && FD.integrations.ltv && FD.integrations.ltv.fetchGlobal)
      ? Promise.resolve().then(() => FD.integrations.ltv.fetchGlobal(ltvLink || "")).catch(() => null)
      : Promise.resolve(null);

    // 1) BASE (pinta primeiro): monta a carteira assim que o ClickUp responde.
    const cks = await Promise.all(pClickup);
    SQUADS.forEach((sq, i) => {
      const ck = cks[i];
      const real = ck && Array.isArray(ck.escolas) ? ck.escolas : null;
      if (real && real.length) escolas.push(...real);
      else if (!algumConectado) escolas.push(...FD.mocks.escolas.filter((e) => e.squad === sq).map((e) => ({ ...e })));
      // squad não-conectado (com outro conectado) -> sem escolas (sem genéricos)
    });
    if (typeof onParcial === "function" && escolas.length) {
      try { onParcial(FD.engine.avaliarTodas(escolas)); } catch (e) { console.warn("[registry] render parcial falhou:", e); }
    }

    // 2) OVERLAYS (enriquecem in place; independentes entre si): Agenda, NPS e
    // Controle já estão baixando — só esperamos e aplicamos. A Agenda também
    // guarda os eventos crus por squad p/ a seção "Reuniões do dia".
    FD.integrations._eventos = {};
    const [gcs, nps_, cts, ltvG] = await Promise.all([Promise.all(pGcal), Promise.all(pNps), Promise.all(pControle), pLtvG]);
    SQUADS.forEach((sq, i) => {
      const gc = gcs[i];
      if (gc && Array.isArray(gc.eventos)) { FD.integrations._eventos[sq] = gc.eventos; aplicarReunioes(escolas, sq, gc.eventos); }
    });
    SQUADS.forEach((sq, i) => { const np = nps_[i]; if (np) aplicarNps(escolas, sq, np); });
    SQUADS.forEach((sq, i) => { const ct = cts[i]; if (ct && Array.isArray(ct.linhas)) aplicarControle(escolas, sq, ct.linhas); });
    FD.integrations._ltv = ltvG || null; // LTV/churn/saídas (empresa; por squad via atribuição abaixo)

    // LTV por squad + Renovação (2ª fonte): casa cada cliente da planilha de LTV
    // com a carteira pelo NOME. (1) preenche o squad do cliente da planilha quando
    // faltar a coluna; (2) usa o "fim de contrato" da planilha como renovacaoEm
    // quando o ClickUp NÃO trouxe o marcador (o ClickUp continua prioritário).
    if (FD.integrations._ltv && FD.integrations._ltv.clientes) {
      const sqPorCanon = {}, fimPorCanon = {};
      escolas.forEach((e) => { if (e.nome) sqPorCanon[FD.clientes.nomeCanonico(e.nome)] = e.squad; });
      FD.integrations._ltv.clientes.forEach((c) => {
        if (!c.squad && c.canon && sqPorCanon[c.canon]) c.squad = sqPorCanon[c.canon];
        if (c.fimContratoMs && c.canon) fimPorCanon[c.canon] = c.fimContratoMs;
      });
      escolas.forEach((e) => {
        if (e.renovacaoEm) return; // marcador do ClickUp tem prioridade
        const fim = fimPorCanon[FD.clientes.nomeCanonico(e.nome)];
        if (!fim) return;
        e.renovacaoEm = new Date(fim).toISOString();
        const ini = e.inicioContrato ? new Date(e.inicioContrato).getTime() : null;
        if (ini && fim > ini) e.termoMeses = Math.max(1, Math.round((fim - ini) / (30.44 * 864e5)));
      });
    }

    return FD.engine.avaliarTodas(escolas);
  };

  // ---- LTV / Churn / Clientes Out (métricas GLOBAIS — a planilha-mestre não
  // separa as saídas por squad; os números são da empresa, Azul + Laranja). ----
  FD.integrations._ltv = FD.integrations._ltv || null;

  // Resumo (LTV médio, churn, saídas, retidos 2m+, motivos). Sem squads (ou os 2)
  // => empresa (Azul+Laranja, comportamento antigo). Com 1 squad => recalcula só
  // com os clientes daquele squad (coluna da planilha ou atribuição pela carteira).
  FD.integrations.ltvResumo = function (squads) {
    const d = FD.integrations._ltv;
    if (!d) return null;
    if (!squads || squads.length >= 2) return d.resumo; // empresa (default)
    const set = new Set(squads);
    return FD.integrations.ltv.resumir((d.clientes || []).filter((c) => set.has(c.squad)));
  };
  // LTV médio (meses) de CADA squad, p/ o card comparativo "LTV por squad".
  FD.integrations.ltvPorSquad = function () {
    const d = FD.integrations._ltv;
    if (!d || !d.clientes) return null;
    const um = (sq) => FD.integrations.ltv.resumir(d.clientes.filter((c) => c.squad === sq));
    return { azul: um("azul"), laranja: um("laranja"), semSquad: d.clientes.filter((c) => !c.squad).length };
  };

  // Transforma um cliente que saiu (linha da planilha) num objeto no MESMO
  // formato das escolas ativas, p/ reusar a lista/detalhe. Marca .out + motivo.
  function outParaEscola(c, idx) {
    return {
      id: "out-" + idx,
      nome: c.canon || c.nome,
      squad: c.squad || null, // squad da coluna da planilha ou atribuído pela carteira; null se desconhecido
      fase: "encerrado",
      out: true,
      motivoSaida: c.motivo || "(sem motivo informado)",
      motivoDetalhe: c.porque || "",
      churn: !!c.churn,
      saidaEm: c.saidaMs ? new Date(c.saidaMs).toISOString() : null,
      tenureMeses: c.tenureMeses,
      ltv: null,
      valorMensal: null,
      inicioContrato: c.entradaMs ? new Date(c.entradaMs).toISOString() : null,
      termoMeses: null,
      renovacaoEm: null,
      ultimaReuniao: null,
      proximaReuniao: null,
      npsExterno: null,
      npsInterno: null,
      npsHistorico: [],
      npsAtualizadoEm: null,
      demandas: [],
      onboarding: [],
      entregaveis: [],
      _source: "ltv",
    };
  }

  // Clientes que saíram (avaliados p/ ter .crit), ordenados por saída recente. Sem
  // squads (ou os 2) => todas as saídas (empresa). Com 1 squad => só as atribuídas a ele.
  FD.integrations.clientesOut = function (squads) {
    const d = FD.integrations._ltv;
    if (!d || !d.clientes) return [];
    const filtro = squads && squads.length < 2 ? new Set(squads) : null;
    const outs = d.clientes
      .filter((c) => c.saiu)
      .filter((c) => !filtro || filtro.has(c.squad))
      .sort((a, b) => (b.saidaMs || 0) - (a.saidaMs || 0))
      .map((c, i) => outParaEscola(c, i));
    return FD.engine.avaliarTodas(outs);
  };

  // Sobrepõe os dados da planilha de Controle no cliente (casado pelo nome). Só
  // mexe em quem ESTÁ na planilha; os demais ficam como estão (não inventa dado).
  function aplicarControle(escolas, squad, linhas) {
    const alvos = escolas
      .filter((e) => e.squad === squad)
      .map((e) => ({ e, variantes: FD.clientes.variantesDoNome(e.nome).map((v) => FD.clientes.tokens(v)).filter((t) => t.length) }));
    if (!alvos.length || !linhas.length) return;
    for (const l of linhas) {
      const m = FD.clientes.acharNoTexto(l.nome, alvos) || FD.clientes.melhorMatch(l.nome, alvos, 0.6);
      if (!m) continue;
      const e = m.e;
      if (l.onboarding && l.onboarding.length) {
        e.onboarding = l.onboarding; // onboarding agora vem da planilha (prioridade)
        e.fase = e.onboarding.some((o) => !o.feito) ? "onboarding" : "ativo";
      }
      if (l.entregaveis && l.entregaveis.length) e.entregaveis = l.entregaveis; // entregáveis da planilha (prioridade; ClickUp é fallback p/ quem não está nela)
      e.linhaEditorial = l.linhaEditorial;
      e.campanhaGoogle = l.campanhaGoogle;
      e.naPlanilhaControle = true;
    }
  }

  // Liga as notas ao cliente pelo nome e define, POR MÊS: npsExterno/Interno (deste
  // mês), npsExterno3m/Interno3m (média dos últimos 3 meses) e npsHistorico (evolução).
  function aplicarNps(escolas, squad, np) {
    const alvos = escolas
      .filter((e) => e.squad === squad)
      .map((e) => ({ e, variantes: FD.clientes.variantesDoNome(e.nome).map((v) => FD.clientes.tokens(v)).filter((t) => t.length) }));
    if (!alvos.length) return;
    const mesKey = (ms) => { const d = new Date(ms); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"); };
    const med = (arr) => (arr.length ? Math.round((arr.reduce((s, n) => s + n, 0) / arr.length) * 10) / 10 : null);

    // Normaliza cada fonte numa lista de meses [{ym, respostas}]. Modo abas-de-mês:
    // já vem em fonte.meses. Modo aba-única: agrupa pelo carimbo (ou tudo no mês atual).
    const mesesDaFonte = (fonte) => {
      if (!fonte) return [];
      if (fonte.meses) return fonte.meses;
      const porYm = {}, ymHoje = mesKey(FD.NOW.getTime());
      for (const r of (fonte.respostas || [])) {
        const ym = r.dataMs ? mesKey(r.dataMs) : ymHoje;
        (porYm[ym] = porYm[ym] || []).push({ nome: r.nome, score: r.score, setores: r.setores, comentarios: r.comentarios });
      }
      return Object.keys(porYm).sort().map((ym) => ({ ym, respostas: porYm[ym] }));
    };

    // acumula por cliente: ym -> [scores], por fonte (ext/int)
    const dados = new Map(); // escolaId -> { e, ext:{ym:[...]}, int:{ym:[...]} }
    const setoresMap = new Map(); // escolaId -> { pergunta: [scores] }  (SÓ externa)
    const comentariosMap = new Map(); // escolaId -> [{ ym, pergunta, texto }]  (pergunta aberta, SÓ externa)
    const get = (eobj) => { if (!dados.has(eobj.id)) dados.set(eobj.id, { e: eobj, ext: {}, int: {} }); return dados.get(eobj.id); };
    // PERF: matching memoizado por nome — alvos é fixo durante a chamada e o mesmo nome
    // repete por avaliador × mês (formato largo). Funções puras -> resultado idêntico.
    const matchCache = new Map();
    const matchDe = (nome) => {
      if (matchCache.has(nome)) return matchCache.get(nome);
      const m = FD.clientes.acharNoTexto(nome, alvos) || FD.clientes.melhorMatch(nome, alvos, 0.6);
      matchCache.set(nome, m);
      return m;
    };
    const coletar = (meses, campo) => {
      for (const mz of meses) {
        for (const r of (mz.respostas || [])) {
          const m = matchDe(r.nome);
          if (!m) continue;
          const b = get(m.e)[campo];
          (b[mz.ym] = b[mz.ym] || []).push(r.score);
          if (campo === "ext" && r.setores) { // NPS externa: cada pergunta = um setor
            let sm = setoresMap.get(m.e.id); if (!sm) { sm = {}; setoresMap.set(m.e.id, sm); }
            for (const k in r.setores) (sm[k] = sm[k] || []).push(r.setores[k]);
          }
          if (campo === "ext" && r.comentarios && r.comentarios.length) { // pergunta aberta (justificativa)
            let cm = comentariosMap.get(m.e.id); if (!cm) { cm = []; comentariosMap.set(m.e.id, cm); }
            for (const co of r.comentarios) if (co && co.texto) cm.push({ ym: mz.ym, pergunta: co.pergunta, texto: co.texto });
          }
        }
      }
    };
    coletar(mesesDaFonte(np.externa), "ext");
    coletar(mesesDaFonte(np.interna), "int");

    const ultimoYm = (mapa) => { const ks = Object.keys(mapa).sort(); return ks.length ? ks[ks.length - 1] : null; };
    const media3m = (mapa) => { const pool = []; Object.keys(mapa).sort().slice(-3).forEach((k) => pool.push.apply(pool, mapa[k])); return med(pool); };

    dados.forEach(({ e, ext, int }) => {
      const ultE = ultimoYm(ext), ultI = ultimoYm(int);
      if (ultE) { e.npsExterno = med(ext[ultE]); e.npsExterno3m = media3m(ext); }
      if (ultI) { e.npsInterno = med(int[ultI]); e.npsInterno3m = media3m(int); }
      if (ultE || ultI) { e.npsAtualizadoEm = FD.NOW.toISOString(); e.npsMesAtual = (ultE || ultI); }
      // diagnóstico por setor (NPS externa): média de cada pergunta, pior primeiro
      const sm = setoresMap.get(e.id);
      if (sm) e.npsSetores = Object.keys(sm).map((p) => ({ pergunta: p, media: med(sm[p]), votos: sm[p].length })).sort((a, b) => a.media - b.media);
      // comentários da pergunta aberta — mais recentes primeiro, teto 8
      const cm = comentariosMap.get(e.id);
      if (cm && cm.length) e.npsComentarios = cm.slice().sort((a, b) => (a.ym < b.ym ? 1 : -1)).slice(0, 8);
      // histórico mensal combinando externo + interno (alimenta "Evolução de NPS")
      const meses = Array.from(new Set([].concat(Object.keys(ext), Object.keys(int)))).sort();
      if (meses.length) {
        e.npsHistorico = meses.map((k) => ({
          data: k + "-01T00:00:00",
          externo: ext[k] ? med(ext[k]) : null,
          interno: int[k] ? med(int[k]) : null,
        }));
      }
    });
  }

  // Liga cada evento ao cliente pelo título e define ultimaReuniao/proximaReuniao.
  function aplicarReunioes(escolas, squad, eventos) {
    const alvos = escolas
      .filter((e) => e.squad === squad)
      .map((e) => ({
        e,
        variantes: FD.clientes.variantesDoNome(e.nome).map((v) => FD.clientes.tokens(v)).filter((t) => t.length),
      }));
    if (!alvos.length || !eventos.length) return;

    const buckets = new Map();
    for (const ev of eventos) {
      if (!ev || !ev.inicio) continue;
      // FLEXÍVEL + AUTOMÁTICO: marca TODOS os clientes que façam sentido no título
      // (apelido, nome parcial, ordem trocada). Reunião conjunta marca todos eles.
      const ms = FD.clientes.melhorMatchTodos(ev.titulo || "", alvos, 0.6);
      for (const m of ms) {
        if (!buckets.has(m.e.id)) buckets.set(m.e.id, []);
        buckets.get(m.e.id).push(ev.inicio);
      }
    }

    const agora = FD.NOW.getTime();
    for (const alvo of alvos) {
      const datas = (buckets.get(alvo.e.id) || [])
        .map((iso) => ({ iso, t: new Date(iso).getTime() }))
        .filter((x) => !isNaN(x.t));
      const passadas = datas.filter((x) => x.t <= agora).sort((a, b) => b.t - a.t);
      const futuras = datas.filter((x) => x.t > agora).sort((a, b) => a.t - b.t);
      if (passadas.length) alvo.e.ultimaReuniao = passadas[0].iso;
      if (futuras.length) alvo.e.proximaReuniao = futuras[0].iso;
    }
  }

  // Quais squads estão com ClickUp ao vivo (alimenta o selo no cabeçalho).
  FD.integrations.squadsAoVivo = function () {
    return SQUADS.filter((sq) => FD.integrations.clickup.conectado(sq));
  };

  // Agenda mesclada (squads visíveis), de hoje 00:00 até +N dias — "Reuniões do dia".
  FD.integrations._eventos = FD.integrations._eventos || {};
  FD.integrations.agenda = function (squads, dias) {
    const N = dias || 7;
    const ini = new Date(FD.NOW); ini.setHours(0, 0, 0, 0);
    const fim = new Date(ini); fim.setDate(fim.getDate() + N + 1);
    const out = [];
    (squads || []).forEach((sq) => (FD.integrations._eventos[sq] || []).forEach((ev) => out.push(ev)));
    return out
      .filter((ev) => { const t = new Date(ev.inicio).getTime(); return !isNaN(t) && t >= ini.getTime() && t < fim.getTime(); })
      .sort((a, b) => new Date(a.inicio) - new Date(b.inicio));
  };
})();
