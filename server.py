#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
==============================================================================
Fournier Dash — servidor local (estático + proxy de integrações)

Por que existe: o app é uma página estática (roda no navegador). APIs como o
ClickUp BLOQUEIAM chamadas direto do navegador (CORS) e exporiam o seu token.
Este servidor resolve os dois problemas:

  • serve os arquivos do app  (substitui o `python3 -m http.server`)
  • faz de PONTE para o ClickUp: o navegador chama /api/clickup/... (mesma
    origem, sem CORS) e o servidor injeta o token e fala com a api.clickup.com.

O token NÃO precisa ficar no navegador: coloque-o em `proxy.local.json`
(copie de `proxy.local.json.example`). Esse arquivo é só seu — não compartilhe.

Como rodar:
    python3 server.py
Abrir:
    http://localhost:3000

Rotas do proxy:
    GET /api/clickup/<squad>/tasks     -> tarefas normalizadas (cru do ClickUp)
    GET /api/clickup/<squad>/inspect   -> resumo do esquema (campos, status, tags)
                                           usado para descobrir como a tarefa
                                           identifica a ESCOLA.
==============================================================================
"""
import csv
import datetime
import io
import json
import os
import re
import sys
import threading
import time
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib import request as urlrequest, error as urlerror, parse as urlparse

PORT = int(os.environ.get("PORT", "3000"))
ROOT = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(ROOT, "proxy.local.json")
CLICKUP_BASE = "https://api.clickup.com/api/v2"
GCAL_BASE = "https://www.googleapis.com/calendar/v3"
_TEAM_BY_SPACE = {}  # cache: space_id -> team_id (mapeamento estável, evita varrer /team a cada request)

# ---------------------------------------------------------------------------
# CACHE de PAYLOADS de upstream (performance): cada reload da página re-buscava
# ClickUp/Sheets/Calendar do zero — dezenas de round-trips idênticos. Um cache
# em memória com TTL curto torna reloads quase instantâneos. Staleness de ~45s
# é aceitável p/ um painel interno (e some sozinho ao editar a planilha).
# ---------------------------------------------------------------------------
_TTL = 45  # segundos
_CACHE = {}                    # chave -> (expira_em, payload)
_CACHE_LOCK = threading.Lock()


def _cache_get(key):
    with _CACHE_LOCK:
        v = _CACHE.get(key)
        if v and v[0] > time.time():
            return v[1]
        if v:
            _CACHE.pop(key, None)
    return None


def _cache_set(key, payload, ttl=_TTL):
    with _CACHE_LOCK:
        _CACHE[key] = (time.time() + ttl, payload)


def _norm(s):
    """Normaliza para comparar sem depender de acento/maiúscula."""
    s = (s or "").lower()
    return "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn")


def _lista_relevante(nome):
    """Listas que o app consome: qualquer 'Demandas...' ou 'Onboarding...'
    (tolerante a variações). 'Rotinas' e outras ficam de fora."""
    n = _norm(nome)
    return ("demanda" in n) or ("onboarding" in n) or ("criativo" in n) or ("entregav" in n)


_CONFIG_CACHE = {"mtime": None, "data": {}}  # memoiza por mtime (evita ler o disco a cada request /api)


def load_config():
    """Lê proxy.local.json (token/listId por squad). Tolerante a ausência/erro.
    Memoizado pelo mtime do arquivo: só relê do disco quando o arquivo muda."""
    try:
        mtime = os.path.getmtime(CONFIG_PATH)
    except OSError:
        return {}  # arquivo ausente
    if _CONFIG_CACHE["mtime"] == mtime:
        return _CONFIG_CACHE["data"]
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:  # JSON inválido etc.
        print("[proxy] erro lendo proxy.local.json:", e)
        data = {}
    _CONFIG_CACHE["mtime"] = mtime
    _CONFIG_CACHE["data"] = data
    return data


# ---------------------------------------------------------------------------
# CONFIG no SUPABASE (cross-device). Lida SÓ pelo servidor com a service_role
# (env SUPABASE_URL/SUPABASE_SERVICE_ROLE ou o bloco 'supabase' do proxy.local.json).
# O navegador NUNCA recebe os segredos — o proxy injeta token/links nas chamadas.
# ---------------------------------------------------------------------------
_SB_CFG_CACHE = {}
_SB_CFG_LOCK = threading.Lock()


def _sb_creds():
    sb = (load_config().get("supabase") or {})
    url = (os.environ.get("SUPABASE_URL") or sb.get("url") or "").strip().rstrip("/")
    key = (os.environ.get("SUPABASE_SERVICE_ROLE") or sb.get("serviceRole") or "").strip()
    return url, key


def _sb_config(squad):
    """Config do squad no Supabase ({} se não houver). Cache curto (30s)."""
    url, key = _sb_creds()
    if not url or not key:
        return {}
    now = time.time()
    with _SB_CFG_LOCK:
        v = _SB_CFG_CACHE.get(squad)
        if v and v[0] > now:
            return v[1]
    try:
        u = "%s/rest/v1/config?squad=eq.%s&select=*" % (url, urlparse.quote(str(squad)))
        req = urlrequest.Request(u, headers={"apikey": key, "Authorization": "Bearer " + key})
        with urlrequest.urlopen(req, timeout=10) as r:
            rows = json.loads(r.read().decode("utf-8"))
        cfg = rows[0] if rows else {}
    except Exception as e:
        print("[supabase] config %s falhou: %s" % (squad, e))
        cfg = {}
    with _SB_CFG_LOCK:
        _SB_CFG_CACHE[squad] = (now + 30, cfg)
    return cfg


def _config_status():
    """Bool por squad/fonte (NÃO-secreto) p/ o front saber o que já está configurado."""
    out = {}
    for sq in ("azul", "laranja"):
        c = _sb_config(sq)
        out[sq] = {
            "clickup": bool(c.get("clickup_token") and c.get("clickup_space_id")),
            "googleCalendar": bool(c.get("gcal_api_key") and c.get("gcal_calendar_id")),
            "nps": bool(c.get("nps_link_interna") or c.get("nps_link_externa")),
            "controle": bool(c.get("controle_link")),
            "ltv": bool(c.get("ltv_link")),
        }
    return out


def _config_valores():
    """Valores NÃO-secretos por squad (calendarId, spaceId, links) p/ sincronizar
    entre dispositivos. Secrets (clickup_token, gcal_api_key) NUNCA são expostos."""
    out = {}
    for sq in ("azul", "laranja"):
        c = _sb_config(sq)
        out[sq] = {
            "clickup": {"spaceId": c.get("clickup_space_id") or ""},
            "googleCalendar": {"calendarId": c.get("gcal_calendar_id") or ""},
            "nps": {"linkInterna": c.get("nps_link_interna") or "", "linkExterna": c.get("nps_link_externa") or ""},
            "controle": {"link": c.get("controle_link") or ""},
            "ltv": {"link": c.get("ltv_link") or ""},
        }
    return out


def _save_config_rows(data):
    """Grava a config (estrutura do FD.config) na tabela Supabase. (status, payload)."""
    url, key = _sb_creds()
    if not url or not key:
        return 400, {"error": "Supabase não configurado no servidor"}
    saved = []
    for squad in ("azul", "laranja"):
        c = (data.get(squad) or {})

        def g(fonte, campo):
            return (c.get(fonte) or {}).get(campo) or None
        novos = {
            "clickup_token": g("clickup", "token"), "clickup_space_id": g("clickup", "spaceId"),
            "gcal_api_key": g("googleCalendar", "apiKey"), "gcal_calendar_id": g("googleCalendar", "calendarId"),
            "nps_link_interna": g("nps", "linkInterna"), "nps_link_externa": g("nps", "linkExterna"),
            "controle_link": g("controle", "link"), "ltv_link": g("ltv", "link"),
        }
        if not any(novos.values()):
            continue  # squad sem nada preenchido -> não mexe
        # MERGE não-destrutivo: preserva no banco os campos que este device NÃO enviou
        # (evita que salvar de um aparelho sem todos os segredos zere o resto).
        existente = _sb_config(squad) or {}
        row = {"squad": squad}
        for col, val in novos.items():
            row[col] = val if val is not None else (existente.get(col) or None)
        try:
            req = urlrequest.Request("%s/rest/v1/config" % url, data=json.dumps(row).encode("utf-8"),
                                     headers={"apikey": key, "Authorization": "Bearer " + key,
                                              "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates"},
                                     method="POST")
            urlrequest.urlopen(req, timeout=10).read()
            saved.append(squad)
        except Exception as e:
            return 502, {"error": "falha ao salvar no Supabase", "detalhe": str(e)}
    with _SB_CFG_LOCK:
        _SB_CFG_CACHE.clear()
    return 200, {"ok": True, "saved": saved}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    # ---- util ----------------------------------------------------------
    def _send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        # Dev local: NUNCA cachear, para que mudanças em JS/HTML apareçam sempre
        # no reload (evita o navegador rodar um arquivo velho em cache).
        self.send_header("Cache-Control", "no-store, max-age=0")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    # Bloqueia segredos/código do servidor e desliga o 304 (cache do navegador).
    def send_head(self):
        rel = urlparse.unquote(urlparse.urlparse(self.path).path)
        base = os.path.basename(rel).lower()
        if base.startswith(".") or base.endswith(".local.json") or base == "server.py":
            self.send_error(404)
            return None
        for h in ("If-Modified-Since", "If-None-Match"):
            if h in self.headers:
                del self.headers[h]
        return super().send_head()

    # Sem listagem de diretório (não expor a estrutura interna).
    def list_directory(self, path):
        self.send_error(404)
        return None

    # ---- roteamento ----------------------------------------------------
    def _host_ok(self):
        # Anti DNS-rebinding: o token vive no servidor, então só aceitamos /api
        # quando o Host (e Origin/Referer, se houver) é o próprio loopback.
        permitidos = {"127.0.0.1:%d" % PORT, "localhost:%d" % PORT, "[::1]:%d" % PORT}
        host = (self.headers.get("Host") or "").strip().lower()
        for h in ("Origin", "Referer"):
            v = self.headers.get(h)
            if v:
                netloc = urlparse.urlparse(v).netloc.lower()
                if netloc and netloc not in permitidos:
                    return False
        return host in permitidos

    def do_GET(self):
        if self.path.startswith("/api/"):
            if not self._host_ok():
                return self._send_json(403, {"error": "Host não permitido. Acesse via http://localhost:%d" % PORT})
            if self.path.startswith("/api/clickup/"):
                return self.handle_clickup()
            if self.path.startswith("/api/gcal/"):
                return self.handle_gcal()
            if self.path.startswith("/api/nps/"):
                return self.handle_nps()
            if self.path.startswith("/api/sheet/"):
                return self.handle_sheet()
            if self.path.startswith("/api/config"):
                return self._send_json(200, dict(_config_status(), _valores=_config_valores()))
            return self._send_json(404, {"error": "rota /api desconhecida"})
        return super().do_GET()  # arquivos estáticos

    def do_POST(self):
        if self.path.startswith("/api/config"):
            if not self._host_ok():
                return self._send_json(403, {"error": "Host não permitido."})
            length = int(self.headers.get("Content-Length") or 0)
            try:
                data = json.loads(self.rfile.read(length).decode("utf-8")) if length else {}
            except Exception:
                return self._send_json(400, {"error": "JSON inválido"})
            st, pl = _save_config_rows(data)
            return self._send_json(st, pl)
        return self._send_json(404, {"error": "rota /api desconhecida"})

    # ---- Planilha genérica (Controle/Onboarding) -----------------------
    def handle_sheet(self):
        parsed = urlparse.urlparse(self.path)
        parts = [p for p in parsed.path.split("/") if p]  # api / sheet / <squad>
        squad = parts[2] if len(parts) > 2 else ""
        qs = urlparse.parse_qs(parsed.query)
        cfg = (load_config().get(squad, {}) or {}).get("controle", {}) or {}
        src = (qs.get("src", [None])[0])  # 'controle' | 'ltv' -> escolhe o link certo no Supabase
        sbc = _sb_config(squad)
        sb_link = sbc.get(src + "_link") if src in ("controle", "ltv") else None
        link = (qs.get("url", [None])[0]) or cfg.get("link") or sb_link
        sheet = qs.get("sheet", [None])[0]  # aba por NOME (ex.: "Squad Laranja")
        if not link:
            return self._send_json(400, {"error": "sem link da planilha de controle"})
        try:
            headers, rows = self._sheet_csv(link, sheet)
        except ValueError as e:
            if sheet:
                return self._send_json(200, {"headers": [], "rows": [], "vazio": True})
            return self._send_json(400, {"error": str(e)})
        except Exception as e:
            if sheet:
                return self._send_json(200, {"headers": [], "rows": [], "vazio": True})
            return self._send_json(502, {"error": "falha ao ler a planilha", "detalhe": str(e)})
        return self._send_json(200, {"headers": headers, "rows": rows, "total": len(rows)})

    # ---- ClickUp -------------------------------------------------------
    def handle_clickup(self):
        parsed = urlparse.urlparse(self.path)
        parts = [p for p in parsed.path.split("/") if p]  # api / clickup / <squad> / <acao>
        if len(parts) < 4:
            return self._send_json(400, {"error": "rota inválida. Use /api/clickup/<squad>/<acao>"})
        squad, acao = parts[2], parts[3]

        cfg = load_config().get(squad, {}) or {}
        qs = urlparse.parse_qs(parsed.query)

        # Token: 1) proxy.local.json (recomendado, fora do navegador)
        #        2) variável de ambiente CLICKUP_TOKEN
        #        3) header X-CU-Token enviado pelo app (fallback p/ funcionar já)
        sbc = _sb_config(squad)
        token = cfg.get("token") or os.environ.get("CLICKUP_TOKEN") or self.headers.get("X-CU-Token") or sbc.get("clickup_token")
        # spaceId: query tem prioridade; senão proxy.local.json; senão Supabase
        space_id = (qs.get("spaceId", [None])[0]) or cfg.get("spaceId") or sbc.get("clickup_space_id")

        if not token:
            return self._send_json(401, {
                "error": "sem token do ClickUp",
                "dica": "preencha o API Token na aba Integrações (ou em proxy.local.json)",
            })

        # ====== MODELO POR SPACE (cada squad = um Space; cada pasta = 1 cliente) ======
        # 'spaces' lista os spaces visíveis ao token (para o usuário escolher o do squad).
        if acao == "spaces":
            try:
                spaces = self._clickup_spaces(token)
            except urlerror.HTTPError as e:
                return self._send_json(e.code, {"error": "ClickUp respondeu HTTP %s" % e.code, "detalhe": e.read().decode("utf-8", "ignore")[:600]})
            except Exception as e:
                return self._send_json(502, {"error": "falha ao listar os spaces", "detalhe": str(e)})
            self._log_spaces(squad, spaces)
            return self._send_json(200, {"spaces": spaces})

        # 'space-tasks' / 'space-inspect' varrem TODAS as tarefas do space (1 sweep).
        if acao in ("space-tasks", "space-inspect"):
            if not space_id:
                return self._send_json(400, {
                    "error": "sem spaceId",
                    "dica": "use 'Listar meus spaces' e clique no Space do squad",
                })
            try:
                tasks, folders_meta = self._clickup_space_tasks(token, space_id)
            except urlerror.HTTPError as e:
                return self._send_json(e.code, {"error": "ClickUp respondeu HTTP %s" % e.code, "detalhe": e.read().decode("utf-8", "ignore")[:600]})
            except Exception as e:
                return self._send_json(502, {"error": "falha ao puxar tarefas do space", "detalhe": str(e)})
            if acao == "space-inspect":
                resumo = self._inspect_space(tasks)  # inspect vê TODAS as listas
                self._log_space_inspect(squad, space_id, resumo)
                return self._send_json(200, resumo)
            # space-tasks: só as listas que o app usa (enxuga o payload)
            enxuto = [t for t in tasks if _lista_relevante(t.get("listName"))]
            self._log_space_tasks(squad, enxuto)
            return self._send_json(200, {"tasks": enxuto, "folders": folders_meta})

        # 'user-tasks' — TODAS as tarefas (qualquer lista) de um responsável.
        if acao == "user-tasks":
            assignee = (qs.get("assignee", [None])[0])
            if not space_id or not assignee:
                return self._send_json(400, {"error": "faltou spaceId ou assignee"})
            try:
                tasks = self._clickup_user_tasks(token, space_id, assignee)
            except urlerror.HTTPError as e:
                return self._send_json(e.code, {"error": "ClickUp respondeu HTTP %s" % e.code, "detalhe": e.read().decode("utf-8", "ignore")[:600]})
            except Exception as e:
                return self._send_json(502, {"error": "falha ao puxar tarefas do responsável", "detalhe": str(e)})
            print("[user-tasks %s] assignee=%s -> %d tarefas" % (squad, assignee, len(tasks)))
            return self._send_json(200, {"tasks": tasks})

        return self._send_json(404, {"error": "ação desconhecida: %s" % acao})

    # ---- Google Agenda ----------------------------------------------------
    def handle_gcal(self):
        parsed = urlparse.urlparse(self.path)
        parts = [p for p in parsed.path.split("/") if p]  # api / gcal / <squad> / <acao>
        if len(parts) < 4:
            return self._send_json(400, {"error": "rota inválida. Use /api/gcal/<squad>/events|inspect"})
        squad, acao = parts[2], parts[3]
        cfg = (load_config().get(squad, {}) or {}).get("googleCalendar", {}) or {}
        qs = urlparse.parse_qs(parsed.query)
        sbc = _sb_config(squad)
        api_key = cfg.get("apiKey") or os.environ.get("GCAL_KEY") or self.headers.get("X-GC-Key") or sbc.get("gcal_api_key")
        calendar_id = (qs.get("calendarId", [None])[0]) or cfg.get("calendarId") or sbc.get("gcal_calendar_id")
        if not api_key:
            return self._send_json(401, {"error": "sem API key da Agenda", "dica": "preencha a API Key do Google na aba Integrações"})
        if not calendar_id:
            return self._send_json(400, {"error": "sem calendarId", "dica": "preencha o Calendar ID na aba Integrações"})
        try:
            eventos = self._gcal_events(api_key, calendar_id)
        except urlerror.HTTPError as e:
            return self._send_json(e.code, {"error": "Google respondeu HTTP %s" % e.code, "detalhe": e.read().decode("utf-8", "ignore")[:600]})
        except Exception as e:
            return self._send_json(502, {"error": "falha ao chamar a Agenda", "detalhe": str(e)})
        if acao == "inspect":
            resumo = self._inspect_gcal(eventos)
            self._log_gcal(squad, calendar_id, resumo)
            return self._send_json(200, resumo)
        return self._send_json(200, {"events": eventos})

    def _gcal_get(self, url):
        req = urlrequest.Request(url, headers={"Accept": "application/json"})
        with urlrequest.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode("utf-8"))

    def _gcal_events(self, api_key, calendar_id):
        """Eventos do calendário numa janela de -120d a +60d (paginado)."""
        ck = ("gcal", str(calendar_id))
        cached = _cache_get(ck)
        if cached is not None:
            return cached
        now = datetime.datetime.now(datetime.timezone.utc)
        tmin = (now - datetime.timedelta(days=120)).strftime("%Y-%m-%dT%H:%M:%SZ")
        tmax = (now + datetime.timedelta(days=60)).strftime("%Y-%m-%dT%H:%M:%SZ")
        out = []
        page_token = None
        for _ in range(20):
            url = ("%s/calendars/%s/events?key=%s&timeMin=%s&timeMax=%s&singleEvents=true&orderBy=startTime&maxResults=2500"
                   % (GCAL_BASE, urlparse.quote(str(calendar_id), safe=""),
                      urlparse.quote(str(api_key), safe=""), urlparse.quote(tmin), urlparse.quote(tmax)))
            if page_token:
                url += "&pageToken=" + urlparse.quote(page_token)
            data = self._gcal_get(url)
            for it in (data.get("items", []) or []):
                if it.get("status") == "cancelled":
                    continue
                start = it.get("start") or {}
                end = it.get("end") or {}
                out.append({
                    "id": it.get("id"),
                    "titulo": it.get("summary") or "(sem título)",
                    "inicio": start.get("dateTime") or start.get("date"),
                    "fim": end.get("dateTime") or end.get("date"),
                    "diaInteiro": not start.get("dateTime"),
                    "local": it.get("location"),
                    "link": it.get("hangoutLink") or it.get("htmlLink"),
                    "participantes": [(a.get("displayName") or a.get("email")) for a in (it.get("attendees") or [])],
                })
            page_token = data.get("nextPageToken")
            if not page_token:
                break
        _cache_set(ck, out)
        return out

    def _inspect_gcal(self, eventos):
        amostra = [{"titulo": e.get("titulo"), "inicio": e.get("inicio")} for e in eventos[:15]]
        return {"total": len(eventos), "amostra": amostra}

    def _log_gcal(self, squad, calendar_id, resumo):
        try:
            print("\n===== GCAL-INSPECT [%s] cal=%s =====" % (squad, calendar_id))
            print("eventos (janela -120d..+60d):", resumo["total"])
            for a in resumo["amostra"]:
                print("   • %s | %s" % (a.get("inicio"), a.get("titulo")))
            print("====================================\n")
        except Exception as e:
            print("[gcal] log falhou:", e)

    # ---- NPS (planilha Google via CSV público) ----------------------------
    def handle_nps(self):
        parsed = urlparse.urlparse(self.path)
        parts = [p for p in parsed.path.split("/") if p]  # api / nps / <squad> / <acao>
        if len(parts) < 4:
            return self._send_json(400, {"error": "rota inválida. Use /api/nps/<squad>/externa|interna"})
        squad, acao = parts[2], parts[3]
        qs = urlparse.parse_qs(parsed.query)
        cfg = (load_config().get(squad, {}) or {}).get("nps", {}) or {}
        chave = "linkInterna" if acao == "interna" else "linkExterna"
        sbc = _sb_config(squad)
        sb_link = sbc.get("nps_link_interna") if acao == "interna" else sbc.get("nps_link_externa")
        link = (qs.get("url", [None])[0]) or cfg.get(chave) or sb_link
        sheet = qs.get("sheet", [None])[0]  # aba por NOME (ex.: "Julho de 2027"); None = aba padrão/gid
        if not link:
            return self._send_json(400, {"error": "sem link da planilha", "dica": "preencha o link da NPS na aba Integrações"})
        try:
            headers, rows = self._sheet_csv(link, sheet)
        except ValueError as e:
            # aba de mês inexistente -> vazio (200), p/ o front pular o mês sem erro
            if sheet:
                return self._send_json(200, {"headers": [], "rows": [], "total": 0, "vazio": True})
            return self._send_json(400, {"error": str(e)})
        except urlerror.HTTPError as e:
            if sheet:
                return self._send_json(200, {"headers": [], "rows": [], "total": 0, "vazio": True})
            return self._send_json(e.code, {"error": "Google respondeu HTTP %s" % e.code, "detalhe": e.read().decode("utf-8", "ignore")[:300]})
        except Exception as e:
            if sheet:
                return self._send_json(200, {"headers": [], "rows": [], "total": 0, "vazio": True})
            return self._send_json(502, {"error": "falha ao ler a planilha", "detalhe": str(e)})
        self._log_nps(squad, acao, headers, rows)
        return self._send_json(200, {"headers": headers, "rows": rows, "total": len(rows)})

    def _get_text(self, url):
        req = urlrequest.Request(url, headers={"Accept": "text/csv,*/*"})
        with urlrequest.urlopen(req, timeout=30) as r:
            return r.read().decode("utf-8-sig", "ignore")  # -sig remove o BOM do header[0]

    def _sheet_csv(self, link, sheet=None):
        """Baixa uma planilha Google como CSV (precisa estar compartilhada:
        'Qualquer pessoa com o link pode ver'). Não exige API key.
        sheet = nome da ABA (ex.: 'Julho de 2027'); se None, usa o gid do link."""
        m = re.search(r"/spreadsheets/d/([a-zA-Z0-9-_]+)", link)
        if not m:
            raise ValueError("link de planilha inválido (esperado .../spreadsheets/d/ID...)")
        sid = m.group(1)
        if sheet:
            url = "https://docs.google.com/spreadsheets/d/%s/gviz/tq?tqx=out:csv&sheet=%s" % (sid, urlparse.quote(sheet))
        else:
            gm = re.search(r"[#&?]gid=([0-9]+)", link)
            gid = gm.group(1) if gm else "0"
            url = "https://docs.google.com/spreadsheets/d/%s/gviz/tq?tqx=out:csv&gid=%s" % (sid, gid)
        # Cache por URL (inclui sucesso E "aba ausente/não compartilhada", p/ não
        # re-tentar toda recarga o mesmo mês inexistente).
        ck = ("sheet", url)
        cached = _cache_get(ck)
        if cached is not None:
            if cached == "__ERR__":
                raise ValueError("aba não encontrada" if sheet else "a planilha não está compartilhada — use 'Qualquer pessoa com o link pode ver'")
            return cached[0], cached[1]
        raw = self._get_text(url)  # HTTPError/rede propaga sem cachear (transitório)
        if raw.lstrip()[:1] == "<":
            _cache_set(ck, "__ERR__")
            raise ValueError("aba não encontrada" if sheet else "a planilha não está compartilhada — use 'Qualquer pessoa com o link pode ver'")
        all_rows = list(csv.reader(io.StringIO(raw)))
        result = ([], []) if not all_rows else (all_rows[0], all_rows[1:])
        _cache_set(ck, result)
        return result

    def _log_nps(self, squad, acao, headers, rows):
        try:
            print("\n===== NPS-%s [%s] — %d linha(s) =====" % (acao.upper(), squad, len(rows)))
            print("colunas:")
            for i, h in enumerate(headers):
                print("   [%d] %s" % (i, h))
            for r in rows[:5]:
                print("   linha:", r)
            print("=====================================\n")
        except Exception as e:
            print("[nps] log falhou:", e)

    # ---- modelo por SPACE -------------------------------------------------
    def _cu_get(self, token, url):
        req = urlrequest.Request(url, headers={"Authorization": token, "Content-Type": "application/json"})
        with urlrequest.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode("utf-8"))

    def _clickup_spaces(self, token):
        """Todos os spaces visíveis ao token (cada squad vai apontar para um)."""
        out = []
        for team in (self._cu_get(token, CLICKUP_BASE + "/team") or {}).get("teams", []) or []:
            try:
                spaces = (self._cu_get(token, "%s/team/%s/space?archived=false" % (CLICKUP_BASE, team["id"])) or {}).get("spaces", []) or []
            except Exception:
                spaces = []
            for sp in spaces:
                out.append({"id": sp.get("id"), "name": sp.get("name"), "team": team.get("name"), "teamId": team.get("id")})
        return out

    def _team_do_space(self, token, space_id):
        if str(space_id) in _TEAM_BY_SPACE:
            return _TEAM_BY_SPACE[str(space_id)]
        teams = (self._cu_get(token, CLICKUP_BASE + "/team") or {}).get("teams", []) or []
        for team in teams:
            try:
                spaces = (self._cu_get(token, "%s/team/%s/space?archived=false" % (CLICKUP_BASE, team["id"])) or {}).get("spaces", []) or []
            except Exception:
                spaces = []
            for s in spaces:
                if s.get("id") is not None:
                    _TEAM_BY_SPACE[str(s.get("id"))] = team["id"]
        return _TEAM_BY_SPACE.get(str(space_id)) or (teams[0]["id"] if teams else None)

    def _folders_do_space(self, token, space_id):
        """Pastas do space (cada pasta = 1 cliente), com suas listas e date_created."""
        try:
            return (self._cu_get(token, "%s/space/%s/folder?archived=false" % (CLICKUP_BASE, urlparse.quote(str(space_id)))) or {}).get("folders", []) or []
        except Exception:
            return []

    def _proj_task(self, t):
        folder = t.get("folder") or {}
        lst = t.get("list") or {}
        st = t.get("status") or {}
        return {
            "id": t.get("id"), "name": t.get("name"),
            "listName": lst.get("name"),
            "folderId": folder.get("id"), "folderName": folder.get("name"),
            "folderHidden": bool(folder.get("hidden")),
            "statusName": st.get("status"), "statusType": st.get("type"),
            "assignees": [a.get("username") for a in (t.get("assignees") or [])],
            "assigneesIds": [a.get("id") for a in (t.get("assignees") or [])],
            "due_date": t.get("due_date"), "date_created": t.get("date_created"),
            "date_done": t.get("date_done"),
        }

    def _paginar_team_tasks(self, token, team_id, extra_params):
        out = []
        page = 0
        while True:
            url = "%s/team/%s/task?page=%d&subtasks=true&include_closed=true%s" % (CLICKUP_BASE, team_id, page, extra_params)
            data = self._cu_get(token, url)
            lote = data.get("tasks", []) or []
            for t in lote:
                out.append(self._proj_task(t))
            if data.get("last_page") is True or len(lote) < 100 or page > 120:
                break
            page += 1
        return out

    def _clickup_space_tasks(self, token, space_id):
        """RÁPIDO: só as tarefas das listas relevantes (via list_ids).
        Retorna (tasks, folders_meta) com folders_meta = {folderId: date_created}
        para estimar a 'chegada' do cliente pela criação da PASTA."""
        ck = ("cu-space", str(space_id))
        cached = _cache_get(ck)
        if cached is not None:
            return cached
        # PERF (cold): team, pastas e listas SOLTAS resolvidos em PARALELO (antes eram 3
        # round-trips sequenciais ao ClickUp). Consumidos na MESMA ordem -> exceções/erros
        # idênticos ao fluxo anterior; a montagem de list_ids/meta abaixo não muda.
        with ThreadPoolExecutor(max_workers=3) as _ex:
            f_team = _ex.submit(self._team_do_space, token, space_id)
            f_folders = _ex.submit(self._folders_do_space, token, space_id)
            f_lists = _ex.submit(lambda: (self._cu_get(token, "%s/space/%s/list?archived=false" % (CLICKUP_BASE, urlparse.quote(str(space_id)))) or {}).get("lists", []) or [])
            team_id = f_team.result()
            if not team_id:
                return [], {}
            list_ids = []
            meta = {}
            for fo in f_folders.result():
                if fo.get("id") is not None:
                    meta[str(fo.get("id"))] = fo.get("date_created")
                for l in (fo.get("lists") or []):
                    if _lista_relevante(l.get("name")):
                        list_ids.append(l.get("id"))
            # listas SOLTAS do space (sem pasta), ex.: "Demandas Agente" — se relevantes.
            # Essas tarefas casam com o cliente pelo NOME no título (feito no front).
            try:
                for l in f_lists.result():
                    if _lista_relevante(l.get("name")):
                        list_ids.append(l.get("id"))
            except Exception:
                pass
        if not list_ids:
            _cache_set(ck, ([], meta))
            return [], meta
        params = "".join("&list_ids[]=%s" % urlparse.quote(str(li)) for li in list_ids)
        result = (self._paginar_team_tasks(token, team_id, params), meta)
        _cache_set(ck, result)
        return result

    def _clickup_user_tasks(self, token, space_id, assignee_id):
        """TODAS as tarefas (qualquer lista) atribuídas a um usuário no space."""
        team_id = self._team_do_space(token, space_id)
        if not team_id:
            return []
        params = "&space_ids[]=%s&assignees[]=%s" % (urlparse.quote(str(space_id)), urlparse.quote(str(assignee_id)))
        return self._paginar_team_tasks(token, team_id, params)

    def _inspect_space(self, tasks):
        clientes, listas, status = {}, {}, {}
        for t in tasks:
            if t.get("folderName") and not t.get("folderHidden"):
                clientes[t["folderName"]] = clientes.get(t["folderName"], 0) + 1
            ln = t.get("listName")
            if ln:
                listas[ln] = listas.get(ln, 0) + 1
            sn = t.get("statusName")
            if sn:
                status[sn] = status.get(sn, 0) + 1
        amostra = [{
            "name": t.get("name"), "cliente": t.get("folderName"), "lista": t.get("listName"),
            "status": t.get("statusName"), "tipo": t.get("statusType"),
            "resp": t.get("assignees"), "due": t.get("due_date"),
        } for t in tasks[:12]]
        return {
            "total_tasks": len(tasks),
            "qtd_clientes": len(clientes),
            "clientes": clientes,
            "listas": listas,
            "status": status,
            "amostra": amostra,
        }

    def _log_spaces(self, squad, spaces):
        try:
            print("\n========== SPACES ClickUp [%s] — %d ==========" % (squad, len(spaces)))
            for s in spaces:
                print("   spaceId=%s  | %s   (%s)" % (s.get("id"), s.get("name"), s.get("team")))
            print("==============================================\n")
        except Exception as e:
            print("[spaces] falha ao logar:", e)

    def _log_space_tasks(self, squad, tasks):
        try:
            pastas = {}
            # distribuição de demandas por responsável (id|nome) — só "Demandas Novas"
            resp = {}
            for t in tasks:
                if t.get("folderName") and not t.get("folderHidden"):
                    pastas[t["folderName"]] = pastas.get(t["folderName"], 0) + 1
                if "demanda" in _norm(t.get("listName")):
                    ids = t.get("assigneesIds") or []
                    nomes = t.get("assignees") or []
                    for i in range(max(len(ids), len(nomes))):
                        chave = "%s|%s" % (ids[i] if i < len(ids) else "?", nomes[i] if i < len(nomes) else "?")
                        resp[chave] = resp.get(chave, 0) + 1
            print("[space-tasks %s] -> navegador: %d tarefas | clientes(pastas)=%s" % (squad, len(tasks), pastas))
            print("[space-tasks %s] demandas por responsável (id|nome): %s" % (squad, resp))
            # tarefas SOLTAS (sem pasta), ex.: "Demandas Agente" — casam pelo título
            soltas = [t for t in tasks if (not t.get("folderName") or t.get("folderHidden"))]
            listas_soltas = {}
            for t in soltas:
                ln = t.get("listName")
                listas_soltas[ln] = listas_soltas.get(ln, 0) + 1
            print("[space-tasks %s] tarefas SOLTAS: %d | listas: %s" % (squad, len(soltas), listas_soltas))
            for t in soltas[:25]:
                print("   solta: %r | lista=%s | status=%s" % (t.get("name"), t.get("listName"), t.get("statusName")))
        except Exception as e:
            print("[space-tasks] log falhou:", e)

    def _log_space_inspect(self, squad, space_id, resumo):
        try:
            print("\n===== SPACE-INSPECT [%s] space=%s =====" % (squad, space_id))
            print("tarefas=%d  clientes=%d" % (resumo["total_tasks"], resumo["qtd_clientes"]))
            print("listas:", resumo["listas"])
            print("status:", resumo["status"])
            print("clientes (nome -> nº tarefas):")
            for nome, n in resumo["clientes"].items():
                print("   - %s: %d" % (nome, n))
            print("amostra:")
            for s in resumo["amostra"]:
                print("   • %r | cliente=%s | lista=%s | status=%s(%s) | resp=%s | due=%s"
                      % (s["name"], s["cliente"], s["lista"], s["status"], s["tipo"], s["resp"], s["due"]))
            print("======================================\n")
        except Exception as e:
            print("[space-inspect] falha ao logar:", e)

    # silencia o log de favicon/204 ruidoso, mantém o resto
    def log_message(self, fmt, *args):
        msg = fmt % args
        if "favicon" in msg:
            return
        super().log_message("%s", msg)


def main():
    os.chdir(ROOT)
    # log na hora (sem buffer) para conseguir acompanhar inspect/spaces ao vivo
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except Exception:
        pass
    host = os.environ.get("HOST", "127.0.0.1")  # só loopback: não expor o proxy/segredos na LAN
    httpd = ThreadingHTTPServer((host, PORT), Handler)
    print("Fournier Dash em  http://localhost:%d" % PORT)
    print("Proxy ClickUp:    /api/clickup/<squad>/tasks  e  /api/clickup/<squad>/inspect")
    if not os.path.exists(CONFIG_PATH):
        print("AVISO: proxy.local.json nao encontrado — copie de proxy.local.json.example e preencha o token.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nencerrando…")
        httpd.server_close()


if __name__ == "__main__":
    main()
