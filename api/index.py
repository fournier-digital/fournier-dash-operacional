# -*- coding: utf-8 -*-
"""
==============================================================================
Fournier Dash — PROXY de integrações como função serverless (Vercel).

Porta o server.py (proxy local) para uma Vercel Python Function. O front-end
continua chamando /api/clickup|gcal|nps|sheet/... — o vercel.json reescreve
TODAS essas rotas para esta função (passando o caminho em ?__route=...), que
injeta o token/links vindos do NAVEGADOR (header X-CU-Token / query ?url=) e
fala com ClickUp/Google resolvendo CORS.

SEM estado em disco e SEM segredos no servidor: a configuração das Integrações
fica no navegador de cada usuário (localStorage), igual ao modo local. Por isso
o token vem no header e os links das planilhas na query — nada de env vars
obrigatórias (CLICKUP_TOKEN/GCAL_KEY existem só como fallback opcional).

Formato exigido pela Vercel: uma classe `handler(BaseHTTPRequestHandler)`.
Só usa a biblioteca padrão (sem requirements).
==============================================================================
"""
import csv
import datetime
import io
import json
import os
import re
import threading
import time
import unicodedata
from http.server import BaseHTTPRequestHandler
from urllib import request as urlrequest, error as urlerror, parse as urlparse

CLICKUP_BASE = "https://api.clickup.com/api/v2"
GCAL_BASE = "https://www.googleapis.com/calendar/v3"
_TEAM_BY_SPACE = {}  # cache: space_id -> team_id (persiste enquanto a instância está quente)

# Cache de payloads de upstream — ajuda em invocações "quentes" (some no cold start).
_TTL = 45
_CACHE = {}
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
    s = (s or "").lower()
    return "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn")


def _lista_relevante(nome):
    n = _norm(nome)
    return ("demanda" in n) or ("onboarding" in n) or ("criativo" in n) or ("entregav" in n)


class handler(BaseHTTPRequestHandler):
    # ---- util ----------------------------------------------------------
    def _send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        # Não cachear as respostas de API (o dado da planilha/ClickUp muda).
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()

    def log_message(self, fmt, *args):  # silencia o log padrão (Vercel já registra)
        return

    # A rota real vem em ?__route=clickup/azul/space-tasks (reescrita do vercel.json).
    # Fallback: usa o próprio path, tirando o prefixo /api/.
    def _route_and_qs(self):
        parsed = urlparse.urlparse(self.path)
        qs = urlparse.parse_qs(parsed.query)
        route = (qs.get("__route", [None])[0])
        if route is None:
            route = parsed.path
            if route.startswith("/api/"):
                route = route[len("/api/"):]
        return route.strip("/"), qs

    def do_GET(self):
        route, qs = self._route_and_qs()
        parts = [p for p in route.split("/") if p]  # ex.: [clickup, azul, space-tasks]
        familia = parts[0] if parts else ""
        if familia == "clickup":
            return self.handle_clickup(parts, qs)
        if familia == "gcal":
            return self.handle_gcal(parts, qs)
        if familia == "nps":
            return self.handle_nps(parts, qs)
        if familia == "sheet":
            return self.handle_sheet(parts, qs)
        return self._send_json(404, {"error": "rota /api desconhecida"})

    # ---- Planilha genérica (Controle/Onboarding) -----------------------
    def handle_sheet(self, parts, qs):
        link = (qs.get("url", [None])[0])
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
    def handle_clickup(self, parts, qs):
        if len(parts) < 3:
            return self._send_json(400, {"error": "rota inválida. Use /api/clickup/<squad>/<acao>"})
        acao = parts[2]
        # Token: header X-CU-Token (navegador) ou env CLICKUP_TOKEN (fallback opcional).
        token = self.headers.get("X-CU-Token") or os.environ.get("CLICKUP_TOKEN")
        space_id = (qs.get("spaceId", [None])[0])
        if not token:
            return self._send_json(401, {
                "error": "sem token do ClickUp",
                "dica": "preencha o API Token na aba Integrações",
            })

        if acao == "spaces":
            try:
                spaces = self._clickup_spaces(token)
            except urlerror.HTTPError as e:
                return self._send_json(e.code, {"error": "ClickUp respondeu HTTP %s" % e.code, "detalhe": e.read().decode("utf-8", "ignore")[:600]})
            except Exception as e:
                return self._send_json(502, {"error": "falha ao listar os spaces", "detalhe": str(e)})
            return self._send_json(200, {"spaces": spaces})

        if acao in ("space-tasks", "space-inspect"):
            if not space_id:
                return self._send_json(400, {"error": "sem spaceId", "dica": "use 'Listar meus spaces' e clique no Space do squad"})
            try:
                tasks, folders_meta = self._clickup_space_tasks(token, space_id)
            except urlerror.HTTPError as e:
                return self._send_json(e.code, {"error": "ClickUp respondeu HTTP %s" % e.code, "detalhe": e.read().decode("utf-8", "ignore")[:600]})
            except Exception as e:
                return self._send_json(502, {"error": "falha ao puxar tarefas do space", "detalhe": str(e)})
            if acao == "space-inspect":
                return self._send_json(200, self._inspect_space(tasks))
            enxuto = [t for t in tasks if _lista_relevante(t.get("listName"))]
            return self._send_json(200, {"tasks": enxuto, "folders": folders_meta})

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
            return self._send_json(200, {"tasks": tasks})

        return self._send_json(404, {"error": "ação desconhecida: %s" % acao})

    # ---- Google Agenda -------------------------------------------------
    def handle_gcal(self, parts, qs):
        if len(parts) < 3:
            return self._send_json(400, {"error": "rota inválida. Use /api/gcal/<squad>/events|inspect"})
        acao = parts[2]
        api_key = self.headers.get("X-GC-Key") or os.environ.get("GCAL_KEY")
        calendar_id = (qs.get("calendarId", [None])[0])
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
            return self._send_json(200, self._inspect_gcal(eventos))
        return self._send_json(200, {"events": eventos})

    # ---- NPS (planilha Google via CSV público) -------------------------
    def handle_nps(self, parts, qs):
        if len(parts) < 3:
            return self._send_json(400, {"error": "rota inválida. Use /api/nps/<squad>/externa|interna"})
        link = (qs.get("url", [None])[0])
        sheet = qs.get("sheet", [None])[0]  # aba por NOME (ex.: "Julho de 2027")
        if not link:
            return self._send_json(400, {"error": "sem link da planilha", "dica": "preencha o link da NPS na aba Integrações"})
        try:
            headers, rows = self._sheet_csv(link, sheet)
        except ValueError as e:
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
        return self._send_json(200, {"headers": headers, "rows": rows, "total": len(rows)})

    # ---- leitura de planilha (Google Sheets -> CSV) --------------------
    def _get_text(self, url):
        req = urlrequest.Request(url, headers={"Accept": "text/csv,*/*"})
        with urlrequest.urlopen(req, timeout=30) as r:
            return r.read().decode("utf-8-sig", "ignore")  # -sig remove o BOM

    def _sheet_csv(self, link, sheet=None):
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
        ck = ("sheet", url)
        cached = _cache_get(ck)
        if cached is not None:
            if cached == "__ERR__":
                raise ValueError("aba não encontrada" if sheet else "a planilha não está compartilhada — use 'Qualquer pessoa com o link pode ver'")
            return cached[0], cached[1]
        raw = self._get_text(url)
        if raw.lstrip()[:1] == "<":
            _cache_set(ck, "__ERR__")
            raise ValueError("aba não encontrada" if sheet else "a planilha não está compartilhada — use 'Qualquer pessoa com o link pode ver'")
        all_rows = list(csv.reader(io.StringIO(raw)))
        result = ([], []) if not all_rows else (all_rows[0], all_rows[1:])
        _cache_set(ck, result)
        return result

    # ---- ClickUp (modelo por SPACE) ------------------------------------
    def _cu_get(self, token, url):
        req = urlrequest.Request(url, headers={"Authorization": token, "Content-Type": "application/json"})
        with urlrequest.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode("utf-8"))

    def _clickup_spaces(self, token):
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
            if len(lote) < 100 or page > 120:
                break
            page += 1
        return out

    def _clickup_space_tasks(self, token, space_id):
        ck = ("cu-space", str(space_id))
        cached = _cache_get(ck)
        if cached is not None:
            return cached
        team_id = self._team_do_space(token, space_id)
        if not team_id:
            return [], {}
        list_ids = []
        meta = {}
        for fo in self._folders_do_space(token, space_id):
            if fo.get("id") is not None:
                meta[str(fo.get("id"))] = fo.get("date_created")
            for l in (fo.get("lists") or []):
                if _lista_relevante(l.get("name")):
                    list_ids.append(l.get("id"))
        try:
            for l in (self._cu_get(token, "%s/space/%s/list?archived=false" % (CLICKUP_BASE, urlparse.quote(str(space_id)))) or {}).get("lists", []) or []:
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

    # ---- Google Agenda -------------------------------------------------
    def _gcal_get(self, url):
        req = urlrequest.Request(url, headers={"Accept": "application/json"})
        with urlrequest.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode("utf-8"))

    def _gcal_events(self, api_key, calendar_id):
        ck = ("gcal", str(calendar_id))
        cached = _cache_get(ck)
        if cached is not None:
            return cached
        now = datetime.datetime.utcnow()
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
