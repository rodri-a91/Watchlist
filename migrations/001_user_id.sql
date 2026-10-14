-- ==========================================
-- Migración 001: cada usuario solo ve su propia lista
-- ==========================================
--
-- Ejecutar UNA vez en Supabase -> SQL Editor -> New query -> Run.
-- Todo va en una transacción: si algo falla, no se aplica nada.
--
-- Requisito: que en Authentication -> Users haya exactamente UN usuario
-- (el dueño de las filas actuales). Si hay más, el UPDATE falla con
-- "more than one row returned by a subquery" y no se cambia nada.

BEGIN;

-- 1. Nueva columna. El DEFAULT hace que las inserciones desde la app
--    se asignen solas al usuario con sesión iniciada (app.js no cambia).
ALTER TABLE watchlist_items
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE
  DEFAULT auth.uid();

-- 2. Asignar las filas existentes al único usuario.
UPDATE watchlist_items
  SET user_id = (SELECT id FROM auth.users)
  WHERE user_id IS NULL;

-- 3. Ya no puede haber filas sin dueño.
ALTER TABLE watchlist_items
  ALTER COLUMN user_id SET NOT NULL;

-- 4. Los duplicados se comprueban por usuario, no de forma global.
--    Se borran todas las restricciones UNIQUE existentes (sea cual sea su nombre;
--    la clave primaria no se toca) y se crea la nueva.
--    (Al empezar por user_id, este índice sirve también para filtrar por usuario.)
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.watchlist_items'::regclass AND contype = 'u'
  LOOP
    RAISE NOTICE 'Borrando restricción UNIQUE: %', c.conname;
    EXECUTE format('ALTER TABLE public.watchlist_items DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE watchlist_items
  ADD CONSTRAINT watchlist_items_uniqueness
  UNIQUE NULLS NOT DISTINCT (user_id, tmdb_id, type, season_number);

-- 5. Sustituir las políticas existentes por "solo lo tuyo".
--    Se borran TODAS (sea cual sea su nombre): las políticas permisivas se combinan
--    con OR, así que dejar una antigua tipo USING (true) anularía la nueva.
DO $$
DECLARE p record;
BEGIN
  FOR p IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'watchlist_items'
  LOOP
    RAISE NOTICE 'Borrando política: %', p.policyname;
    EXECUTE format('DROP POLICY %I ON public.watchlist_items', p.policyname);
  END LOOP;
END $$;
ALTER TABLE watchlist_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own_items"
  ON watchlist_items
  FOR ALL
  TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

COMMIT;

-- Comprobación (ejecutar después, por separado). Debe salir 0:
-- SELECT count(*) FROM watchlist_items WHERE user_id IS NULL;
