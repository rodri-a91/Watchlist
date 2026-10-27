# Watchlist

Lista unificada de películas y series pendientes entre todas tus plataformas de streaming.

## Stack

- HTML + CSS + JavaScript vanilla (ES modules)
- [Supabase](https://supabase.com) — base de datos PostgreSQL en la nube
- [TMDB](https://www.themoviedb.org/) — API de metadatos de pelis y series

## Setup (una sola vez)

### 1. Crear el proyecto en Supabase

1. Entra en [supabase.com](https://supabase.com) y crea una cuenta.
2. Crea un nuevo proyecto (elige una región cercana, ej. Frankfurt).
3. Cuando termine de aprovisionar, ve a **SQL Editor → New query** y pega:

```sql
CREATE TABLE watchlist_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  tmdb_id int NOT NULL,
  type text NOT NULL CHECK (type IN ('movie', 'tv')),
  title text NOT NULL,
  poster_path text,
  year int NOT NULL,
  platforms text[] NOT NULL DEFAULT '{}'
    CHECK (platforms <@ ARRAY['netflix','hbo','disney','apple','skyshowtime','prime','movistar','plex','filmin']::text[]),
  genres text[] NOT NULL DEFAULT '{}'
    CHECK (genres <@ ARRAY['Acción','Animación','Aventura','Bélica','Ciencia ficción','Comedia','Crimen','Documental','Drama','Familia','Fantasía','Historia','Misterio','Música','Romance','Suspense','Terror','Western']::text[]),
  season_number int,
  duration_minutes int,
  episode_count int,
  rating numeric(3,1),
  watched boolean NOT NULL DEFAULT false,
  added_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT watchlist_items_uniqueness UNIQUE NULLS NOT DISTINCT (user_id, tmdb_id, type, season_number),
  CONSTRAINT season_only_for_tv CHECK (type = 'tv' OR season_number IS NULL)
);

ALTER TABLE watchlist_items ENABLE ROW LEVEL SECURITY;

-- Cada usuario solo ve y modifica sus propias filas
CREATE POLICY "own_items"
  ON watchlist_items
  FOR ALL
  TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

-- Series que sigues en la pestaña "Próximos" (independiente de la watchlist)
CREATE TABLE followed_shows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  tmdb_id int NOT NULL,
  title text NOT NULL,
  poster_path text,
  platforms text[] NOT NULL DEFAULT '{}'
    CHECK (platforms <@ ARRAY['netflix','hbo','disney','apple','skyshowtime','prime','movistar','plex','filmin']::text[]),
  seen_season int,   -- puntero "voy por"; null = sin puntero
  seen_episode int,
  added_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT followed_shows_uniqueness UNIQUE (user_id, tmdb_id),
  CONSTRAINT seen_pointer_complete CHECK ((seen_season IS NULL) = (seen_episode IS NULL))
);

ALTER TABLE followed_shows ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own_follows"
  ON followed_shows
  FOR ALL
  TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);
```

Pulsa **Run**. Si todo ha ido bien, verás las tablas en **Table Editor**.
### 2. Crear tu usuario en Supabase

1. En el menú izquierdo, ve a **Authentication → Users → Add user → Create new user**.
2. Introduce tu email y una contraseña fuerte. Marca **Auto Confirm User** para no tener que verificar por email.
3. Pulsa **Create user**.

### 3. Desactivar el registro de nuevos usuarios

Para que nadie más pueda crearse una cuenta en tu app:

1. Ve a **Authentication → Sign In / Providers → Email** (o **Authentication → Providers → Email** según versión).
2. Desactiva el toggle **Enable Sign-Ups** (o **Allow new users to sign up**).

### 4. Conseguir la API key de TMDB

1. Crea una cuenta en [themoviedb.org](https://www.themoviedb.org/).
2. Ve a **Settings → API** y solicita una API key (opción Developer, gratis).
3. Copia el valor de **API Key (v3 auth)**.

### 5. Configurar el proyecto

Abre `config.js` y pon tus valores reales. El archivo se sube al repo a propósito, porque Vercel lo sirve tal cual y no hay paso de build:

- `SUPABASE_URL` y `SUPABASE_ANON_KEY` los encuentras en Supabase → **Project Settings → API**
- `TMDB_API_KEY` es la que acabas de copiar

## Próximos (series que sigues)

La pestaña **Próximos** es una lista aparte de series seguidas, con la agenda de capítulos y estrenos sacada de TMDB:

- **Seguir una serie**: con la pestaña Próximos abierta, el buscador solo muestra series y al pulsar una la sigues. También desde la ficha de una serie de tu lista (**+ Seguir en Próximos**).
- **Agenda**: lanzamientos de los últimos 7 días y los que vienen, agrupados (Hoy, Mañana, Esta semana, Más adelante). Una temporada que sale entera el mismo día (Netflix y similares) aparece como un único bloque. Debajo, un resumen por serie: en emisión, próximos estrenos, renovadas sin fecha y finalizadas.
- **Calendario**: vista mensual. En el móvil las celdas solo llevan puntos y, al tocar un día, sus lanzamientos salen debajo.
- **Voy por**: en la ficha de la serie, pulsa el último capítulo que has visto. La app solo lo usa para decirte si vas al día o cuántos te faltan; no lleva el seguimiento capítulo a capítulo.

Los datos de TMDB se guardan 12 horas en el navegador (`localStorage`). El botón **Actualizar** fuerza la recarga.

**Limitación conocida**: TMDB da el día de emisión pero no la hora. Una serie de EE. UU. que se emite de noche allí aparece un día antes de cuando se puede ver en España.

## Tests

La lógica de fechas y calendario (`schedule.js`) tiene tests sin dependencias:

```
node --test
```

## Ejecutar en local

Como el proyecto usa ES modules, no puedes abrir `index.html` con doble clic directamente — necesitas un servidor local. Opciones:

- **VS Code**: instala la extensión "Live Server" y haz clic derecho → Open with Live Server.
- **Python**: en la carpeta del proyecto, `python -m http.server` y abre `http://localhost:8000`.
- **Node**: `npx serve` en la carpeta del proyecto.

## Desplegar online (gratis)

### Opción A — Vercel (recomendado)

1. Sube el proyecto a un repositorio de GitHub.
2. Entra en [vercel.com](https://vercel.com), conecta tu cuenta de GitHub.
3. Importa el repositorio. Vercel detectará que es estático y lo desplegará.
4. Cada `git push` actualiza automáticamente la versión en producción.

### Opción B — Netlify

Mismo flujo en [netlify.com](https://netlify.com).

## Sobre la seguridad

Este proyecto usa autenticación por email + contraseña gestionada por Supabase Auth. Solo el usuario que tú crees en Supabase puede acceder, y cada usuario solo ve sus propias filas (`user_id` + RLS). Las claves que viven en `config.js` son seguras de exponer en el frontend: la `SUPABASE_ANON_KEY` está diseñada para eso y, gracias a las políticas RLS, no permite leer ni escribir nada sin haber iniciado sesión. La `TMDB_API_KEY` tampoco es sensible.

La sesión se guarda en `localStorage` del navegador, así que solo necesitas hacer login una vez por dispositivo. Si quieres invalidar todas las sesiones, en Supabase puedes ir a **Authentication → Users**, abrir tu usuario y forzar logout.
