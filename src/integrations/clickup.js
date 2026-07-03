/* ==========================================================================
 * INTEGRAÇÃO: ClickUp — modelo por SPACE
 *
 * Cada SQUAD = um Space; dentro do Space cada PASTA = um cliente; listas por
 * pasta: "Demandas Novas" (= demandas), "Rotinas" (fora), "Onboarding".
 *
 * Credenciais por squad (aba Integrações / localStorage):
 *   config[squad].clickup = { token, spaceId }
 *
 * O navegador fala com o PROXY local (server.py), mesma origem:
 *   /api/clickup/<squad>/spaces | space-inspect?spaceId= | space-tasks?spaceId=
 *
 * Nomes de cliente são resolvidos pelo módulo compartilhado FD.clientes
 * (src/lib/clientes.js) — tolerante a apelido/acento/grafia.
 * ========================================================================== */
(function () {
  const FD = (window.FD = window.FD || {});

  const norm = FD.clientes.norm;
  const nomeCanonico = FD.clientes.nomeCanonico;

  // Classifica a lista pela PALAVRA-CHAVE (tolerante a variações de config):
  // qualquer "Demandas..." = demandas; "Onboarding..." = onboarding; o resto fora.
  function tipoLista(nome) {
    const n = norm(nome);
    if (n.indexOf("demanda") >= 0) return "demandas";
    if (n.indexOf("onboarding") >= 0) return "onboarding";
    if (n.indexOf("entregav") >= 0) return "entregaveis";
    return "outras";
  }

  // Pastas que NÃO são clientes (modelos/internas) — comparação normalizada.
  const EXCLUIR_PASTAS = ["novo cliente", "fournier digital", "modelo", "template"];
  function pastaExcluida(nome) {
    const n = norm(nome);
    return EXCLUIR_PASTAS.some((p) => n.indexOf(p) >= 0);
  }

  // Tarefas genéricas/recorrentes que poluem e não devem aparecer.
  const EXCLUIR_TAREFAS = ["campanha ativa", "relatorio semanal"];
  function tarefaExcluida(titulo) {
    const n = norm(titulo);
    return EXCLUIR_TAREFAS.some((p) => n.indexOf(p) >= 0);
  }

  // Marcador de RENOVAÇÃO: task cujo PRAZO (due date) é o fim do contrato.
  // Pode estar em qualquer lista da pasta; é lida só pela data e NÃO vira demanda.
  // Reconhece "Fim/Encerramento/Vencimento do contrato", "Contrato até ..." e
  // títulos que começam com "Renovação". "renovar criativos" NÃO casa (sem contrato).
  function ehMarcadorRenovacao(t) {
    if (!t || !t.due_date) return false;
    const n = norm(t.name);
    if (n.indexOf("contrato") >= 0 && /(fim|encerr|venciment|renova|termin|\bate\b)/.test(n)) return true;
    return /^renova[cs][ao]/.test(n); // "Renovação", "Renovacao 2026"
  }

  async function chamarProxy(acao, { token, squad }, query) {
    if (!token) throw new Error("Preencha o API Token do ClickUp.");
    const qs = new URLSearchParams(query || {}).toString();
    const url = `/api/clickup/${encodeURIComponent(squad)}/${acao}` + (qs ? `?${qs}` : "");
    let resp;
    try {
      resp = await fetch(url, { headers: { "X-CU-Token": token } });
    } catch (e) {
      throw new Error("Não consegui falar com o proxy local. O servidor está rodando? (python3 server.py)");
    }
    let data = null;
    try { data = await resp.json(); } catch (e) { data = null; }
    if (!resp.ok) {
      const msg = data && data.error ? data.error : `HTTP ${resp.status}`;
      const det = data && data.detalhe ? ` — ${String(data.detalhe).slice(0, 240)}` : "";
      throw new Error(msg + det);
    }
    return data;
  }

  // Status do ClickUp -> concluída/aberta/cancelada (nomes variam por workspace).
  // 1º confia na CATEGORIA do ClickUp (type closed/done). 2º, p/ status custom,
  // usa o NOME ancorado no início + barra negação: "não concluído"/"a concluir"/
  // "em finalização" contêm "conclu/finaliz" mas são ABERTOS -> não casam.
  const ehConcluida = (t) => {
    if (t.statusType === "closed" || t.statusType === "done") return true;
    const n = norm(t.statusName || ""); // sem acento, minúsculo
    if (/^(nao |a |para |sem |em |pendente|aguard|revis|backlog|fazer|andamento)/.test(n)) return false;
    return /^(conclu|finaliz|encerr|entreg|complet|feito|pronto)/.test(n) || n === "done";
  };
  const ehCancelada = (t) => /cancel/i.test(t.statusName || "");

  // "Atrasada" = por DIA, não por horário: uma demanda com prazo HOJE ainda NÃO
  // conta como atrasada — só quando o DIA do prazo já passou. (Alinha com a aba
  // Demandas, que separa "Para hoje" de "Atrasadas" pela data, não pela hora.)
  function ehAtrasada(prazoIso, concluida) {
    if (!prazoIso || concluida) return false;
    const hoje0 = new Date(FD.NOW); hoje0.setHours(0, 0, 0, 0);
    const d = new Date(prazoIso); d.setHours(0, 0, 0, 0);
    return d.getTime() < hoje0.getTime();
  }

  // Transforma as tarefas de um space nas ESCOLAS do painel (1 pasta = 1 cliente).
  function construirEscolas(tasks, squad, foldersMeta) {
    foldersMeta = foldersMeta || {};
    const porPasta = new Map();
    const soltas = []; // tarefas de listas SOLTAS (ex.: "Demandas Agente") — casam por título
    for (const t of tasks) {
      if (!t.folderName || t.folderHidden) {
        // sem pasta: listas soltas (Demandas Agente / Solicitação de criativos)
        // -> guarda p/ casar pelo nome no título depois
        if (!ehCancelada(t) && !tarefaExcluida(t.name) && !ehMarcadorRenovacao(t)) soltas.push(t);
        continue;
      }
      if (pastaExcluida(t.folderName)) continue; // modelos/internas
      if (!porPasta.has(t.folderId)) porPasta.set(t.folderId, { nome: t.folderName, tasks: [] });
      porPasta.get(t.folderId).tasks.push(t);
    }

    const escolas = [];
    for (const [folderId, info] of porPasta) {
      const demandas = info.tasks
        .filter((t) => tipoLista(t.listName) === "demandas" && !ehCancelada(t) && !tarefaExcluida(t.name) && !ehMarcadorRenovacao(t))
        .map((t) => {
          const prazo = t.due_date ? new Date(Number(t.due_date)).toISOString() : null;
          const concluida = ehConcluida(t);
          return {
            id: t.id,
            titulo: t.name,
            status: concluida ? "concluída" : (t.statusName || "aberta"),
            responsavel: (t.assignees && t.assignees[0]) || "—",
            responsaveis: (t.assignees && t.assignees.slice()) || [],
            responsaveisIds: (t.assigneesIds && t.assigneesIds.slice()) || [],
            prazo,
            atrasada: ehAtrasada(prazo, concluida),
          };
        });

      const onboarding = info.tasks
        .filter((t) => tipoLista(t.listName) === "onboarding" && !ehCancelada(t) && !tarefaExcluida(t.name) && !ehMarcadorRenovacao(t))
        .map((t) => ({ label: t.name, feito: ehConcluida(t) }));

      // Entregáveis = tarefas da lista "Entregáveis" dentro da pasta do cliente
      const entregaveis = info.tasks
        .filter((t) => tipoLista(t.listName) === "entregaveis" && !ehCancelada(t) && !tarefaExcluida(t.name) && !ehMarcadorRenovacao(t))
        .map((t) => ({ label: t.name, feito: ehConcluida(t) }));

      // "chegada" do cliente = data de criação da PASTA (fallback: tarefa mais antiga)
      const folderMs = Number(foldersMeta[String(folderId)]);
      const criadas = info.tasks.map((t) => Number(t.date_created)).filter((n) => !isNaN(n));
      const taskMs = criadas.length ? Math.min.apply(null, criadas) : null;
      const inicioMs = (!isNaN(folderMs) && folderMs) ? folderMs : taskMs;
      const inicioContrato = inicioMs ? new Date(inicioMs).toISOString() : null;
      // Renovação: SÓ quando existe a task-marcador na pasta (prazo = fim do contrato).
      // Sem marcador -> sem data (NÃO estimamos; a tela diz "sem data cadastrada").
      let renovacaoEm = null, termoMeses = null;
      const marcador = info.tasks.find(ehMarcadorRenovacao);
      if (marcador) {
        const fimMs = Number(marcador.due_date);
        renovacaoEm = new Date(fimMs).toISOString();
        if (inicioMs && fimMs > inicioMs) termoMeses = Math.max(1, Math.round((fimMs - inicioMs) / (30.44 * 864e5)));
      }

      escolas.push({
        id: "cu-" + folderId,
        nome: nomeCanonico(info.nome),
        squad,
        // fase inferida pela lista Onboarding real (itens não concluídos -> onboarding)
        fase: onboarding.length > 0 && onboarding.some((o) => !o.feito) ? "onboarding" : "ativo",
        inicioContrato,
        termoMeses,
        renovacaoEm,
        ultimaReuniao: null,
        proximaReuniao: null,
        npsExterno: null,
        npsInterno: null,
        npsHistorico: [],
        npsAtualizadoEm: null,
        demandas,
        onboarding,
        entregaveis,
        _source: "clickup",
      });
    }

    // 2ª passada: tarefas da lista solta "Demandas Agente" -> cliente pelo nome no
    // título (ex.: "Colégio X - criar criativo" cai no cliente Colégio X).
    if (soltas.length && escolas.length) {
      const alvos = escolas.map((e) => ({ e, variantes: FD.clientes.variantesDoNome(e.nome).map((v) => FD.clientes.tokens(v)).filter((t) => t.length) }));
      for (const t of soltas) {
        const m = FD.clientes.acharNoTexto(t.name, alvos) || FD.clientes.melhorMatch(t.name, alvos, 0.6);
        if (!m) continue;
        const prazo = t.due_date ? new Date(Number(t.due_date)).toISOString() : null;
        const concluida = ehConcluida(t);
        m.e.demandas.push({
          id: t.id,
          titulo: t.name,
          status: concluida ? "concluída" : (t.statusName || "aberta"),
          responsavel: (t.assignees && t.assignees[0]) || "—",
          responsaveis: (t.assignees && t.assignees.slice()) || [],
          responsaveisIds: (t.assigneesIds && t.assigneesIds.slice()) || [],
          prazo,
          atrasada: ehAtrasada(prazo, concluida),
          lista: t.listName,
          feitoMs: Number(t.date_done) || Number(t.date_created) || 0,
        });
      }
    }

    escolas.sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
    return escolas;
  }

  FD.integrations.clickup = {
    nome: "ClickUp",
    descricao: "Clientes (pastas) e demandas do Space do squad",
    campos: [
      { key: "token", label: "API Token", placeholder: "pk_xxxxx", tipo: "password" },
      { key: "spaceId", label: "ID do Space do squad", placeholder: "90xxxxxxxx" },
    ],
    conectado(squad) {
      const c = FD.config?.[squad]?.clickup;
      return !!(c && c.token && c.spaceId);
    },

    async listarSpaces(creds) {
      return chamarProxy("spaces", creds);
    },

    async inspect(creds) {
      return chamarProxy("space-inspect", creds, { spaceId: creds.spaceId });
    },

    async fetch(squad) {
      if (!this.conectado(squad)) return null; // -> mock
      const { token, spaceId } = FD.config[squad].clickup;
      try {
        const resp = await chamarProxy("space-tasks", { token, squad }, { spaceId });
        return { source: "clickup", escolas: construirEscolas(resp.tasks || [], squad, resp.folders || {}) };
      } catch (e) {
        console.warn("[clickup] fetch falhou, mantendo mock:", e.message);
        return null;
      }
    },

    // TODAS as tarefas (qualquer lista) de um responsável, sob demanda e rápido
    // (consulta filtrada por assignee no ClickUp). Usado pelo filtro de pessoa.
    async tarefasPorResponsavel(squads, repId) {
      const out = [];
      for (const sq of (squads || [])) {
        if (!this.conectado(sq)) continue;
        const { token, spaceId } = FD.config[sq].clickup;
        try {
          const { tasks } = await chamarProxy("user-tasks", { token, squad: sq }, { spaceId, assignee: repId });
          for (const t of (tasks || [])) {
            // só tarefas COM data, sem canceladas e sem as rotinas excluídas
            if (ehCancelada(t) || tarefaExcluida(t.name) || !t.due_date) continue;
            const prazo = new Date(Number(t.due_date)).toISOString();
            const concluida = ehConcluida(t);
            out.push({
              id: t.id,
              titulo: t.name,
              status: concluida ? "concluída" : (t.statusName || "aberta"),
              responsavel: (t.assignees && t.assignees[0]) || "—",
              prazo,
              atrasada: ehAtrasada(prazo, concluida),
              lista: t.listName,
              cliente: nomeCanonico(t.folderName || "") || "—",
              squad: sq,
            });
          }
        } catch (e) {
          console.warn("[clickup] tarefasPorResponsavel falhou", sq, e.message);
        }
      }
      return out;
    },
  };
})();
