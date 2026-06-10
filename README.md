# Taxi-AV — Fase 1 (Cimientos)

Aplicación de taxi para Canarias. Esta fase incluye:

- Registro e inicio de sesión de **pasajeros**;
- Registro e inicio de sesión de **conductores** (con aprobación previa del administrador);
- **Panel de administración**: resumen con cifras, aprobación/suspensión de conductores, clasificación flota propia/externo, activación/desactivación de pasajeros;
- Base de datos PostgreSQL con las tablas de viajes ya preparadas para la Fase 2.

## Archivos del proyecto

```
taxi-av/
├── server.js              → servidor y API (Node.js + Express + PostgreSQL)
├── package.json           → dependencias
└── public/
    ├── estilos.css        → estilos compartidos
    ├── index.html         → página de inicio
    ├── pasajero.html      → área del pasajero
    ├── conductor.html     → área del conductor
    └── admin.html         → panel de administración
```

## Despliegue paso a paso

### Paso 1 — Crear el repositorio en GitHub

1. Entra en GitHub y crea un repositorio nuevo llamado `taxi-av`.
2. Sube todos los archivos de este proyecto **respetando la estructura de carpetas** (la carpeta `public` con sus 5 archivos dentro).

### Paso 2 — Crear la base de datos gratuita en Neon

Usamos Neon porque su plan gratuito no caduca (la base de datos gratuita de Render se borra a los 30 días).

1. Entra en https://neon.tech y crea una cuenta (puedes usar tu cuenta de GitHub).
2. Crea un proyecto nuevo; nombre sugerido: `taxi-av`. Región: Europe (Frankfurt o la más cercana).
3. Cuando termine, Neon te mostrará una **cadena de conexión** que empieza por `postgresql://...`. Cópiala completa: es tu `DATABASE_URL`.

### Paso 3 — Crear el servicio en Render

1. En Render, pulsa **New → Web Service** y conecta el repositorio `taxi-av`.
2. Configuración:
   - **Build Command:** `npm install`;
   - **Start Command:** `npm start`;
   - **Instance Type:** Free.
3. En **Environment Variables**, añade estas cuatro variables:

| Variable | Valor |
|---|---|
| `DATABASE_URL` | la cadena de conexión copiada de Neon |
| `SESSION_SECRET` | una frase larga inventada por ti (ejemplo: `playa-de-las-canteras-2026-taxi`) |
| `ADMIN_EMAIL` | tu email de administrador |
| `ADMIN_PASSWORD` | tu contraseña de administrador (mínimo 10 caracteres) |

4. Pulsa **Create Web Service** y espera a que el despliegue termine.

### Paso 4 — Probar

1. Abre la URL que te da Render (por ejemplo `https://taxi-av.onrender.com`).
2. Entra en **Administración** con el email y contraseña que pusiste en las variables.
3. Crea una cuenta de prueba como pasajero y otra como conductor.
4. Vuelve al panel de administración y aprueba al conductor de prueba.

Si todo eso funciona, la Fase 1 está completa y pasamos a la Fase 2 (solicitud de viaje con mapa y asignación de conductor).

## Notas importantes

- El primer administrador se crea automáticamente al arrancar el servidor por primera vez, usando `ADMIN_EMAIL` y `ADMIN_PASSWORD`. Si cambias esas variables después, el administrador **no** cambia (ya está guardado en la base de datos).
- Las contraseñas se guardan cifradas (bcrypt); nadie puede leerlas, ni siquiera el administrador.
- En el plan gratuito de Render, el servidor "se duerme" tras unos minutos sin uso y tarda ~1 minuto en despertar. Para una app de taxi en producción real habrá que pasar al plan de pago, pero para construir y probar es perfecto.
