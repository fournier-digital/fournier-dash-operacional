/* ==========================================================================
 * CLIENTE SUPABASE — armazenagem compartilhada (cross-device) do dashboard.
 *
 * A URL e a PUBLISHABLE KEY são PÚBLICAS por design (o RLS protege o acesso);
 * podem ficar no front. NENHUM segredo (token do ClickUp, API key Google) mora
 * aqui — esses continuam server-side. Depende do UMD @supabase/supabase-js,
 * carregado ANTES deste script (window.supabase.createClient).
 * ========================================================================== */
(function () {
  const FD = (window.FD = window.FD || {});
  FD.SUPABASE_URL = "https://gcxqzujcuhzwzayrrmsp.supabase.co";
  FD.SUPABASE_KEY = "sb_publishable_gDz1i9Fwp3mcbEKlSiLz9Q_RWTDml-p";
  try {
    FD.supabase = (window.supabase && window.supabase.createClient)
      ? window.supabase.createClient(FD.SUPABASE_URL, FD.SUPABASE_KEY, { auth: { persistSession: false } })
      : null;
    if (!FD.supabase) console.warn("[supabase] UMD não carregou — dashboard segue no fallback local.");
  } catch (e) {
    FD.supabase = null;
    console.warn("[supabase] client não criado:", e && e.message);
  }
})();
