/* ==========================================================================
 * CLIENTES — fonte única dos nomes oficiais + apelidos, e o MATCHER tolerante.
 *
 * Usado por TODAS as fontes (ClickUp, Agenda, NPS) para resolver um texto
 * solto (nome de pasta, título de reunião, linha de planilha) no cliente certo,
 * sem exigir grafia exata: ignora acento/maiúscula/pontuação e aceita o nome
 * (ou apelido) contido em um texto maior.
 * ========================================================================== */
(function () {
  const FD = (window.FD = window.FD || {});
  const norm = FD.lib.norm; // vem de format.js
  function tokens(s) { return norm(s).split(" ").filter(Boolean); }

  // [nome oficial, [apelidos aceitos]]
  const CLIENTES_OFICIAIS = [
    ["Escola Cristã de Uberaba", ["Uberaba"]],
    ["Colégio Jatobá", ["Jatobá"]],
    ["Geração 2000", []],
    ["Aline Lucio", ["Aline"]],
    ["Gota", []],
    ["RJ Tour", []],
    ["Colégio Futura Ipiranga", ["Futura Ipiranga", "Futura"]],
    ["Instituto Montessori", ["Montessori"]],
    ["Colégio Professor Anselmo", ["CPA", "Professor Anselmo", "Anselmo"]],
    ["Fisk Búzios", []],
    ["Fisk Maricá", []],
    ["Oga Mitá", ["Oga", "Oga Mitá"]],
    ["Fórmula Animal", ["Éder"]],
    ["Creche Escola Mundo da Gente", ["Mundo da Gente"]],
    ["Fisk Recife", []],
    ["Escola Técnica Destake", ["Destake", "Bruna"]],
    ["Colégio Santa Clara", ["Santa Clara"]],
    ["CE Serra e Mar", ["CESEM", "Serra e Mar"]],
    ["LS Idiomas", ["LS"]],
    ["Escola Pólen", ["Pólen"]],
    ["Colégio Free World", ["Free World"]],
    ["Colégio Onis", ["Onis"]],
    ["NRI Comecinho de Vida", ["Comecinho de Vida", "Comecinho"]],
    ["Nossa Senhora de Fátima", ["NSF Fátima", "Fátima"]],
    ["Preparando Gerações", []],
    ["Colégio Batista Vida", ["Batista Vida"]],
    ["Colégio Albert Einstein", ["Albert Einstein", "Einstein"]],
    ["Colégio João Batista", ["João Batista"]],
    ["Colégio Educriarte Taguatinga DF", ["Educriarte"]],
    ["Beginnings Education", ["Beginnings"]],
    ["Colégio Lourenço Filho", ["Lourenço Filho"]],
    ["Machado Store", ["Machado"]],
    ["Its Krok", ["Krok", "Bárbara"]],
    ["Rachel Lançamento", ["Rachel"]],
  ];

  // Variantes globais (oficial + apelidos), mais específicas (mais palavras) primeiro.
  const _VARIANTES = [];
  const _POROFICIAL = {};
  for (const par of CLIENTES_OFICIAIS) {
    const oficial = par[0];
    _POROFICIAL[oficial] = [oficial].concat(par[1]);
    for (const v of [oficial].concat(par[1])) {
      const tk = tokens(v);
      if (tk.length) _VARIANTES.push({ oficial, tk });
    }
  }
  _VARIANTES.sort((a, b) => b.tk.length - a.tk.length);

  // Resolve um nome "qualquer" (pasta) para o nome oficial (ou mantém o original).
  // Memoizado: função pura sobre tabelas imutáveis (_VARIANTES) e o mesmo nome se repete
  // muito por carga (o registry canoniza e.nome 2x/escola). Cache limitado aos nomes vistos.
  const _canonCache = new Map();
  function nomeCanonico(texto) {
    const k = (texto == null ? "" : String(texto));
    if (_canonCache.has(k)) return _canonCache.get(k);
    const r = _nomeCanonicoCalc(texto);
    _canonCache.set(k, r);
    return r;
  }
  function _nomeCanonicoCalc(texto) {
    const ftk = tokens(texto);
    if (!ftk.length) return (texto || "").trim();
    const fset = new Set(ftk);
    for (const v of _VARIANTES) if (v.tk.every((t) => fset.has(t))) return v.oficial;
    // pasta é abreviação do oficial — mas só canoniza se o match for ÚNICO
    let achado = null;
    for (const v of _VARIANTES) {
      const vset = new Set(v.tk);
      if (ftk.every((t) => vset.has(t))) {
        if (achado && achado !== v.oficial) return (texto || "").trim(); // ambíguo
        achado = v.oficial;
      }
    }
    return achado || (texto || "").trim();
  }

  // Variantes (oficial + apelidos) de um nome oficial; se não for listado, só ele.
  function variantesDoNome(nomeOficial) {
    return _POROFICIAL[nomeOficial] || [nomeOficial];
  }

  // Dado um TEXTO livre (ex.: título de reunião) e uma lista de candidatos
  // {nome, variantes:[...]} , acha o candidato cuja variante MAIS específica
  // (mais palavras) está contida no texto. Retorna o objeto candidato ou null.
  function acharNoTexto(texto, candidatos) {
    const ttk = tokens(texto);
    if (!ttk.length) return null;
    const tset = new Set(ttk);
    let melhor = null, melhorN = 0, empatado = false;
    for (const c of candidatos) {
      for (const v of c.variantes) {
        const vtk = Array.isArray(v) ? v : tokens(v);
        if (!vtk.length || !vtk.every((t) => tset.has(t))) continue;
        if (vtk.length > melhorN) { melhor = c; melhorN = vtk.length; empatado = false; }
        else if (vtk.length === melhorN && c !== melhor) empatado = true; // 2 clientes no mesmo nível
      }
    }
    return empatado ? null : melhor; // empate ambíguo -> não casa (melhor não errar)
  }

  // Match TOLERANTE p/ nomes "soltos" (ex.: planilha de NPS, onde a pessoa
  // pode escrever com erro/palavra a mais ou a menos). Pega o candidato com a
  // MAIOR cobertura das palavras de alguma variante, acima de um limiar.
  function melhorMatch(texto, candidatos, limiar) {
    const ttk = tokens(texto);
    if (!ttk.length) return null;
    const tset = new Set(ttk);
    let melhor = null, melhorScore = 0, melhorN = 0, empatado = false;
    for (const c of candidatos) {
      for (const v of c.variantes) {
        const vtk = Array.isArray(v) ? v : tokens(v);
        if (!vtk.length) continue;
        const inter = vtk.filter((t) => tset.has(t)).length;
        const score = inter / vtk.length; // fração das palavras da variante no texto
        if (inter <= 0) continue;
        if (score > melhorScore || (score === melhorScore && vtk.length > melhorN)) {
          melhorScore = score; melhorN = vtk.length; melhor = c; empatado = false;
        } else if (score === melhorScore && vtk.length === melhorN && c !== melhor) {
          empatado = true; // dois clientes distintos empatam no topo -> ambíguo
        }
      }
    }
    if (empatado) return null; // ambíguo -> não casa (não chuta o primeiro)
    return melhorScore >= (limiar == null ? 0.6 : limiar) ? melhor : null;
  }

  // Devolve TODOS os clientes que "fazem sentido" no texto. Usado pela AGENDA: um
  // evento pode ser de VÁRIOS clientes (reunião conjunta de unidades).
  //
  // FLEXÍVEL por design — casa de 3 formas (a mais forte que valer):
  //  (a) variante INTEIRA contida no título (match exato);
  //  (b) TOKEN DISTINTIVO: palavra ÚNICA de 1 cliente entre os candidatos, com >=4
  //      letras (ex.: "buzios"/"marica"), ignorando as GENÉRICAS que 2+ clientes
  //      compartilham ("fisk", "colegio", "escola"). Assim "Reunião Fisk Búzios e
  //      Maricá" casa as DUAS unidades mesmo sem repetir "Fisk";
  //  (c) fallback: cobertura parcial das palavras da variante acima do limiar (antigo).
  // Remove aninhados (ex.: "Vida" dentro de "Comecinho de Vida") -> fica o mais específico.
  function melhorMatchTodos(texto, candidatos, limiar) {
    const lim = limiar == null ? 0.6 : limiar;
    const tset = new Set(tokens(texto));
    if (!tset.size) return [];

    // Quantos CLIENTES têm cada token (1x por cliente). Token em 2+ clientes = genérico.
    const freq = {};
    for (const c of candidatos) {
      const vistos = new Set();
      for (const v of c.variantes) {
        const vtk = Array.isArray(v) ? v : tokens(v);
        for (const t of vtk) if (!vistos.has(t)) { vistos.add(t); freq[t] = (freq[t] || 0) + 1; }
      }
    }
    const distintivo = (t) => t.length >= 4 && freq[t] === 1;

    const casados = [];
    for (const c of candidatos) {
      let tk = null; // tokens do título que justificam o match deste cliente
      for (const v of c.variantes) { // (a) variante inteira no título
        const vtk = Array.isArray(v) ? v : tokens(v);
        if (vtk.length && vtk.every((t) => tset.has(t))) { tk = new Set(vtk); break; }
      }
      if (!tk) { // (b) token distintivo do cliente presente no título
        const dist = new Set();
        for (const v of c.variantes) {
          const vtk = Array.isArray(v) ? v : tokens(v);
          for (const t of vtk) if (distintivo(t) && tset.has(t)) dist.add(t);
        }
        if (dist.size) tk = dist;
      }
      if (!tk) { // (c) fallback: cobertura parcial acima do limiar
        let best = 0, inter = null;
        for (const v of c.variantes) {
          const vtk = Array.isArray(v) ? v : tokens(v);
          if (!vtk.length) continue;
          const pres = vtk.filter((t) => tset.has(t));
          if (pres.length > 0 && pres.length / vtk.length > best) { best = pres.length / vtk.length; inter = pres; }
        }
        if (best >= lim && inter) tk = new Set(inter);
      }
      if (tk && tk.size) casados.push({ c, tk });
    }
    return casados
      .filter((x, i) => !casados.some((y, j) => j !== i && y.tk.size > x.tk.size && [...x.tk].every((t) => y.tk.has(t))))
      .map((x) => x.c);
  }

  FD.clientes = { norm, tokens, nomeCanonico, variantesDoNome, acharNoTexto, melhorMatch, melhorMatchTodos, lista: CLIENTES_OFICIAIS };
})();
