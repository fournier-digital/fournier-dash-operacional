/* ==========================================================================
 * MOTOR DE CRITICIDADE — transforma os sinais de todas as fontes num
 * semáforo (vermelho / amarelo / verde) + a lista de MOTIVOS.
 *
 * Regras pensadas para "gestão por exceção": quanto maior o score,
 * mais o cliente precisa de ação HOJE.
 * ========================================================================== */
(function () {
  const FD = (window.FD = window.FD || {});
  const lib = FD.lib;

  const LIMITE_SEM_REUNIAO = 15; // dias
  const LIMITE_REUNIAO_CRITICA = 20; // dias — gatilho crítico de churn (encurtado de 30 p/ apertar a cadência)

  function avaliar(escola) {
    let score = 0;
    const motivos = [];

    // Tempo de contrato (usado em reunião, onboarding e chance de renovar)
    const diasContrato = lib.diasDesde(escola.inicioContrato);

    // 1. Sem reunião há +15 dias — só penaliza quando HÁ reunião registrada e
    // ela está velha. Ausência de reunião casada (a Agenda só liga pelo título)
    // = dado desconhecido, NÃO é sinal de risco (evita falso positivo).
    const naJanelaKickoff = escola.fase === "onboarding" && diasContrato != null && diasContrato <= LIMITE_SEM_REUNIAO;
    const temReuniao = !!escola.ultimaReuniao;
    const diasSemReuniao = temReuniao ? lib.diasDesde(escola.ultimaReuniao) : 0;
    const semReuniao = temReuniao && !naJanelaKickoff && diasSemReuniao > LIMITE_SEM_REUNIAO;
    if (semReuniao) {
      score += 3;
      if (diasSemReuniao >= LIMITE_REUNIAO_CRITICA) score += 2;
      motivos.push(`Sem reunião há ${diasSemReuniao} dias`);
    }

    // 2. Demandas atrasadas
    const atrasadas = escola.demandas.filter((d) => d.atrasada);
    if (atrasadas.length > 0) {
      score += Math.min(atrasadas.length * 2, 6);
      motivos.push(
        `${atrasadas.length} demanda${atrasadas.length > 1 ? "s" : ""} atrasada${
          atrasadas.length > 1 ? "s" : ""
        }`
      );
    }

    // 3. NPS externo baixo (escola insatisfeita)
    if (escola.npsExterno != null && escola.npsExterno < 7) {
      score += 3;
      motivos.push(`NPS escola baixo (${escola.npsExterno})`);
    }
    // NPS interno baixo (time já sinalizou risco) — corte < 6, coerente com o resto do motor
    if (escola.npsInterno != null && escola.npsInterno < 6) {
      score += 1;
      motivos.push(`NPS time baixo (${escola.npsInterno})`);
    }

    // Tendência de NPS — compara o atual com o PICO dos ~3 meses anteriores,
    // assim quedas graduais (-1/mês) também acusam risco.
    let npsDeltaExt = null, npsPrevExt = null;
    if (escola.npsHistorico) {
      const h = escola.npsHistorico.filter((x) => x.externo != null);
      if (h.length >= 2) {
        const atual = h[h.length - 1].externo;
        const janela = h.slice(Math.max(0, h.length - 4), h.length - 1).map((x) => x.externo);
        npsPrevExt = Math.max.apply(null, janela);
        npsDeltaExt = atual - npsPrevExt;
      }
    }
    if (npsDeltaExt != null && npsDeltaExt <= -2) {
      score += 2;
      motivos.push(`NPS caiu ${npsPrevExt}→${escola.npsExterno}`);
    }

    // 4. Onboarding travado (cliente novo há +30 dias e ainda não concluiu)
    const onbFeito = escola.onboarding.filter((e) => e.feito).length;
    const onbTotal = escola.onboarding.length;
    if (escola.fase === "onboarding" && diasContrato > 30 && onbFeito < onbTotal) {
      score += 2;
      motivos.push(`Onboarding travado (${onbFeito}/${onbTotal}, ${diasContrato}d de contrato)`);
    }

    // 5. Entregáveis faltando (ativo não 100% operante) — com TETO (+3) e sem
    // penalizar quem acabou de chegar (setup natural nos primeiros 30 dias).
    const entFaltando = escola.entregaveis.filter((e) => !e.feito);
    const recemChegado = diasContrato != null && diasContrato <= 30;
    if (escola.fase === "ativo" && !recemChegado && entFaltando.length > 0) {
      score += Math.min(entFaltando.length, 3);
      motivos.push(`${entFaltando.length} entregável(is) faltando`);
    }

    let nivel;
    if (score >= 8) nivel = "vermelho";        // muito crítico
    else if (score >= 6) nivel = "laranja";    // crítico
    else if (score >= 3) nivel = "amarelo";    // atenção
    else nivel = "verde";                       // saudável

    // Risco de churn = sinais que historicamente antecedem o cancelamento.
    const npsRuim =
      (escola.npsExterno != null && escola.npsExterno < 7) ||
      (escola.npsInterno != null && escola.npsInterno < 6);
    const riscoChurn = nivel === "vermelho" || nivel === "laranja" || npsRuim || diasSemReuniao >= LIMITE_REUNIAO_CRITICA;

    // Chance de renovar — cada sinal entra UMA vez (sem dupla contagem via score).
    let chance = 62;
    if (escola.npsExterno != null) chance += (escola.npsExterno - 7) * 6; // NPS escola (linear)
    if (escola.npsInterno != null) chance += (escola.npsInterno - 7) * 3; // NPS time (linear)
    if (npsDeltaExt != null && npsDeltaExt <= -2) chance -= 6; // queda de NPS
    if (semReuniao) chance -= diasSemReuniao >= LIMITE_REUNIAO_CRITICA ? 14 : 8; // cadência de reunião
    chance -= Math.min(atrasadas.length * 3, 12); // demandas atrasadas
    if (escola.fase === "ativo") chance -= entFaltando.length * 2; // entregáveis faltando
    if (escola.fase === "onboarding" && onbFeito < onbTotal) chance -= 6; // onboarding travado
    chance = Math.max(5, Math.min(98, Math.round(chance)));
    const chanceNivel = chance >= 70 ? "verde" : chance >= 45 ? "amarelo" : "vermelho";

    return {
      score,
      nivel,
      motivos,
      diasSemReuniao,
      semReuniao,
      atrasadas,
      onbFeito,
      onbTotal,
      entFaltando,
      npsRuim,
      riscoChurn,
      chanceRenovar: chance,
      chanceNivel,
      npsDeltaExt,
      npsPrevExt,
    };
  }

  // Enriquece cada escola com o campo .crit
  FD.engine.avaliarTodas = function (escolas) {
    return escolas.map((e) => ({ ...e, crit: avaliar(e) }));
  };

  FD.engine.avaliar = avaliar;

  /* ------------------------------------------------------------------------
   * AÇÕES PRIORITÁRIAS (o 80/20): converte sinais em ações concretas,
   * ranqueadas. Cada ação aponta para um cliente (drill-down no clique).
   * urgencia: "critica" (agir hoje) | "semana" (esta semana)
   * ---------------------------------------------------------------------- */
  FD.engine.acoes = function (escolas) {
    const acoes = [];
    const add = (e, a) =>
      acoes.push({
        escolaId: e.id,
        escolaNome: e.nome,
        squad: e.squad,
        nivel: e.crit.nivel,
        ...a,
      });

    escolas.forEach((e) => {
      const c = e.crit;

      // NPS ruim — sinal nº1 de churn
      if (c.npsRuim) {
        const partes = [];
        if (e.npsExterno != null && e.npsExterno < 7) partes.push(`NPS escola ${e.npsExterno}`);
        if (e.npsInterno != null && e.npsInterno < 6) partes.push(`NPS time ${e.npsInterno}`);
        add(e, {
          id: `${e.id}-nps`,
          tipo: "nps",
          icon: "💬",
          titulo: `Resgatar relação com ${e.nome}`,
          motivo: partes.join(" · ") || "satisfação em queda",
          urgencia: "critica",
          peso: 100 + c.score,
        });
      }

      // Sem reunião há muito tempo
      if (c.semReuniao) {
        const critico = c.diasSemReuniao >= LIMITE_REUNIAO_CRITICA;
        add(e, {
          id: `${e.id}-reuniao`,
          tipo: "reuniao",
          icon: "📅",
          titulo: `Agendar reunião com ${e.nome}`,
          motivo: e.ultimaReuniao ? `${c.diasSemReuniao} dias sem contato` : "nunca teve reunião",
          urgencia: critico ? "critica" : "semana",
          peso: 80 + c.diasSemReuniao,
        });
      }

      // Demandas atrasadas (agrupadas por cliente)
      if (c.atrasadas.length > 0) {
        const pior = Math.max(...c.atrasadas.map((d) => -lib.diasAte(d.prazo)));
        add(e, {
          id: `${e.id}-demandas`,
          tipo: "demanda",
          icon: "⏰",
          titulo: `Destravar ${c.atrasadas.length} demanda${c.atrasadas.length > 1 ? "s" : ""} de ${e.nome}`,
          motivo: `pior atraso: ${pior} dias`,
          urgencia: pior >= 7 || c.atrasadas.length >= 3 ? "critica" : "semana",
          peso: 60 + c.atrasadas.length * 5 + pior,
        });
      }

      // Onboarding travado
      if (e.fase === "onboarding" && c.onbFeito < c.onbTotal) {
        const diasContrato = lib.diasDesde(e.inicioContrato);
        add(e, {
          id: `${e.id}-onb`,
          tipo: "onboarding",
          icon: "🚀",
          titulo: `Avançar onboarding de ${e.nome}`,
          motivo: `etapa ${c.onbFeito}/${c.onbTotal} · ${diasContrato}d de contrato`,
          urgencia: diasContrato > 45 ? "critica" : "semana",
          peso: 40 + (c.onbTotal - c.onbFeito) * 5 + (diasContrato > 30 ? 20 : 0),
        });
      }

      // Entregáveis faltando (ativo não 100% operante)
      if (e.fase === "ativo" && c.entFaltando.length > 0) {
        add(e, {
          id: `${e.id}-ent`,
          tipo: "entregavel",
          icon: "🧩",
          titulo: `Completar setup de ${e.nome}`,
          motivo: `${c.entFaltando.length} pendência(s): ${c.entFaltando.map((x) => x.label).join(", ")}`,
          urgencia: "semana",
          peso: 20 + c.entFaltando.length * 5,
        });
      }
    });

    const ordem = { critica: 0, semana: 1 };
    acoes.sort((a, b) => ordem[a.urgencia] - ordem[b.urgencia] || b.peso - a.peso);
    return acoes;
  };

  /* ---------------- Resumo de NPS (interno e externo) ---------------- */
  function npsBloco(valores) {
    // Faixas como "nota" 0–10 (alinhado ao filtro de cor do NPS):
    // promotor 7+ · neutro 6 · detrator (insatisfeito/crítico) <6.
    const resp = valores.filter((v) => v != null);
    const prom = resp.filter((v) => v >= 7).length;
    const neutro = resp.filter((v) => v >= 6 && v < 7).length;
    const detr = resp.filter((v) => v < 6).length;
    const score = resp.length ? Math.round(((prom - detr) / resp.length) * 100) : null;
    const media = resp.length ? (resp.reduce((s, v) => s + v, 0) / resp.length).toFixed(1) : null;
    return { score, media, prom, neutro, detr, respondentes: resp.length, semResposta: valores.length - resp.length };
  }

  // média (1 casa) de um campo numérico, ignorando null — p/ a "geral dos últimos 3 meses"
  function mediaCampo(escolas, campo) {
    const v = escolas.map((e) => e[campo]).filter((x) => x != null);
    return v.length ? (v.reduce((s, x) => s + x, 0) / v.length).toFixed(1) : null;
  }

  FD.engine.npsResumo = function (escolas) {
    const externo = npsBloco(escolas.map((e) => e.npsExterno));
    const interno = npsBloco(escolas.map((e) => e.npsInterno));
    externo.media3m = mediaCampo(escolas, "npsExterno3m"); // geral últimos 3 meses
    interno.media3m = mediaCampo(escolas, "npsInterno3m");
    return { externo, interno };
  };

  /* ---------------- Diagnóstico de NPS por SETOR — agregado (carteira/squad) --------
   * Junta o e.npsSetores (cada pergunta da NPS externa = um setor) de TODOS os
   * clientes recebidos e tira a média por setor (cada cliente pesa 1). Como o App
   * passa as escolas já filtradas por squad, o resultado é por-squad quando a
   * diretoria filtra Azul/Laranja. Pior primeiro; .fracos = setores abaixo de 7. */
  FD.engine.npsSetoresResumo = function (escolas) {
    const acc = {}; // pergunta -> { soma, n }
    (escolas || []).forEach((e) => (e.npsSetores || []).forEach((s) => {
      if (!s || s.media == null) return;
      const a = acc[s.pergunta] || (acc[s.pergunta] = { pergunta: s.pergunta, soma: 0, n: 0 });
      a.soma += s.media; a.n += 1;
    }));
    const setores = Object.keys(acc).map((k) => {
      const a = acc[k];
      const media = Math.round((a.soma / a.n) * 10) / 10; // escala 0–10 (a UI mostra /5 via npsDisp)
      return { pergunta: a.pergunta, media, nClientes: a.n, fraco: media < 7 };
    }).sort((x, y) => x.media - y.media);
    return { setores, fracos: setores.filter((s) => s.fraco) };
  };

  /* ---------------- Pauta sugerida de reunião (por NPS/saúde) ---------------- */
  FD.engine.pautaReuniao = function (escola) {
    const c = escola.crit;
    const pauta = [];
    if (escola.npsExterno != null && escola.npsExterno < 7)
      pauta.push(`Ouvir insatisfação (NPS ${escola.npsExterno}) e propor plano de recuperação`);
    if (escola.npsExterno != null && escola.npsExterno >= 9)
      pauta.push("Cliente promotor — pedir indicação / depoimento");
    if (c.atrasadas.length) pauta.push(`Alinhar ${c.atrasadas.length} demanda(s) atrasada(s)`);
    if (escola.fase === "onboarding") pauta.push(`Próximos passos do onboarding (etapa ${c.onbFeito}/${c.onbTotal})`);
    if (c.entFaltando.length) pauta.push(`Destravar setup: ${c.entFaltando.map((x) => x.label).join(", ")}`);
    const diasRenov = lib.diasAte(escola.renovacaoEm);
    if (diasRenov != null && diasRenov <= 60)
      pauta.push(diasRenov >= 0 ? `Conversa de renovação (vence em ${diasRenov}d)` : `Renovação vencida (${-diasRenov}d) — formalizar`);
    pauta.push("Resultados do período (leads / matrículas)");
    return pauta.slice(0, 4);
  };

  /* ---------------- Renovações (mais próximas / vencidas primeiro) ---------------- */
  FD.engine.renovacoes = function (escolas) {
    // TODOS os clientes aparecem. Quem tem task de contrato -> dias até o fim;
    // quem NÃO tem -> dias = null (mostrado vazio, pra sinalizar que falta cadastrar).
    // Ordena por proximidade; os sem data vão para o fim (alfabético).
    return escolas
      .map((e) => ({ escola: e, dias: e.renovacaoEm != null ? lib.diasAte(e.renovacaoEm) : null }))
      .sort((a, b) => {
        if (a.dias == null && b.dias == null) return a.escola.nome.localeCompare(b.escola.nome, "pt-BR");
        if (a.dias == null) return 1;
        if (b.dias == null) return -1;
        return a.dias - b.dias;
      });
  };

  /* ----------------------------------------------------------------------
   * RECOMENDAÇÕES — cruza as fontes e diz O QUE FAZER para reverter.
   * Insight combinado (mais forte) vem primeiro.
   * -------------------------------------------------------------------- */
  FD.engine.recomendacoes = function (e) {
    const c = e.crit;
    const recs = [];

    // Combinações cruzadas (sinais somados = maior risco)
    let comboNpsBaixo = false;
    if (e.npsExterno != null && e.npsExterno < 7 && c.atrasadas.length) {
      recs.push({ icon: "🔥", txt: `Combinação crítica: insatisfação (NPS ${e.npsExterno}) + ${c.atrasadas.length} entrega(s) atrasada(s). Resolva a entrega ANTES de ligar — senão a conversa piora.` });
      comboNpsBaixo = true;
    }
    if (e.npsExterno != null && e.npsExterno < 7 && c.semReuniao) {
      recs.push({ icon: "🚨", txt: `NPS baixo + ${c.diasSemReuniao}d de silêncio = risco de churn alto. Agende reunião de retomada ainda esta semana.` });
      comboNpsBaixo = true;
    }

    // Tendência / NPS
    if (c.npsDeltaExt != null && c.npsDeltaExt <= -2) {
      recs.push({ icon: "📉", txt: `NPS despencou ${c.npsPrevExt}→${e.npsExterno}. Ligue pessoalmente em 48h, entenda a virada e feche um plano com prazo.` });
    } else if (e.npsExterno != null && e.npsExterno < 7 && !comboNpsBaixo) {
      recs.push({ icon: "💬", txt: `Escola insatisfeita (NPS ${e.npsExterno}). Reunião de escuta + uma entrega rápida de valor nesta semana.` });
    } else if (e.npsExterno != null && e.npsExterno >= 9) {
      recs.push({ icon: "⭐", txt: `Promotora (NPS ${e.npsExterno}) — momento de pedir indicação ou depoimento.` });
    }
    if (e.npsInterno != null && e.npsInterno < 6) {
      recs.push({ icon: "🛟", txt: `O time já sinalizou risco (NPS interno ${e.npsInterno}) antes da escola reclamar — antecipe-se com um diagnóstico interno.` });
    }

    // Operação
    if (c.semReuniao && !(e.npsExterno != null && e.npsExterno < 7)) {
      recs.push({ icon: "📅", txt: `${e.ultimaReuniao ? c.diasSemReuniao + " dias" : "Nunca teve reunião"} sem contato. Agende e leve resultados concretos.` });
    }
    if (c.atrasadas.length && !(e.npsExterno != null && e.npsExterno < 7)) {
      recs.push({ icon: "⏰", txt: `Destrave ${c.atrasadas.length} demanda(s) atrasada(s) — atraso vira insatisfação.` });
    }
    if (e.fase === "ativo" && c.entFaltando.length) {
      recs.push({ icon: "🧩", txt: `Não está 100% operante: faltam ${c.entFaltando.map((x) => x.label.toLowerCase()).join(", ")}. Completar eleva a percepção de valor.` });
    }
    if (e.fase === "onboarding" && c.onbFeito < c.onbTotal) {
      recs.push({ icon: "🚀", txt: `Onboarding na etapa ${c.onbFeito}/${c.onbTotal} — acelere para evitar churn precoce.` });
    }
    const dRen = lib.diasAte(e.renovacaoEm);
    if (dRen != null && dRen <= 60) {
      recs.push({ icon: "🔁", txt: `Renovação ${dRen < 0 ? `vencida há ${-dRen}d` : `em ${dRen}d`} com chance ${c.chanceRenovar}%. Monte a proposta de retenção agora.` });
    }

    if (!recs.length) recs.push({ icon: "✅", txt: "Cliente saudável — manter a cadência quinzenal e registrar resultados." });
    return recs.slice(0, 4);
  };

  /* ----------------------------------------------------------------------
   * PRIORITÁRIOS — clientes mais negativos primeiro (cruza tudo).
   * Pesa fortemente NPS escola, NPS time e queda de NPS.
   * -------------------------------------------------------------------- */
  FD.engine.prioritarios = function (escolas) {
    const risco = (e) => {
      const c = e.crit;
      let r = c.score;
      if (e.npsExterno != null) r += Math.max(0, 7 - e.npsExterno) * 2.5;
      if (e.npsInterno != null) r += Math.max(0, 7 - e.npsInterno) * 1.5;
      if (c.npsDeltaExt != null && c.npsDeltaExt < 0) r += -c.npsDeltaExt * 1.5;
      return r;
    };
    // Pilar nº1: escola realmente insatisfeita (detrator de NPS) SEMPRE acima
    // de caso puramente operacional, independentemente do score operacional.
    const detrator = (e) => (e.npsExterno != null && e.npsExterno <= 6 ? 1 : 0);
    const npsOrd = (e) => (e.npsExterno == null ? 99 : e.npsExterno);
    return [...escolas]
      .map((e) => ({ e, r: risco(e), d: detrator(e) }))
      .sort((a, b) => b.d - a.d || b.r - a.r || npsOrd(a.e) - npsOrd(b.e))
      .map((x) => x.e);
  };
})();
