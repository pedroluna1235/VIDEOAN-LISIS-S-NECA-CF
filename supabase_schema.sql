-- Ejecuta este SQL en el Editor SQL de tu proyecto Supabase (https://aojlwavrjxxpzupwchxr.supabase.co)
-- para habilitar el guardado en la nube en tiempo real para Análisis Séneca CF:

CREATE TABLE IF NOT EXISTS public.seneca_projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  match_title TEXT DEFAULT 'Séneca CF vs Rival',
  updated_at TIMESTAMPTZ DEFAULT now(),
  markers JSONB DEFAULT '{}'::jsonb,
  categories JSONB DEFAULT '[]'::jsonb,
  clips JSONB DEFAULT '[]'::jsonb,
  drawings JSONB DEFAULT '[]'::jsonb,
  playlists JSONB DEFAULT '[]'::jsonb,
  notes TEXT DEFAULT ''
);

ALTER TABLE public.seneca_projects ADD COLUMN IF NOT EXISTS playlists JSONB DEFAULT '[]'::jsonb;

ALTER TABLE public.seneca_projects ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Acceso total Seneca CF" ON public.seneca_projects;
CREATE POLICY "Acceso total Seneca CF"
  ON public.seneca_projects
  FOR ALL
  USING (true)
  WITH CHECK (true);
