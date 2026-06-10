// ============================================================
// TAXI-AV · Servidor principal — FASE 1 (Cimientos)
// Módulos incluidos en esta fase:
//   1. Conexión a PostgreSQL y creación automática de tablas
//   2. Registro / login de PASAJEROS
//   3. Registro / login de CONDUCTORES (con aprobación del admin)
//   4. Panel de ADMINISTRACIÓN (estadísticas, gestión de usuarios)
// Las tablas de viajes ya quedan creadas, listas para la Fase 2.
// ============================================================

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ------------------------------------------------------------
// 1. BASE DE DATOS
// DATABASE_URL se configura en Render (variable de entorno).
// Compatible con Neon, Supabase o PostgreSQL de Render.
// ------------------------------------------------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false }
});

async function inicializarBaseDeDatos() {
  // Pasajeros
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pasajeros (
      id SERIAL PRIMARY KEY,
      nombre TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      telefono TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      activo BOOLEAN DEFAULT TRUE,
      creado_en TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Conductores (estado: pendiente | aprobado | suspendido)
  // tipo: flota (vehículo de la empresa) | externo (conductor independiente)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conductores (
      id SERIAL PRIMARY KEY,
      nombre TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      telefono TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      vehiculo_marca TEXT,
      vehiculo_modelo TEXT,
      matricula TEXT,
      plazas INTEGER DEFAULT 4,
      isla TEXT DEFAULT 'Gran Canaria',
      tipo TEXT DEFAULT 'externo',
      estado TEXT DEFAULT 'pendiente',
      disponible BOOLEAN DEFAULT FALSE,
      creado_en TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Administradores
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admins (
      id SERIAL PRIMARY KEY,
      nombre TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      creado_en TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Viajes — esqueleto listo para la Fase 2 (no se usa todavía)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS viajes (
      id SERIAL PRIMARY KEY,
      pasajero_id INTEGER REFERENCES pasajeros(id),
      conductor_id INTEGER REFERENCES conductores(id),
      origen_direccion TEXT,
      origen_lat DOUBLE PRECISION,
      origen_lng DOUBLE PRECISION,
      destino_direccion TEXT,
      destino_lat DOUBLE PRECISION,
      destino_lng DOUBLE PRECISION,
      estado TEXT DEFAULT 'solicitado',
      precio_estimado NUMERIC(8,2),
      precio_final NUMERIC(8,2),
      solicitado_en TIMESTAMPTZ DEFAULT NOW(),
      finalizado_en TIMESTAMPTZ
    );
  `);

  // Crear el primer administrador si no existe ninguno.
  // Se define con las variables de entorno ADMIN_EMAIL y ADMIN_PASSWORD en Render.
  const { rows } = await pool.query('SELECT COUNT(*)::int AS total FROM admins');
  if (rows[0].total === 0) {
    const email = process.env.ADMIN_EMAIL || 'admin@taxi-av.com';
    const password = process.env.ADMIN_PASSWORD || 'cambiar-esta-clave';
    const hash = await bcrypt.hash(password, 10);
    await pool.query(
      'INSERT INTO admins (nombre, email, password_hash) VALUES ($1, $2, $3)',
      ['Administrador', email, hash]
    );
    console.log(`Primer administrador creado: ${email}`);
  }

  console.log('Base de datos lista.');
}

// ------------------------------------------------------------
// 2. CONFIGURACIÓN GENERAL
// ------------------------------------------------------------
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.set('trust proxy', 1); // necesario en Render para cookies seguras

app.use(session({
  secret: process.env.SESSION_SECRET || 'taxi-av-secreto-desarrollo',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 7 // 7 días
  }
}));

// Middleware de protección por rol
function requierePasajero(req, res, next) {
  if (req.session.rol === 'pasajero' && req.session.usuarioId) return next();
  res.status(401).json({ error: 'Debes iniciar sesión como pasajero.' });
}
function requiereConductor(req, res, next) {
  if (req.session.rol === 'conductor' && req.session.usuarioId) return next();
  res.status(401).json({ error: 'Debes iniciar sesión como conductor.' });
}
function requiereAdmin(req, res, next) {
  if (req.session.rol === 'admin' && req.session.usuarioId) return next();
  res.status(401).json({ error: 'Acceso restringido a administradores.' });
}

// Validación básica de email y campos
function emailValido(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ------------------------------------------------------------
// 3. RUTAS DE PASAJEROS
// ------------------------------------------------------------
app.post('/api/pasajero/registro', async (req, res) => {
  try {
    const { nombre, email, telefono, password } = req.body;
    if (!nombre || !emailValido(email) || !telefono || !password || password.length < 6) {
      return res.status(400).json({ error: 'Revisa los datos: todos los campos son obligatorios y la contraseña debe tener al menos 6 caracteres.' });
    }
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO pasajeros (nombre, email, telefono, password_hash)
       VALUES ($1, $2, $3, $4) RETURNING id, nombre, email`,
      [nombre.trim(), email.toLowerCase().trim(), telefono.trim(), hash]
    );
    req.session.usuarioId = rows[0].id;
    req.session.rol = 'pasajero';
    res.json({ ok: true, usuario: rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Ya existe una cuenta con ese email.' });
    }
    console.error(err);
    res.status(500).json({ error: 'Error del servidor al registrar.' });
  }
});

app.post('/api/pasajero/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const { rows } = await pool.query(
      'SELECT * FROM pasajeros WHERE email = $1',
      [(email || '').toLowerCase().trim()]
    );
    if (rows.length === 0 || !(await bcrypt.compare(password || '', rows[0].password_hash))) {
      return res.status(401).json({ error: 'Email o contraseña incorrectos.' });
    }
    if (!rows[0].activo) {
      return res.status(403).json({ error: 'Tu cuenta está desactivada. Contacta con soporte.' });
    }
    req.session.usuarioId = rows[0].id;
    req.session.rol = 'pasajero';
    res.json({ ok: true, usuario: { id: rows[0].id, nombre: rows[0].nombre, email: rows[0].email } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error del servidor al iniciar sesión.' });
  }
});

app.get('/api/pasajero/me', requierePasajero, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, nombre, email, telefono, creado_en FROM pasajeros WHERE id = $1',
    [req.session.usuarioId]
  );
  res.json({ usuario: rows[0] });
});

// ------------------------------------------------------------
// 4. RUTAS DE CONDUCTORES
// ------------------------------------------------------------
app.post('/api/conductor/registro', async (req, res) => {
  try {
    const { nombre, email, telefono, password, vehiculo_marca, vehiculo_modelo, matricula, plazas, isla } = req.body;
    if (!nombre || !emailValido(email) || !telefono || !password || password.length < 6) {
      return res.status(400).json({ error: 'Revisa los datos: nombre, email, teléfono y contraseña (mínimo 6 caracteres) son obligatorios.' });
    }
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO conductores (nombre, email, telefono, password_hash, vehiculo_marca, vehiculo_modelo, matricula, plazas, isla)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, nombre, email, estado`,
      [
        nombre.trim(),
        email.toLowerCase().trim(),
        telefono.trim(),
        hash,
        (vehiculo_marca || '').trim(),
        (vehiculo_modelo || '').trim(),
        (matricula || '').trim().toUpperCase(),
        parseInt(plazas, 10) || 4,
        isla || 'Gran Canaria'
      ]
    );
    req.session.usuarioId = rows[0].id;
    req.session.rol = 'conductor';
    res.json({ ok: true, conductor: rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Ya existe un conductor con ese email.' });
    }
    console.error(err);
    res.status(500).json({ error: 'Error del servidor al registrar.' });
  }
});

app.post('/api/conductor/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const { rows } = await pool.query(
      'SELECT * FROM conductores WHERE email = $1',
      [(email || '').toLowerCase().trim()]
    );
    if (rows.length === 0 || !(await bcrypt.compare(password || '', rows[0].password_hash))) {
      return res.status(401).json({ error: 'Email o contraseña incorrectos.' });
    }
    if (rows[0].estado === 'suspendido') {
      return res.status(403).json({ error: 'Tu cuenta está suspendida. Contacta con la administración.' });
    }
    req.session.usuarioId = rows[0].id;
    req.session.rol = 'conductor';
    res.json({
      ok: true,
      conductor: { id: rows[0].id, nombre: rows[0].nombre, email: rows[0].email, estado: rows[0].estado }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error del servidor al iniciar sesión.' });
  }
});

app.get('/api/conductor/me', requiereConductor, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, nombre, email, telefono, vehiculo_marca, vehiculo_modelo, matricula, plazas, isla, tipo, estado, disponible, creado_en
     FROM conductores WHERE id = $1`,
    [req.session.usuarioId]
  );
  res.json({ conductor: rows[0] });
});

// ------------------------------------------------------------
// 5. RUTAS DE ADMINISTRACIÓN
// ------------------------------------------------------------
app.post('/api/admin/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const { rows } = await pool.query(
      'SELECT * FROM admins WHERE email = $1',
      [(email || '').toLowerCase().trim()]
    );
    if (rows.length === 0 || !(await bcrypt.compare(password || '', rows[0].password_hash))) {
      return res.status(401).json({ error: 'Credenciales incorrectas.' });
    }
    req.session.usuarioId = rows[0].id;
    req.session.rol = 'admin';
    res.json({ ok: true, admin: { id: rows[0].id, nombre: rows[0].nombre, email: rows[0].email } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error del servidor.' });
  }
});

app.get('/api/admin/resumen', requiereAdmin, async (req, res) => {
  const pasajeros = await pool.query('SELECT COUNT(*)::int AS total FROM pasajeros');
  const conductores = await pool.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE estado = 'pendiente')::int AS pendientes,
      COUNT(*) FILTER (WHERE estado = 'aprobado')::int AS aprobados,
      COUNT(*) FILTER (WHERE estado = 'suspendido')::int AS suspendidos
    FROM conductores
  `);
  const viajes = await pool.query('SELECT COUNT(*)::int AS total FROM viajes');
  res.json({
    pasajeros: pasajeros.rows[0].total,
    conductores: conductores.rows[0],
    viajes: viajes.rows[0].total
  });
});

app.get('/api/admin/conductores', requiereAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, nombre, email, telefono, vehiculo_marca, vehiculo_modelo, matricula, plazas, isla, tipo, estado, creado_en
     FROM conductores ORDER BY creado_en DESC`
  );
  res.json({ conductores: rows });
});

app.post('/api/admin/conductores/:id/estado', requiereAdmin, async (req, res) => {
  const { estado } = req.body;
  if (!['pendiente', 'aprobado', 'suspendido'].includes(estado)) {
    return res.status(400).json({ error: 'Estado no válido.' });
  }
  await pool.query('UPDATE conductores SET estado = $1 WHERE id = $2', [estado, req.params.id]);
  res.json({ ok: true });
});

app.post('/api/admin/conductores/:id/tipo', requiereAdmin, async (req, res) => {
  const { tipo } = req.body;
  if (!['flota', 'externo'].includes(tipo)) {
    return res.status(400).json({ error: 'Tipo no válido.' });
  }
  await pool.query('UPDATE conductores SET tipo = $1 WHERE id = $2', [tipo, req.params.id]);
  res.json({ ok: true });
});

app.get('/api/admin/pasajeros', requiereAdmin, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, nombre, email, telefono, activo, creado_en FROM pasajeros ORDER BY creado_en DESC'
  );
  res.json({ pasajeros: rows });
});

app.post('/api/admin/pasajeros/:id/activo', requiereAdmin, async (req, res) => {
  await pool.query('UPDATE pasajeros SET activo = $1 WHERE id = $2', [!!req.body.activo, req.params.id]);
  res.json({ ok: true });
});

// ------------------------------------------------------------
// 6. SESIÓN (común a todos los roles)
// ------------------------------------------------------------
app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/sesion', (req, res) => {
  if (!req.session.usuarioId) return res.json({ rol: null });
  res.json({ rol: req.session.rol });
});

// ------------------------------------------------------------
// 7. ARRANQUE
// ------------------------------------------------------------
inicializarBaseDeDatos()
  .then(() => {
    app.listen(PORT, () => console.log(`Taxi-AV escuchando en el puerto ${PORT}`));
  })
  .catch((err) => {
    console.error('No se pudo inicializar la base de datos:', err);
    process.exit(1);
  });
