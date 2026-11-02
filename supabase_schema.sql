-- Ejecuta este SQL en el Editor SQL de tu proyecto Supabase (https://aojlwavrjxxpzupwchxr.supabase.co)
-- para habilitar el guardado en la nube en tiempo real para Análisis Séneca CF:

CREATE TABLE IF NOT EXISTS public.seneca_projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  rival TEXT DEFAULT '',
  competition TEXT DEFAULT '',
  match_date DATE DEFAULT CURRENT_DATE,
  active_module TEXT DEFAULT 'con_video',
  events JSONB DEFAULT '[]'::jsonb,
  captures JSONB DEFAULT '[]'::jsonb,
  drawings JSONB DEFAULT '[]'::jsonb,
  markers JSONB DEFAULT '{}'::jsonb,
  tag_categories JSONB DEFAULT '[]'::jsonb,
  playlists JSONB DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.seneca_projects ADD COLUMN IF NOT EXISTS rival TEXT DEFAULT '';
ALTER TABLE public.seneca_projects ADD COLUMN IF NOT EXISTS competition TEXT DEFAULT '';
ALTER TABLE public.seneca_projects ADD COLUMN IF NOT EXISTS match_date DATE DEFAULT CURRENT_DATE;
ALTER TABLE public.seneca_projects ADD COLUMN IF NOT EXISTS active_module TEXT DEFAULT 'con_video';
ALTER TABLE public.seneca_projects ADD COLUMN IF NOT EXISTS events JSONB DEFAULT '[]'::jsonb;
ALTER TABLE public.seneca_projects ADD COLUMN IF NOT EXISTS captures JSONB DEFAULT '[]'::jsonb;
ALTER TABLE public.seneca_projects ADD COLUMN IF NOT EXISTS drawings JSONB DEFAULT '[]'::jsonb;
ALTER TABLE public.seneca_projects ADD COLUMN IF NOT EXISTS markers JSONB DEFAULT '{}'::jsonb;
ALTER TABLE public.seneca_projects ADD COLUMN IF NOT EXISTS tag_categories JSONB DEFAULT '[]'::jsonb;
ALTER TABLE public.seneca_projects ADD COLUMN IF NOT EXISTS playlists JSONB DEFAULT '[]'::jsonb;

ALTER TABLE public.seneca_projects ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Acceso total Seneca CF" ON public.seneca_projects;
DROP POLICY IF EXISTS "Acceso total para Analisis Seneca CF" ON public.seneca_projects;
CREATE POLICY "Acceso total para Analisis Seneca CF"
  ON public.seneca_projects
  FOR ALL
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);
