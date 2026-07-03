# Fournier · Dash Operacional

Dashboard/CRM interno para acompanhar a saúde da operação de atendimento às
escolas, dividido em **Squad Azul** e **Squad Laranja**. Construído com
filosofia **80/20 + gestão por exceção**: a primeira tela mostra o que precisa
de ação hoje, não tudo que está ok.

> **Status atual:** front-end completo rodando com **dados de exemplo (mock)** —
> 60 escolas (30 por squad). As integrações reais ainda não estão conectadas
> (cada uma é um módulo plugável; ver abaixo).

---

## ▶️ Como rodar (não precisa de Node)

Como o app usa React + Tailwind via CDN, basta servir a pasta com qualquer
servidor estático. Com Python (já instalado no Mac):

```bash
cd fournier-dash-operacional
python3 -m http.server 8000
```

Abra **http://localhost:8000** no navegador (funciona bem no celular também,
acessando o IP da sua máquina na mesma rede).

> ⚠️ Precisa ser via servidor (http), não abrindo o arquivo direto (file://),
> porque o Babel busca o `app.jsx` por HTTP.

---

## 🗂️ Estrutura

```
fournier-dash-operacional/
├─ index.html              ← carrega tudo (CDNs + scripts)
└─ src/
   ├─ lib/format.js        ← helpers (BRL, datas, cores dos squads) + window.FD
   ├─ lib/configStore.js   ← guarda as credenciais no navegador (localStorage)
   ├─ mocks/data.js        ← 60 escolas fictícias (determinístico)
   ├─ engine/criticidade.js← motor do semáforo + prioridades da semana
   ├─ integrations/        ← UM MÓDULO POR FONTE (plugável)
   │  ├─ clickup.js
   │  ├─ googleCalendar.js
   │  ├─ nps.js
   │  ├─ sheets.js
   │  └─ registry.js       ← orquestra: usa real se conectado, senão mock
   └─ (a UI React vive inline no index.html, transpilada pelo Babel no navegador)
```

## 🔐 Acesso (login por perfil)

Edite os usuários/senhas em `src/lib/auth.js`. Padrão:

| Perfil | Vê | Senha padrão |
|--------|-----|--------------|
| **Diretoria** | tudo (consolidado + filtro por squad) | `fournier@2026` |
| **Squad Azul** | só a carteira Azul | `azul@2026` |
| **Squad Laranja** | só a carteira Laranja | `laranja@2026` |

Cada squad vê **apenas** seus clientes, demandas e números — isolamento total.

## 🧭 Telas

- **Resumo** — saúde da carteira + 3 KPIs clicáveis (NPS escolas, Renovações ≤60d,
  Reuniões pendentes) + **clientes prioritários** (quem, por quê e 1 ação) +
  "esta semana". Clicar num KPI leva à aba já priorizada.
- **Renovações** — contratos por proximidade de vencimento, cruzados com a chance de renovar.
- **Reuniões** — cadência quinzenal: pendentes no topo, com pauta sugerida pelo NPS.
- **NPS** — externo (escola) e interno (time), quedas e detratores.
- **Demandas** — abertas/atrasadas, com carga por responsável (gargalo).
- **Clientes** — ranking por criticidade (mais negativo no topo, cruzando as fontes).
- **Detalhe do cliente** — NPS (com evolução), chance de renovar, reuniões, renovação,
  tempo ativo, onboarding e entregáveis, e o **plano para reverter**.
- **Integrações** (⚙) — cada squad vincula aqui suas credenciais/links
  (ClickUp, Agenda, NPS, Planilhas). Salvo no navegador (localStorage).

## 🚦 Como o semáforo é calculado

`src/engine/criticidade.js` soma sinais → 🔴 (≥6) / 🟡 (3-5) / 🟢 (<3):
sem reunião +15d, demandas atrasadas, NPS baixo, onboarding travado,
entregáveis faltando.

---

## 🔌 Como conectar cada fonte (uma de cada vez)

O dashboard **sempre funciona**: o que não estiver conectado segue no mock,
marcado como "dados de exemplo". Para plugar uma fonte:

1. Abra a aba **Integrações** no dashboard e preencha as credenciais/links da
   fonte, no squad correspondente. Clique em **Salvar credenciais** (fica no
   navegador). Isso já marca a fonte como "configurada".
2. Implemente o `fetch(squad)` real no módulo em `src/integrations/<fonte>.js`
   (já tem o esqueleto comentado), normalizando para o formato do mock.
3. Descomente a linha correspondente em `src/integrations/registry.js`.

| Fonte | O que traz | Onde pegar a credencial |
|-------|-----------|--------------------------|
| **ClickUp** | demandas/tarefas por squad | Settings → Apps → API Token + IDs das listas |
| **Google Agenda** | reuniões (calcula "sem reunião +15d") | Google Cloud Console → Calendar API + calendarId |
| **NPS** | notas interno/externo | depende da sua fonte (Typeform/Sheets/API) |
| **Google Sheets** | planilhas de cada squad | Sheets API key + IDs das planilhas |

> Ordem sugerida de integração: **ClickUp → Agenda → NPS → Planilhas**.
