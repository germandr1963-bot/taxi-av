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
const pgSession = require('connect-pg-simple')(session);
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

  // Fase 2: distancia del viaje (se añade sin afectar a tablas ya creadas)
  await pool.query(`ALTER TABLE viajes ADD COLUMN IF NOT EXISTS distancia_km NUMERIC(6,2);`);

  // Fase 3: posición GPS en vivo del conductor + número de taxi + foto de carné
  await pool.query(`ALTER TABLE conductores ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION;`);
  await pool.query(`ALTER TABLE conductores ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION;`);
  await pool.query(`ALTER TABLE conductores ADD COLUMN IF NOT EXISTS posicion_en TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE conductores ADD COLUMN IF NOT EXISTS numero_taxi TEXT;`);
  await pool.query(`ALTER TABLE conductores ADD COLUMN IF NOT EXISTS foto TEXT;`);

  // Catálogo de categorías de vehículos (las 9 del PRD; solo las activas se ofrecen al alta)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS categorias_vehiculos (
      id SERIAL PRIMARY KEY,
      nombre TEXT UNIQUE NOT NULL,
      capacidad_pasajeros INTEGER NOT NULL,
      capacidad_maletas TEXT NOT NULL,
      limite_sillas INTEGER NOT NULL,
      descripcion TEXT,
      activa BOOLEAN DEFAULT FALSE
    );
  `);
  await pool.query(`
    INSERT INTO categorias_vehiculos (nombre, capacidad_pasajeros, capacidad_maletas, limite_sillas, descripcion, activa) VALUES
      ('Shuttle', 8, 'Variable', 4, 'Transporte compartido / transfer de aeropuertos.', FALSE),
      ('Económico', 4, '2 medianas', 1, 'Servicio básico, tarifas accesibles.', FALSE),
      ('Confort', 4, '3 grandes', 2, 'Sedán espacioso, mejor climatización.', TRUE),
      ('Confort +', 4, '3 grandes', 2, 'Vehículo Confort con prestaciones añadidas.', FALSE),
      ('Business', 4, '3 grandes', 2, 'Sedán ejecutivo (Mercedes Clase E o similar).', FALSE),
      ('Premier', 4, '4 grandes', 2, 'Alta gama premium para representación.', FALSE),
      ('Elite', 4, '4 grandes', 2, 'Lo más exclusivo de la flota.', FALSE),
      ('Minivan', 7, '6 grandes', 4, 'Monovolumen de gran capacidad para grupos y familias.', FALSE),
      ('Niños', 4, '3 grandes', 3, 'Vehículo pre-equipado con retención infantil.', FALSE)
    ON CONFLICT (nombre) DO NOTHING;
  `);

  // ------------------------------------------------------------
  // Extras del viaje (Entrega 2): catálogo gestionable desde el admin.
  // "incluido" = gratis (informativo); si no está incluido, se cobra "precio".
  // "todas_categorias" = se ofrece en cualquier vehículo; si es FALSE, solo en
  // las categorías listadas en extras_categorias.
  // ------------------------------------------------------------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS extras_viaje (
      id SERIAL PRIMARY KEY,
      nombre TEXT UNIQUE NOT NULL,
      incluido BOOLEAN DEFAULT TRUE,
      precio NUMERIC(6,2) DEFAULT 0,
      todas_categorias BOOLEAN DEFAULT TRUE,
      activo BOOLEAN DEFAULT TRUE,
      orden INTEGER DEFAULT 0
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS extras_categorias (
      extra_id INTEGER REFERENCES extras_viaje(id) ON DELETE CASCADE,
      categoria_id INTEGER REFERENCES categorias_vehiculos(id) ON DELETE CASCADE,
      PRIMARY KEY (extra_id, categoria_id)
    );
  `);
  await pool.query(`
    INSERT INTO extras_viaje (nombre, incluido, precio, todas_categorias, activo, orden) VALUES
      ('Llevo transporte de mascota', TRUE, 0, TRUE, TRUE, 10),
      ('Asiento de seguridad para niños', TRUE, 0, TRUE, TRUE, 20),
      ('Ayúdame a encontrar el automóvil', TRUE, 0, TRUE, TRUE, 30),
      ('Estoy en silla de ruedas', TRUE, 0, TRUE, TRUE, 40),
      ('Solo puedo comunicarme mediante texto', TRUE, 0, TRUE, TRUE, 50),
      ('Soy mudo, pero puedo oír', TRUE, 0, TRUE, TRUE, 60),
      ('Llevo perro guía', TRUE, 0, TRUE, TRUE, 70),
      ('Ski o snowboard', TRUE, 0, FALSE, TRUE, 80),
      ('Llevo bicicleta', TRUE, 0, FALSE, TRUE, 90)
    ON CONFLICT (nombre) DO NOTHING;
  `);
  // "Ski o snowboard" solo en Confort, "Llevo bicicleta" solo en Minivan
  await pool.query(`
    INSERT INTO extras_categorias (extra_id, categoria_id)
    SELECT e.id, c.id FROM extras_viaje e, categorias_vehiculos c
    WHERE e.nombre = 'Ski o snowboard' AND c.nombre = 'Confort'
    ON CONFLICT DO NOTHING;
  `);
  await pool.query(`
    INSERT INTO extras_categorias (extra_id, categoria_id)
    SELECT e.id, c.id FROM extras_viaje e, categorias_vehiculos c
    WHERE e.nombre = 'Llevo bicicleta' AND c.nombre = 'Minivan'
    ON CONFLICT DO NOTHING;
  `);

  // Catálogo de marcas y modelos (crece con las altas de los taxistas)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS marcas_vehiculos (
      id SERIAL PRIMARY KEY,
      nombre TEXT UNIQUE NOT NULL
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS modelos_vehiculos (
      id SERIAL PRIMARY KEY,
      marca_id INTEGER REFERENCES marcas_vehiculos(id),
      nombre TEXT NOT NULL,
      UNIQUE (marca_id, nombre)
    );
  `);
  const marcasSemilla = {
    'Toyota': ['Prius', 'Corolla', 'Camry', 'RAV4'],
    'Skoda': ['Octavia', 'Superb'],
    'Mercedes-Benz': ['Clase C', 'Clase E', 'Vito'],
    'Volkswagen': ['Passat', 'Touran', 'Caddy'],
    'Seat': ['León', 'Alhambra', 'Ateca'],
    'Ford': ['Mondeo', 'Galaxy', 'Tourneo'],
    'Peugeot': ['508', '5008', 'Rifter'],
    'Citroën': ['C5 X', 'Berlingo'],
    'Hyundai': ['Ioniq', 'Tucson'],
    'Kia': ['Niro', 'Ceed'],
    'Renault': ['Talisman', 'Espace'],
    'Dacia': ['Lodgy', 'Jogger'],
    'Tesla': ['Model 3', 'Model Y']
  };
  for (const [marca, modelos] of Object.entries(marcasSemilla)) {
    const m = await pool.query(
      `INSERT INTO marcas_vehiculos (nombre) VALUES ($1) ON CONFLICT (nombre) DO UPDATE SET nombre = $1 RETURNING id`,
      [marca]
    );
    for (const modelo of modelos) {
      await pool.query(
        `INSERT INTO modelos_vehiculos (marca_id, nombre) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [m.rows[0].id, modelo]
      );
    }
  }

  // Expediente completo del conductor (datos del PRD) + control de foto por el admin
  for (const columna of ['documento TEXT', 'direccion TEXT', 'cp TEXT', 'municipio TEXT',
                         'municipio_licencia TEXT', 'numero_licencia TEXT', 'central_flota TEXT',
                         'categoria_id INTEGER REFERENCES categorias_vehiculos(id)',
                         "foto_estado TEXT DEFAULT 'sin_foto'", 'foto_motivo TEXT']) {
    await pool.query(`ALTER TABLE conductores ADD COLUMN IF NOT EXISTS ${columna};`);
  }

  // Portal de servicios de la super-app (banners de la pantalla de inicio)
  // estado: 'inactivo' (oculto) | 'activo' (público) | 'interno' (solo lo ve el admin, para pruebas)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS servicios (
      id SERIAL PRIMARY KEY,
      nombre TEXT UNIQUE NOT NULL,
      posicion INTEGER NOT NULL DEFAULT 99,
      estado TEXT NOT NULL DEFAULT 'inactivo',
      creado_en TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`
    INSERT INTO servicios (nombre, posicion, estado) VALUES
      ('Alquiler de Taxi', 1, 'activo'),
      ('Envíos y Paquetería', 2, 'interno'),
      ('Comida a Domicilio', 3, 'interno'),
      ('Recados', 4, 'interno')
    ON CONFLICT (nombre) DO NOTHING;
  `);

  // Foto de cada categoría de vehículo (las sube el admin, no los taxistas)
  await pool.query(`ALTER TABLE categorias_vehiculos ADD COLUMN IF NOT EXISTS foto TEXT;`);
  await pool.query(`ALTER TABLE categorias_vehiculos ADD COLUMN IF NOT EXISTS disponible BOOLEAN DEFAULT FALSE;`);
  await pool.query(`ALTER TABLE categorias_vehiculos ADD COLUMN IF NOT EXISTS bajada_diurna NUMERIC(6,2) DEFAULT 0;`);
  await pool.query(`ALTER TABLE categorias_vehiculos ADD COLUMN IF NOT EXISTS bajada_nocturna NUMERIC(6,2) DEFAULT 0;`);
  // Tarificador provisional: la categoría Confort arranca con la tarifa oficial y disponible.
  // Solo se aplica si todavía está a 0, para no pisar cambios posteriores del admin.
  await pool.query(`
    UPDATE categorias_vehiculos SET bajada_diurna = 2.95, bajada_nocturna = 3.65, disponible = TRUE
    WHERE nombre = 'Confort' AND bajada_diurna = 0;
  `);
  await pool.query(`ALTER TABLE viajes ADD COLUMN IF NOT EXISTS categoria_id INTEGER REFERENCES categorias_vehiculos(id);`);
  await pool.query(`ALTER TABLE viajes ADD COLUMN IF NOT EXISTS extras JSONB DEFAULT '[]';`);
  await pool.query(`ALTER TABLE viajes ADD COLUMN IF NOT EXISTS instrucciones_conductor TEXT;`);

  // Mejoras en tabla pasajeros: apellido, foto, verificación email y teléfono
  await pool.query(`ALTER TABLE pasajeros ADD COLUMN IF NOT EXISTS apellido TEXT;`);
  await pool.query(`ALTER TABLE pasajeros ADD COLUMN IF NOT EXISTS foto TEXT;`);
  await pool.query(`ALTER TABLE pasajeros ADD COLUMN IF NOT EXISTS email_verificado BOOLEAN DEFAULT FALSE;`);
  await pool.query(`ALTER TABLE pasajeros ADD COLUMN IF NOT EXISTS telefono_verificado BOOLEAN DEFAULT FALSE;`);

  // Preferencias del pasajero (se configuran en el perfil, se aplican a todos los viajes)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS preferencias_pasajero (
      pasajero_id INTEGER PRIMARY KEY REFERENCES pasajeros(id) ON DELETE CASCADE,
      temperatura TEXT DEFAULT 'sin_preferencia',
      musica TEXT DEFAULT 'sin_preferencia',
      conversacion TEXT DEFAULT 'sin_preferencia',
      conduccion TEXT DEFAULT 'sin_preferencia',
      mareo BOOLEAN DEFAULT FALSE,
      ruta TEXT DEFAULT 'sin_preferencia',
      ayuda_equipaje BOOLEAN DEFAULT FALSE,
      tiempo_acomodarse BOOLEAN DEFAULT FALSE,
      actualizado_en TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`ALTER TABLE viajes ADD COLUMN IF NOT EXISTS pedido_para_nombre TEXT;`);
  await pool.query(`ALTER TABLE viajes ADD COLUMN IF NOT EXISTS pedido_para_telefono TEXT;`);

  // Interruptor del botón "Contactar al chofer" (por conductor, gestionado por el admin)
  await pool.query(`ALTER TABLE conductores ADD COLUMN IF NOT EXISTS permite_contacto BOOLEAN DEFAULT TRUE;`);

  // Cancelaciones y valoraciones
  await pool.query(`ALTER TABLE viajes ADD COLUMN IF NOT EXISTS asignado_en TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE viajes ADD COLUMN IF NOT EXISTS cargo_cancelacion NUMERIC(6,2) DEFAULT 0;`);

  // Ajustes generales de la plataforma (clave / valor), editables desde el panel
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ajustes (
      clave TEXT PRIMARY KEY,
      valor TEXT NOT NULL
    );
  `);
  await pool.query(`
    INSERT INTO ajustes (clave, valor) VALUES
      ('cancelacion_activa', '1'),
      ('cancelacion_minutos_gratis', '3'),
      ('cancelacion_importe', '5')
    ON CONFLICT (clave) DO NOTHING;
  `);

  // Valoraciones del viaje (opcionales): conductor y servicio, de 1 a 5 estrellas
  await pool.query(`
    CREATE TABLE IF NOT EXISTS valoraciones (
      id SERIAL PRIMARY KEY,
      viaje_id INTEGER UNIQUE REFERENCES viajes(id),
      pasajero_id INTEGER REFERENCES pasajeros(id),
      estrellas_conductor INTEGER CHECK (estrellas_conductor BETWEEN 1 AND 5),
      estrellas_servicio INTEGER CHECK (estrellas_servicio BETWEEN 1 AND 5),
      comentario TEXT,
      creado_en TIMESTAMPTZ DEFAULT NOW()
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
app.use(express.json({ limit: '2mb' })); // límite ampliado para la foto de carné
app.use(express.static(path.join(__dirname, 'public')));
app.set('trust proxy', 1); // necesario en Render para cookies seguras

app.use(session({
  store: new pgSession({
    pool,                             // reutiliza el pool de PostgreSQL ya creado
    tableName: 'sesiones',            // tabla que se crea automáticamente en Neon
    createTableIfMissing: true        // la crea sola si no existe
  }),
  secret: process.env.SESSION_SECRET || 'taxi-av-secreto-desarrollo',
  resave: true,   // necesario con connect-pg-simple para mantener sesiones activas
  rolling: true,  // cada petición renueva el maxAge, la sesión no expira mientras el conductor esté activo
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
    const { nombre, apellido, email, telefono, password, foto } = req.body;
    if (!nombre || !apellido || !emailValido(email) || !telefono || !password || password.length < 6) {
      return res.status(400).json({ error: 'Revisa los datos: todos los campos son obligatorios y la contraseña debe tener al menos 6 caracteres.' });
    }
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO pasajeros (nombre, apellido, email, telefono, password_hash, foto, email_verificado, telefono_verificado)
       VALUES ($1, $2, $3, $4, $5, $6, FALSE, FALSE) RETURNING id, nombre, apellido, email`,
      [nombre.trim(), apellido.trim(), email.toLowerCase().trim(), telefono.trim(), hash, foto || null]
    );
    // Crear preferencias por defecto para el nuevo pasajero
    await pool.query(
      `INSERT INTO preferencias_pasajero (pasajero_id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [rows[0].id]
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
    'SELECT id, nombre, apellido, email, telefono, creado_en FROM pasajeros WHERE id = $1',
    [req.session.usuarioId]
  );
  res.json({ usuario: rows[0] });
});

// Cambiar contraseña del pasajero (ya logueado)
app.post('/api/pasajero/cambiar-password', requierePasajero, async (req, res) => {
  try {
    const { actual, nueva } = req.body;
    if (!actual || !nueva || nueva.length < 6) {
      return res.status(400).json({ error: 'Revisa los datos: la nueva contraseña debe tener al menos 6 caracteres.' });
    }
    const { rows } = await pool.query('SELECT password_hash FROM pasajeros WHERE id = $1', [req.session.usuarioId]);
    if (!rows.length) return res.status(400).json({ error: 'Usuario no encontrado.' });
    const coincide = await bcrypt.compare(actual, rows[0].password_hash);
    if (!coincide) return res.status(400).json({ error: 'La contraseña actual no es correcta.' });
    const hash = await bcrypt.hash(nueva, 10);
    await pool.query('UPDATE pasajeros SET password_hash = $1 WHERE id = $2', [hash, req.session.usuarioId]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error del servidor al cambiar la contraseña.' });
  }
});

// ------------------------------------------------------------
// 4. RUTAS DE CONDUCTORES
// ------------------------------------------------------------

// Servicios del portal de inicio: los activos para todos; los internos solo si eres admin
app.get('/api/servicios', async (req, res) => {
  const esAdmin = (req.session.rol === 'admin');
  const { rows } = await pool.query(
    esAdmin
      ? `SELECT id, nombre, posicion, estado FROM servicios WHERE estado IN ('activo','interno') ORDER BY posicion, id`
      : `SELECT id, nombre, posicion, estado FROM servicios WHERE estado = 'activo' ORDER BY posicion, id`
  );
  res.json({ servicios: rows, vista_admin: esAdmin });
});

// Catálogo para el formulario de alta: categorías activas y marcas con sus modelos
app.get('/api/catalogo', async (req, res) => {
  const categorias = await pool.query(
    `SELECT id, nombre, capacidad_pasajeros, capacidad_maletas, limite_sillas, descripcion
     FROM categorias_vehiculos WHERE activa = TRUE ORDER BY nombre`
  );
  const marcas = await pool.query(`SELECT id, nombre FROM marcas_vehiculos ORDER BY nombre`);
  const modelos = await pool.query(`SELECT id, marca_id, nombre FROM modelos_vehiculos ORDER BY nombre`);
  res.json({
    categorias: categorias.rows,
    marcas: marcas.rows.map(m => ({
      ...m,
      modelos: modelos.rows.filter(mo => mo.marca_id === m.id)
    }))
  });
});

// Resolver marca y modelo: existentes por id, o nuevos por nombre (se incorporan al catálogo)
async function resolverVehiculo(marca_id, marca_nueva, modelo_id, modelo_nuevo) {
  let marcaId = parseInt(marca_id, 10) || null;
  let marcaNombre = null;

  if (!marcaId && marca_nueva && marca_nueva.trim()) {
    const nombre = marca_nueva.trim();
    const existente = await pool.query(
      'SELECT id, nombre FROM marcas_vehiculos WHERE LOWER(nombre) = LOWER($1)', [nombre]
    );
    if (existente.rows.length) {
      marcaId = existente.rows[0].id; marcaNombre = existente.rows[0].nombre;
    } else {
      const insertada = await pool.query(
        'INSERT INTO marcas_vehiculos (nombre) VALUES ($1) RETURNING id, nombre', [nombre]
      );
      marcaId = insertada.rows[0].id; marcaNombre = insertada.rows[0].nombre;
    }
  } else if (marcaId) {
    const fila = await pool.query('SELECT nombre FROM marcas_vehiculos WHERE id = $1', [marcaId]);
    marcaNombre = fila.rows.length ? fila.rows[0].nombre : null;
  }
  if (!marcaId || !marcaNombre) return null;

  let modeloNombre = null;
  const modeloId = parseInt(modelo_id, 10) || null;
  if (modeloId) {
    const fila = await pool.query(
      'SELECT nombre FROM modelos_vehiculos WHERE id = $1 AND marca_id = $2', [modeloId, marcaId]
    );
    modeloNombre = fila.rows.length ? fila.rows[0].nombre : null;
  } else if (modelo_nuevo && modelo_nuevo.trim()) {
    const nombre = modelo_nuevo.trim();
    const existente = await pool.query(
      'SELECT nombre FROM modelos_vehiculos WHERE marca_id = $1 AND LOWER(nombre) = LOWER($2)',
      [marcaId, nombre]
    );
    if (existente.rows.length) modeloNombre = existente.rows[0].nombre;
    else {
      await pool.query('INSERT INTO modelos_vehiculos (marca_id, nombre) VALUES ($1, $2)', [marcaId, nombre]);
      modeloNombre = nombre;
    }
  }
  if (!modeloNombre) return null;
  return { marcaNombre, modeloNombre };
}
app.post('/api/conductor/registro', async (req, res) => {
  try {
    const d = req.body;

    // 1) Datos personales y de acceso
    if (!d.nombre || !emailValido(d.email) || !d.telefono || !d.password || d.password.length < 6) {
      return res.status(400).json({ error: 'Revisa los datos personales: nombre, email, teléfono y contraseña (mínimo 6 caracteres) son obligatorios.' });
    }
    if (!d.documento || !d.direccion || !d.cp || !d.municipio) {
      return res.status(400).json({ error: 'Faltan datos personales: documento de identidad, dirección, código postal y municipio.' });
    }

    // 2) Licencia municipal (lo que identifica a un taxista profesional)
    if (!d.municipio_licencia || !d.numero_licencia) {
      return res.status(400).json({ error: 'Faltan los datos de la licencia municipal (municipio y número).' });
    }

    // 3) Aceptaciones legales obligatorias
    if (!d.acepta_condiciones || !d.acepta_manual || !d.acepta_privacidad) {
      return res.status(400).json({ error: 'Debes aceptar las Condiciones de adscripción, el Manual de Buen Operador y la Política de Privacidad.' });
    }

    // 4) Vehículo: categoría activa y marca/modelo del catálogo (o nuevos)
    const categoriaId = parseInt(d.categoria_id, 10);
    const categoria = await pool.query(
      'SELECT id FROM categorias_vehiculos WHERE id = $1 AND activa = TRUE', [categoriaId]
    );
    if (categoria.rows.length === 0) {
      return res.status(400).json({ error: 'Elige una categoría de vehículo válida.' });
    }
    const vehiculo = await resolverVehiculo(d.marca_id, d.marca_nueva, d.modelo_id, d.modelo_nuevo);
    if (!vehiculo) {
      return res.status(400).json({ error: 'Indica la marca y el modelo del vehículo (elígelos de la lista o añádelos).' });
    }
    if (!d.matricula || !d.numero_taxi) {
      return res.status(400).json({ error: 'Faltan la matrícula y el número de taxi.' });
    }

    const hash = await bcrypt.hash(d.password, 10);
    const { rows } = await pool.query(
      `INSERT INTO conductores
        (nombre, email, telefono, password_hash, documento, direccion, cp, municipio,
         municipio_licencia, numero_licencia, central_flota,
         categoria_id, vehiculo_marca, vehiculo_modelo, matricula, plazas, isla, numero_taxi)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING id, nombre, email, estado`,
      [
        d.nombre.trim(), d.email.toLowerCase().trim(), d.telefono.trim(), hash,
        d.documento.trim().toUpperCase(), d.direccion.trim(), d.cp.trim(), d.municipio.trim(),
        d.municipio_licencia.trim(), d.numero_licencia.trim(), (d.central_flota || '').trim(),
        categoriaId, vehiculo.marcaNombre, vehiculo.modeloNombre,
        d.matricula.trim().toUpperCase(), parseInt(d.plazas, 10) || 4,
        d.isla || 'Gran Canaria', d.numero_taxi.trim()
      ]
    );
    req.session.usuarioId = rows[0].id;
    req.session.rol = 'conductor';
    res.json({ ok: true, conductor: rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Ese email ya está registrado. Cada conductor debe usar su propio email y contraseña.' });
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
    `SELECT c.id, c.nombre, c.email, c.telefono, c.vehiculo_marca, c.vehiculo_modelo, c.matricula,
            c.plazas, c.isla, c.tipo, c.estado, c.disponible, c.numero_taxi, c.foto,
            c.foto_estado, c.foto_motivo, c.numero_licencia, c.municipio_licencia,
            cat.nombre AS categoria, c.creado_en
     FROM conductores c
     LEFT JOIN categorias_vehiculos cat ON cat.id = c.categoria_id
     WHERE c.id = $1`,
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

// Crear conductor desde el admin (el conductor viene a la oficina con su documentación)
app.post('/api/admin/conductores/crear', requiereAdmin, async (req, res) => {
  try {
    const d = req.body;
    if (!d.nombre || !emailValido(d.email) || !d.telefono || !d.password || d.password.length < 6) {
      return res.status(400).json({ error: 'Nombre, email, teléfono y contraseña (mínimo 6 caracteres) son obligatorios.' });
    }
    if (!d.documento || !d.direccion || !d.cp || !d.municipio) {
      return res.status(400).json({ error: 'Faltan datos personales: documento, dirección, CP y municipio.' });
    }
    if (!d.municipio_licencia || !d.numero_licencia) {
      return res.status(400).json({ error: 'Faltan los datos de la licencia municipal.' });
    }
    const categoriaId = parseInt(d.categoria_id, 10);
    const categoria = await pool.query('SELECT id FROM categorias_vehiculos WHERE id = $1 AND activa = TRUE', [categoriaId]);
    if (categoria.rows.length === 0) return res.status(400).json({ error: 'Elige una categoría de vehículo válida.' });
    const vehiculo = await resolverVehiculo(d.marca_id, d.marca_nueva, d.modelo_id, d.modelo_nuevo);
    if (!vehiculo) return res.status(400).json({ error: 'Indica la marca y el modelo del vehículo.' });
    if (!d.matricula || !d.numero_taxi) return res.status(400).json({ error: 'Faltan la matrícula y el número de taxi.' });

    const hash = await bcrypt.hash(d.password, 10);
    const foto = d.foto || null; // foto en base64 opcional
    const fotoEstado = foto ? 'aprobada' : 'sin_foto'; // el admin la sube, va directo a aprobada
    const { rows } = await pool.query(
      `INSERT INTO conductores
        (nombre, email, telefono, password_hash, documento, direccion, cp, municipio,
         municipio_licencia, numero_licencia, central_flota,
         categoria_id, vehiculo_marca, vehiculo_modelo, matricula, plazas, isla, numero_taxi,
         foto, foto_estado, estado)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,'aprobado')
       RETURNING id, nombre, email, estado`,
      [
        d.nombre.trim(), d.email.toLowerCase().trim(), d.telefono.trim(), hash,
        d.documento.trim().toUpperCase(), d.direccion.trim(), d.cp.trim(), d.municipio.trim(),
        d.municipio_licencia.trim(), d.numero_licencia.trim(), (d.central_flota || '').trim(),
        categoriaId, vehiculo.marcaNombre, vehiculo.modeloNombre,
        d.matricula.trim().toUpperCase(), parseInt(d.plazas, 10) || 4,
        d.isla || 'Gran Canaria', d.numero_taxi.trim(), foto, fotoEstado
      ]
    );
    res.json({ ok: true, conductor: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Ese email ya está registrado.' });
    console.error(err);
    res.status(500).json({ error: 'Error del servidor al crear el conductor.' });
  }
});

app.get('/api/admin/conductores', requiereAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.id, c.nombre, c.email, c.telefono, c.vehiculo_marca, c.vehiculo_modelo, c.matricula,
            c.plazas, c.isla, c.tipo, c.estado, c.numero_taxi, c.foto_estado, c.permite_contacto, c.creado_en,
            cat.nombre AS categoria,
            ROUND(AVG(va.estrellas_conductor), 1) AS media_estrellas,
            COUNT(va.id)::int AS total_valoraciones
     FROM conductores c
     LEFT JOIN categorias_vehiculos cat ON cat.id = c.categoria_id
     LEFT JOIN viajes v ON v.conductor_id = c.id
     LEFT JOIN valoraciones va ON va.viaje_id = v.id
     GROUP BY c.id, cat.nombre
     ORDER BY c.creado_en DESC`
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

app.get('/api/admin/ajustes', requiereAdmin, async (req, res) => {
  res.json(await ajustesCancelacion());
});

app.post('/api/admin/ajustes', requiereAdmin, async (req, res) => {
  const valores = {
    cancelacion_activa: req.body.activa ? '1' : '0',
    cancelacion_minutos_gratis: String(parseInt(req.body.minutos_gratis, 10) || 3),
    cancelacion_importe: String(parseFloat(req.body.importe) || 5)
  };
  for (const [clave, valor] of Object.entries(valores)) {
    await pool.query(
      `INSERT INTO ajustes (clave, valor) VALUES ($1, $2)
       ON CONFLICT (clave) DO UPDATE SET valor = $2`,
      [clave, valor]
    );
  }
  res.json({ ok: true });
});

// Ficha completa (expediente) de un conductor
app.get('/api/admin/conductores/:id/ficha', requiereAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.id, c.nombre, c.email, c.telefono, c.documento, c.direccion, c.cp, c.municipio,
            c.municipio_licencia, c.numero_licencia, c.central_flota,
            c.vehiculo_marca, c.vehiculo_modelo, c.matricula, c.plazas, c.isla, c.numero_taxi,
            c.tipo, c.estado, c.foto, c.foto_estado, c.foto_motivo, c.creado_en,
            cat.nombre AS categoria
     FROM conductores c
     LEFT JOIN categorias_vehiculos cat ON cat.id = c.categoria_id
     WHERE c.id = $1`,
    [req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Conductor no encontrado.' });
  res.json({ conductor: rows[0] });
});

// Aprobar o rechazar la foto de carné (control de imagen de la compañía)
app.post('/api/admin/conductores/:id/foto', requiereAdmin, async (req, res) => {
  const { accion, motivo } = req.body;
  if (accion === 'aprobar') {
    await pool.query(
      `UPDATE conductores SET foto_estado = 'aprobada', foto_motivo = NULL WHERE id = $1`,
      [req.params.id]
    );
  } else if (accion === 'rechazar') {
    await pool.query(
      `UPDATE conductores SET foto_estado = 'rechazada', foto_motivo = $1 WHERE id = $2`,
      [(motivo || 'La foto no cumple los requisitos.').slice(0, 200), req.params.id]
    );
  } else {
    return res.status(400).json({ error: 'Acción no válida.' });
  }
  res.json({ ok: true });
});

// Gestión de servicios del portal (crear, posición, estado)
app.get('/api/admin/servicios', requiereAdmin, async (req, res) => {
  const { rows } = await pool.query(`SELECT id, nombre, posicion, estado FROM servicios ORDER BY posicion, id`);
  res.json({ servicios: rows });
});

app.post('/api/admin/servicios', requiereAdmin, async (req, res) => {
  const nombre = (req.body.nombre || '').trim();
  if (!nombre) return res.status(400).json({ error: 'El servicio necesita un nombre.' });
  try {
    await pool.query(
      `INSERT INTO servicios (nombre, posicion, estado) VALUES ($1, $2, 'inactivo')`,
      [nombre, parseInt(req.body.posicion, 10) || 99]
    );
    res.json({ ok: true });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Ya existe un servicio con ese nombre.' });
    throw err;
  }
});

app.post('/api/admin/servicios/:id', requiereAdmin, async (req, res) => {
  const estado = req.body.estado;
  if (estado && !['inactivo', 'activo', 'interno'].includes(estado)) {
    return res.status(400).json({ error: 'Estado no válido.' });
  }
  if (estado) await pool.query('UPDATE servicios SET estado = $1 WHERE id = $2', [estado, req.params.id]);
  if (req.body.posicion !== undefined) {
    await pool.query('UPDATE servicios SET posicion = $1 WHERE id = $2', [parseInt(req.body.posicion, 10) || 99, req.params.id]);
  }
  if (req.body.nombre !== undefined) {
    const nombre = (req.body.nombre || '').trim();
    if (!nombre) return res.status(400).json({ error: 'El nombre no puede quedar vacío.' });
    try {
      await pool.query('UPDATE servicios SET nombre = $1 WHERE id = $2', [nombre, req.params.id]);
    } catch (err) {
      if (err.code === '23505') return res.status(400).json({ error: 'Ya existe un servicio con ese nombre.' });
      throw err;
    }
  }
  res.json({ ok: true });
});

// Crear una categoría de vehículo nueva (nace inactiva y no disponible)
app.post('/api/admin/categorias', requiereAdmin, async (req, res) => {
  const d = req.body;
  const nombre = (d.nombre || '').trim();
  if (!nombre) return res.status(400).json({ error: 'La categoría necesita un nombre.' });
  try {
    await pool.query(
      `INSERT INTO categorias_vehiculos
         (nombre, capacidad_pasajeros, capacidad_maletas, limite_sillas, descripcion,
          bajada_diurna, bajada_nocturna, activa, disponible)
       VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE, FALSE)`,
      [nombre, parseInt(d.capacidad_pasajeros, 10) || 4, (d.capacidad_maletas || '').trim() || '—',
       parseInt(d.limite_sillas, 10) || 0, (d.descripcion || '').trim(),
       parseFloat(d.bajada_diurna) || 0, parseFloat(d.bajada_nocturna) || 0]
    );
    res.json({ ok: true });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Ya existe una categoría con ese nombre.' });
    throw err;
  }
});

// Editar una categoría de vehículo (nombre, capacidades, descripción, tarificador)
app.post('/api/admin/categorias/:id/editar', requiereAdmin, async (req, res) => {
  const d = req.body;
  const nombre = (d.nombre || '').trim();
  if (!nombre) return res.status(400).json({ error: 'La categoría necesita un nombre.' });
  try {
    await pool.query(
      `UPDATE categorias_vehiculos
       SET nombre = $1, capacidad_pasajeros = $2, capacidad_maletas = $3, limite_sillas = $4, descripcion = $5,
           bajada_diurna = $6, bajada_nocturna = $7
       WHERE id = $8`,
      [nombre, parseInt(d.capacidad_pasajeros, 10) || 4, (d.capacidad_maletas || '').trim() || '—',
       parseInt(d.limite_sillas, 10) || 0, (d.descripcion || '').trim(),
       parseFloat(d.bajada_diurna) || 0, parseFloat(d.bajada_nocturna) || 0, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Ya existe una categoría con ese nombre.' });
    throw err;
  }
});

// Eliminar una categoría (solo si ningún conductor ni viaje la está usando)
app.post('/api/admin/categorias/:id/eliminar', requiereAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM categorias_vehiculos WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    if (err.code === '23503') {
      return res.status(400).json({ error: 'No se puede eliminar: hay conductores o viajes usando esta categoría. Desactívala en su lugar.' });
    }
    throw err;
  }
});

// Foto de una categoría de vehículo (la sube el admin)
app.post('/api/admin/categorias/:id/foto', requiereAdmin, async (req, res) => {
  const { foto } = req.body;
  if (!foto || !foto.startsWith('data:image/') || foto.length > 700000) {
    return res.status(400).json({ error: 'La imagen no es válida o pesa demasiado.' });
  }
  await pool.query('UPDATE categorias_vehiculos SET foto = $1 WHERE id = $2', [foto, req.params.id]);
  res.json({ ok: true });
});

// Gestión de categorías: verlas todas y activarlas/desactivarlas
app.get('/api/admin/categorias', requiereAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, nombre, capacidad_pasajeros, capacidad_maletas, limite_sillas, descripcion, activa,
            disponible, bajada_diurna, bajada_nocturna,
            (foto IS NOT NULL) AS tiene_foto
     FROM categorias_vehiculos ORDER BY id`
  );
  res.json({ categorias: rows });
});

app.post('/api/admin/categorias/:id/activa', requiereAdmin, async (req, res) => {
  await pool.query(
    'UPDATE categorias_vehiculos SET activa = $1 WHERE id = $2',
    [!!req.body.activa, req.params.id]
  );
  res.json({ ok: true });
});

// "Disponible": son las categorías que se ofrecen HOY al cliente en el selector
app.post('/api/admin/categorias/:id/disponible', requiereAdmin, async (req, res) => {
  await pool.query(
    'UPDATE categorias_vehiculos SET disponible = $1 WHERE id = $2',
    [!!req.body.disponible, req.params.id]
  );
  res.json({ ok: true });
});

// ------------------------------------------------------------
// Catálogo de extras del viaje (gestión desde el admin)
// ------------------------------------------------------------

// Listar todos los extras, con las categorías a las que están restringidos (si no son "todas")
app.get('/api/admin/extras', requiereAdmin, async (req, res) => {
  const extras = await pool.query(
    `SELECT id, nombre, incluido, precio, todas_categorias, activo, orden FROM extras_viaje ORDER BY orden, nombre`
  );
  const categorias = await pool.query(`SELECT extra_id, categoria_id FROM extras_categorias`);
  res.json({
    extras: extras.rows.map(e => ({
      ...e,
      categorias: categorias.rows.filter(c => c.extra_id === e.id).map(c => c.categoria_id)
    }))
  });
});

// Guardar (categorías destino: array de ids, ignorado si todas_categorias = true)
async function guardarCategoriasExtra(extraId, categorias) {
  await pool.query('DELETE FROM extras_categorias WHERE extra_id = $1', [extraId]);
  const ids = Array.isArray(categorias) ? categorias.map(c => parseInt(c, 10)).filter(Boolean) : [];
  for (const categoriaId of ids) {
    await pool.query(
      'INSERT INTO extras_categorias (extra_id, categoria_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [extraId, categoriaId]
    );
  }
}

// Crear un nuevo extra
app.post('/api/admin/extras', requiereAdmin, async (req, res) => {
  const d = req.body;
  const nombre = (d.nombre || '').trim();
  if (!nombre) return res.status(400).json({ error: 'El extra necesita un nombre.' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO extras_viaje (nombre, incluido, precio, todas_categorias, activo, orden)
       VALUES ($1, $2, $3, $4, TRUE, $5) RETURNING id`,
      [nombre, !!d.incluido, parseFloat(d.precio) || 0, !!d.todas_categorias, parseInt(d.orden, 10) || 0]
    );
    await guardarCategoriasExtra(rows[0].id, d.categorias);
    res.json({ ok: true });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Ya existe un extra con ese nombre.' });
    throw err;
  }
});

// Editar un extra existente
app.post('/api/admin/extras/:id/editar', requiereAdmin, async (req, res) => {
  const d = req.body;
  const nombre = (d.nombre || '').trim();
  if (!nombre) return res.status(400).json({ error: 'El extra necesita un nombre.' });
  try {
    await pool.query(
      `UPDATE extras_viaje SET nombre = $1, incluido = $2, precio = $3, todas_categorias = $4, orden = $5
       WHERE id = $6`,
      [nombre, !!d.incluido, parseFloat(d.precio) || 0, !!d.todas_categorias, parseInt(d.orden, 10) || 0, req.params.id]
    );
    await guardarCategoriasExtra(req.params.id, d.categorias);
    res.json({ ok: true });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Ya existe un extra con ese nombre.' });
    throw err;
  }
});

// Activar / desactivar un extra
app.post('/api/admin/extras/:id/activo', requiereAdmin, async (req, res) => {
  await pool.query('UPDATE extras_viaje SET activo = $1 WHERE id = $2', [!!req.body.activo, req.params.id]);
  res.json({ ok: true });
});

// Editar la ficha completa de un conductor desde el panel (lista blanca de campos)
app.post('/api/admin/conductores/:id/editar', requiereAdmin, async (req, res) => {
  const camposPermitidos = ['nombre', 'telefono', 'email', 'documento', 'direccion', 'cp', 'municipio',
    'municipio_licencia', 'numero_licencia', 'central_flota',
    'vehiculo_marca', 'vehiculo_modelo', 'matricula', 'numero_taxi', 'plazas', 'isla'];
  const cambios = [];
  const valores = [];
  for (const campo of camposPermitidos) {
    if (req.body[campo] !== undefined) {
      let valor = String(req.body[campo]).trim();
      if (campo === 'email') valor = valor.toLowerCase();
      if (campo === 'matricula' || campo === 'documento') valor = valor.toUpperCase();
      if (campo === 'plazas') valor = parseInt(valor, 10) || 4;
      if ((campo === 'nombre' || campo === 'email') && !valor) {
        return res.status(400).json({ error: 'El nombre y el email no pueden quedar vacíos.' });
      }
      valores.push(valor);
      cambios.push(`${campo} = $${valores.length}`);
    }
  }
  if (!cambios.length) return res.status(400).json({ error: 'No hay cambios que guardar.' });
  valores.push(req.params.id);
  try {
    await pool.query(`UPDATE conductores SET ${cambios.join(', ')} WHERE id = $${valores.length}`, valores);
    res.json({ ok: true });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Ese email ya lo usa otro conductor.' });
    throw err;
  }
});

// Editar el nombre de un conductor (errores de escritura)
app.post('/api/admin/conductores/:id/nombre', requiereAdmin, async (req, res) => {
  const nombre = (req.body.nombre || '').trim();
  if (!nombre) return res.status(400).json({ error: 'El nombre no puede quedar vacío.' });
  await pool.query('UPDATE conductores SET nombre = $1 WHERE id = $2', [nombre, req.params.id]);
  res.json({ ok: true });
});

// Activar/desactivar el botón "Contactar al chofer": uno o todos
app.post('/api/admin/conductores/:id/contacto', requiereAdmin, async (req, res) => {
  await pool.query('UPDATE conductores SET permite_contacto = $1 WHERE id = $2', [!!req.body.permite, req.params.id]);
  res.json({ ok: true });
});
app.post('/api/admin/conductores-contacto-global', requiereAdmin, async (req, res) => {
  await pool.query('UPDATE conductores SET permite_contacto = $1', [!!req.body.permite]);
  res.json({ ok: true });
});

// Eliminar un conductor (limpieza de pruebas): sus viajes quedan sin conductor asignado
app.delete('/api/admin/conductores/:id', requiereAdmin, async (req, res) => {
  await pool.query(`UPDATE viajes SET conductor_id = NULL WHERE conductor_id = $1`, [req.params.id]);
  await pool.query(`DELETE FROM conductores WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
});

// Eliminar un pasajero (limpieza): se borran sus valoraciones y sus viajes quedan anónimos
app.delete('/api/admin/pasajeros/:id', requiereAdmin, async (req, res) => {
  await pool.query(`DELETE FROM valoraciones WHERE pasajero_id = $1`, [req.params.id]);
  await pool.query(`UPDATE viajes SET estado = 'cancelado' WHERE pasajero_id = $1 AND estado IN ('solicitado','asignado','en_curso')`, [req.params.id]);
  await pool.query(`UPDATE viajes SET pasajero_id = NULL WHERE pasajero_id = $1`, [req.params.id]);
  await pool.query(`DELETE FROM pasajeros WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
});

// Eliminar valoraciones: una concreta o todas (limpieza de pruebas)
app.delete('/api/admin/valoraciones/:id', requiereAdmin, async (req, res) => {
  await pool.query(`DELETE FROM valoraciones WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
});
app.delete('/api/admin/valoraciones', requiereAdmin, async (req, res) => {
  await pool.query(`DELETE FROM valoraciones`);
  res.json({ ok: true });
});

app.get('/api/admin/valoraciones', requiereAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT va.id, va.viaje_id, va.estrellas_conductor, va.estrellas_servicio, va.comentario, va.creado_en,
            c.nombre AS conductor, c.numero_taxi, p.nombre AS pasajero
     FROM valoraciones va
     JOIN viajes v ON v.id = va.viaje_id
     LEFT JOIN conductores c ON c.id = v.conductor_id
     JOIN pasajeros p ON p.id = va.pasajero_id
     ORDER BY va.creado_en DESC
     LIMIT 50`
  );
  res.json({ valoraciones: rows });
});

app.get('/api/admin/pasajeros', requiereAdmin, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, nombre, apellido, email, telefono, activo, creado_en FROM pasajeros ORDER BY creado_en DESC'
  );
  res.json({ pasajeros: rows });
});

app.post('/api/admin/pasajeros/:id/activo', requiereAdmin, async (req, res) => {
  await pool.query('UPDATE pasajeros SET activo = $1 WHERE id = $2', [!!req.body.activo, req.params.id]);
  res.json({ ok: true });
});

// ------------------------------------------------------------
// 6. RUTAS DE VIAJES (Fase 2) — lado del pasajero
// Estados del viaje: solicitado → asignado → en_curso → finalizado
//                    (o cancelado)
// ------------------------------------------------------------

// Distancia en línea recta entre dos coordenadas (fórmula de Haversine)
function distanciaKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Comprobar que unas coordenadas caen dentro del archipiélago canario
function dentroDeCanarias(lat, lng) {
  return lat >= 27.2 && lat <= 29.6 && lng >= -18.6 && lng <= -13.0;
}

// ------------------------------------------------------------
// TARIFICADOR PROVISIONAL (basado en la tarifa oficial de taxis de Las Palmas de
// Gran Canaria, BOC nº150 del 31/07/2023). Solo diurno/nocturno por ahora;
// festivos, hora de espera y suplementos por bultos/muelle se añadirán más
// adelante. La "bajada de bandera" es lo único que varía por categoría.
// ------------------------------------------------------------
const TARIFA = {
  porKmDiurno: 0.80,
  porKmNocturno: 0.85,
  suplemento: 0.50   // suplemento por pedido a través de la app (a renombrar/ajustar)
};

// Hora actual en Canarias (independiente de la zona horaria del servidor)
function horaCanarias() {
  const ahora = new Date();
  return parseInt(ahora.toLocaleString('en-US', { timeZone: 'Atlantic/Canary', hour: 'numeric', hour12: false }), 10);
}

function esHorarioDiurno() {
  const hora = horaCanarias();
  return hora >= 6 && hora < 22;
}

// Precio orientativo para una categoría concreta, según su bajada de bandera
function calcularPrecio(km, categoria) {
  const diurno = esHorarioDiurno();
  const bajada = diurno ? Number(categoria.bajada_diurna) : Number(categoria.bajada_nocturna);
  const porKm = diurno ? TARIFA.porKmDiurno : TARIFA.porKmNocturno;
  return bajada + km * porKm + TARIFA.suplemento;
}

// Categorías que el cliente puede elegir hoy: activas Y marcadas como disponibles
app.get('/api/categorias-disponibles', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, nombre, foto, capacidad_pasajeros, capacidad_maletas, bajada_diurna, bajada_nocturna
     FROM categorias_vehiculos WHERE activa = TRUE AND disponible = TRUE ORDER BY bajada_diurna, nombre`
  );
  res.json({ categorias: rows, diurno: esHorarioDiurno() });
});

// Extras del viaje: se devuelven TODOS los activos (para que el cliente sepa que existen),
// marcando si aplican a esta categoría; los restringidos a otras categorías indican en cuáles sí.
app.get('/api/extras-disponibles', async (req, res) => {
  const categoriaId = parseInt(req.query.categoria_id, 10);
  if (!categoriaId) return res.json({ extras: [] });
  const { rows } = await pool.query(
    `SELECT e.id, e.nombre, e.incluido,
            CASE WHEN e.incluido THEN 0 ELSE e.precio END AS precio,
            e.todas_categorias,
            (e.todas_categorias OR EXISTS (
               SELECT 1 FROM extras_categorias ec WHERE ec.extra_id = e.id AND ec.categoria_id = $1
             )) AS disponible_aqui,
            (SELECT array_agg(c.nombre ORDER BY c.nombre)
               FROM extras_categorias ec JOIN categorias_vehiculos c ON c.id = ec.categoria_id
               WHERE ec.extra_id = e.id) AS categorias_permitidas
     FROM extras_viaje e
     WHERE e.activo = TRUE
     ORDER BY e.orden, e.nombre`,
    [categoriaId]
  );
  res.json({ extras: rows });
});

// El pasajero pide un taxi
app.post('/api/pasajero/viaje', requierePasajero, async (req, res) => {
  try {
    const { origen_lat, origen_lng, origen_direccion, destino_lat, destino_lng, destino_direccion,
            categoria_id, extras, instrucciones_conductor, pedido_para_nombre, pedido_para_telefono } = req.body;

    const oLat = parseFloat(origen_lat), oLng = parseFloat(origen_lng);
    const dLat = parseFloat(destino_lat), dLng = parseFloat(destino_lng);

    if ([oLat, oLng, dLat, dLng].some(Number.isNaN)) {
      return res.status(400).json({ error: 'Faltan las coordenadas del viaje.' });
    }
    if (!dentroDeCanarias(oLat, oLng) || !dentroDeCanarias(dLat, dLng)) {
      return res.status(400).json({ error: 'El servicio solo está disponible dentro de Canarias.' });
    }

    const km = distanciaKm(oLat, oLng, dLat, dLng);
    if (km < 0.2) {
      return res.status(400).json({ error: 'El origen y el destino están demasiado cerca (menos de 200 metros).' });
    }

    // Categoría de vehículo elegida: debe estar activa y disponible hoy
    const categoria = await pool.query(
      `SELECT id, bajada_diurna, bajada_nocturna FROM categorias_vehiculos
       WHERE id = $1 AND activa = TRUE AND disponible = TRUE`,
      [parseInt(categoria_id, 10)]
    );
    if (categoria.rows.length === 0) {
      return res.status(400).json({ error: 'Elige un tipo de vehículo disponible.' });
    }

    // Extras elegidos: solo se aceptan los que estén activos y disponibles para esta categoría
    const idsExtras = Array.isArray(extras) ? extras.map(e => parseInt(e, 10)).filter(Number.isFinite) : [];
    let extrasValidos = [];
    if (idsExtras.length) {
      const { rows } = await pool.query(
        `SELECT e.id, e.nombre, e.incluido, CASE WHEN e.incluido THEN 0 ELSE e.precio END AS precio
         FROM extras_viaje e
         WHERE e.activo = TRUE AND e.id = ANY($1)
           AND (e.todas_categorias = TRUE OR EXISTS (
                 SELECT 1 FROM extras_categorias ec WHERE ec.extra_id = e.id AND ec.categoria_id = $2
               ))`,
        [idsExtras, categoria.rows[0].id]
      );
      extrasValidos = rows;
    }
    const totalExtras = extrasValidos.reduce((s, e) => s + Number(e.precio), 0);
    const precioEstimado = calcularPrecio(km, categoria.rows[0]) + totalExtras;

    // Un pasajero solo puede tener un viaje activo a la vez
    const activo = await pool.query(
      `SELECT id FROM viajes WHERE pasajero_id = $1 AND estado IN ('solicitado','asignado','en_curso')`,
      [req.session.usuarioId]
    );
    if (activo.rows.length > 0) {
      return res.status(400).json({ error: 'Ya tienes un viaje en marcha. Cancélalo o espera a que termine.' });
    }

    const { rows } = await pool.query(
      `INSERT INTO viajes (pasajero_id, origen_direccion, origen_lat, origen_lng,
                           destino_direccion, destino_lat, destino_lng, distancia_km, categoria_id, precio_estimado,
                           extras, instrucciones_conductor, pedido_para_nombre, pedido_para_telefono, estado)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'solicitado')
       RETURNING *`,
      [req.session.usuarioId, (origen_direccion || '').slice(0, 300), oLat, oLng,
       (destino_direccion || '').slice(0, 300), dLat, dLng, km.toFixed(2), categoria.rows[0].id, precioEstimado.toFixed(2),
       JSON.stringify(extrasValidos.map(e => ({ id: e.id, nombre: e.nombre, precio: Number(e.precio) }))),
       (instrucciones_conductor || '').slice(0, 300) || null,
       (pedido_para_nombre || '').slice(0, 120) || null,
       (pedido_para_telefono || '').slice(0, 40) || null]
    );
    // BREVO (pendiente): el SMS de seguimiento va a pedido_para_telefono si existe, si no al teléfono del pasajero
    res.json({ ok: true, viaje: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error del servidor al crear el viaje.' });
  }
});

// El pasajero consulta su viaje activo (si lo tiene), con los datos del conductor si ya está asignado
app.get('/api/pasajero/viaje-actual', requierePasajero, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT v.*, c.nombre AS conductor_nombre, c.vehiculo_marca, c.vehiculo_modelo, c.matricula,
            c.numero_taxi, c.permite_contacto AS contacto_permitido,
            CASE WHEN c.foto_estado = 'aprobada' THEN c.foto END AS conductor_foto,
            c.lat AS taxi_lat, c.lng AS taxi_lng, c.posicion_en AS taxi_posicion_en
     FROM viajes v
     LEFT JOIN conductores c ON c.id = v.conductor_id
     WHERE v.pasajero_id = $1 AND v.estado IN ('solicitado','asignado','en_curso')
     ORDER BY v.solicitado_en DESC LIMIT 1`,
    [req.session.usuarioId]
  );
  res.json({ viaje: rows[0] || null });
});

// Leer los ajustes de cancelación (los usa también el pasajero antes de cancelar)
async function ajustesCancelacion() {
  const { rows } = await pool.query(`SELECT clave, valor FROM ajustes WHERE clave LIKE 'cancelacion%'`);
  const mapa = Object.fromEntries(rows.map(f => [f.clave, f.valor]));
  return {
    activa: mapa.cancelacion_activa === '1',
    minutos_gratis: parseInt(mapa.cancelacion_minutos_gratis, 10) || 3,
    importe: parseFloat(mapa.cancelacion_importe) || 5
  };
}

app.get('/api/ajustes/cancelacion', requierePasajero, async (req, res) => {
  res.json(await ajustesCancelacion());
});

// El pasajero cancela su viaje (solo si aún no está en curso).
// Si la política está activa y el conductor lleva asignado más de los minutos
// gratuitos, se registra el cargo de cancelación (se cobrará con la Fase de pagos).
app.post('/api/pasajero/viaje/:id/cancelar', requierePasajero, async (req, res) => {
  const previo = await pool.query(
    `SELECT id, estado, asignado_en FROM viajes
     WHERE id = $1 AND pasajero_id = $2 AND estado IN ('solicitado','asignado')`,
    [req.params.id, req.session.usuarioId]
  );
  if (previo.rows.length === 0) {
    return res.status(400).json({ error: 'Este viaje ya no se puede cancelar.' });
  }

  let cargo = 0;
  const politica = await ajustesCancelacion();
  if (politica.activa && previo.rows[0].estado === 'asignado' && previo.rows[0].asignado_en) {
    const minutos = (Date.now() - new Date(previo.rows[0].asignado_en).getTime()) / 60000;
    if (minutos > politica.minutos_gratis) cargo = politica.importe;
  }

  await pool.query(
    `UPDATE viajes SET estado = 'cancelado', finalizado_en = NOW(), cargo_cancelacion = $1 WHERE id = $2`,
    [cargo, previo.rows[0].id]
  );
  res.json({ ok: true, cargo });
});

// Valoración opcional del viaje terminado: conductor y servicio (1-5) + comentario
app.post('/api/pasajero/viaje/:id/valorar', requierePasajero, async (req, res) => {
  try {
    const ec = parseInt(req.body.estrellas_conductor, 10);
    const es = parseInt(req.body.estrellas_servicio, 10);
    if (!(ec >= 1 && ec <= 5) || !(es >= 1 && es <= 5)) {
      return res.status(400).json({ error: 'Las valoraciones deben ser de 1 a 5 estrellas.' });
    }
    const viaje = await pool.query(
      `SELECT id FROM viajes WHERE id = $1 AND pasajero_id = $2 AND estado = 'finalizado'`,
      [req.params.id, req.session.usuarioId]
    );
    if (viaje.rows.length === 0) {
      return res.status(400).json({ error: 'Solo se pueden valorar viajes terminados.' });
    }
    await pool.query(
      `INSERT INTO valoraciones (viaje_id, pasajero_id, estrellas_conductor, estrellas_servicio, comentario)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (viaje_id) DO UPDATE SET estrellas_conductor = $3, estrellas_servicio = $4, comentario = $5`,
      [req.params.id, req.session.usuarioId, ec, es, (req.body.comentario || '').slice(0, 500)]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al guardar la valoración.' });
  }
});

// ------------------------------------------------------------
// 6b. RUTAS DE VIAJES (Fase 2, Entrega 3) — lado del conductor
// ------------------------------------------------------------

// Solo los conductores APROBADOS pueden operar con viajes
async function conductorAprobado(req, res, next) {
  const { rows } = await pool.query(
    'SELECT estado FROM conductores WHERE id = $1',
    [req.session.usuarioId]
  );
  if (rows.length === 0 || rows[0].estado !== 'aprobado') {
    return res.status(403).json({ error: 'Tu cuenta debe estar aprobada por la administración para esta acción.' });
  }
  next();
}

// Activar / desactivar disponibilidad para recibir viajes
app.post('/api/conductor/disponible', requiereConductor, conductorAprobado, async (req, res) => {
  await pool.query(
    'UPDATE conductores SET disponible = $1 WHERE id = $2',
    [!!req.body.disponible, req.session.usuarioId]
  );
  res.json({ ok: true, disponible: !!req.body.disponible });
});

// El conductor envía su posición GPS (Fase 3: seguimiento en vivo)
app.post('/api/conductor/posicion', requiereConductor, conductorAprobado, async (req, res) => {
  const lat = parseFloat(req.body.lat);
  const lng = parseFloat(req.body.lng);
  if (Number.isNaN(lat) || Number.isNaN(lng) || !dentroDeCanarias(lat, lng)) {
    return res.status(400).json({ error: 'Posición no válida.' });
  }
  await pool.query(
    'UPDATE conductores SET lat = $1, lng = $2, posicion_en = NOW() WHERE id = $3',
    [lat, lng, req.session.usuarioId]
  );
  res.json({ ok: true });
});

// El conductor sube (o cambia) su foto de carné, en formato comprimido
app.post('/api/conductor/foto', requiereConductor, async (req, res) => {
  const { foto } = req.body;
  if (!foto || typeof foto !== 'string' || !foto.startsWith('data:image/')) {
    return res.status(400).json({ error: 'La imagen no es válida.' });
  }
  if (foto.length > 700000) {
    return res.status(400).json({ error: 'La imagen es demasiado grande. Inténtalo con otra foto.' });
  }
  await pool.query(
    `UPDATE conductores SET foto = $1, foto_estado = 'pendiente', foto_motivo = NULL WHERE id = $2`,
    [foto, req.session.usuarioId]
  );
  res.json({ ok: true });
});

// Ver las solicitudes de viaje pendientes (las más antiguas primero)
app.get('/api/conductor/solicitudes', requiereConductor, conductorAprobado, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT v.id, v.origen_direccion, v.destino_direccion, v.distancia_km, v.solicitado_en,
            v.extras, v.instrucciones_conductor, v.pedido_para_nombre, v.pedido_para_telefono,
            p.nombre AS pasajero_nombre
     FROM viajes v
     JOIN pasajeros p ON p.id = v.pasajero_id
     WHERE v.estado = 'solicitado'
     ORDER BY v.solicitado_en ASC
     LIMIT 20`
  );
  res.json({ solicitudes: rows });
});

// Aceptar un viaje (asignación atómica: si dos conductores pulsan a la vez, solo gana uno)
app.post('/api/conductor/viaje/:id/aceptar', requiereConductor, conductorAprobado, async (req, res) => {
  // Un conductor solo puede llevar un viaje a la vez
  const activo = await pool.query(
    `SELECT id FROM viajes WHERE conductor_id = $1 AND estado IN ('asignado','en_curso')`,
    [req.session.usuarioId]
  );
  if (activo.rows.length > 0) {
    return res.status(400).json({ error: 'Ya tienes un viaje en marcha. Termínalo antes de aceptar otro.' });
  }

  const { rows } = await pool.query(
    `UPDATE viajes SET conductor_id = $1, estado = 'asignado', asignado_en = NOW()
     WHERE id = $2 AND estado = 'solicitado'
     RETURNING *`,
    [req.session.usuarioId, req.params.id]
  );
  if (rows.length === 0) {
    return res.status(409).json({ error: 'Este viaje ya fue aceptado por otro conductor o cancelado.' });
  }
  res.json({ ok: true, viaje: rows[0] });
});

// El conductor consulta su viaje activo, con el nombre del pasajero
app.get('/api/conductor/viaje-actual', requiereConductor, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT v.*, p.nombre AS pasajero_nombre
     FROM viajes v
     JOIN pasajeros p ON p.id = v.pasajero_id
     WHERE v.conductor_id = $1 AND v.estado IN ('asignado','en_curso')
     ORDER BY v.solicitado_en DESC LIMIT 1`,
    [req.session.usuarioId]
  );
  res.json({ viaje: rows[0] || null });
});

// He llegado y recogido al pasajero: el viaje comienza
app.post('/api/conductor/viaje/:id/iniciar', requiereConductor, conductorAprobado, async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE viajes SET estado = 'en_curso'
     WHERE id = $1 AND conductor_id = $2 AND estado = 'asignado'
     RETURNING id`,
    [req.params.id, req.session.usuarioId]
  );
  if (rows.length === 0) return res.status(400).json({ error: 'No se pudo iniciar este viaje.' });
  res.json({ ok: true });
});

// Viaje terminado
app.post('/api/conductor/viaje/:id/finalizar', requiereConductor, conductorAprobado, async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE viajes SET estado = 'finalizado', finalizado_en = NOW()
     WHERE id = $1 AND conductor_id = $2 AND estado = 'en_curso'
     RETURNING id`,
    [req.params.id, req.session.usuarioId]
  );
  if (rows.length === 0) return res.status(400).json({ error: 'No se pudo finalizar este viaje.' });
  res.json({ ok: true });
});

// ------------------------------------------------------------
// 7. SESIÓN (común a todos los roles)
// ------------------------------------------------------------
app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/sesion', (req, res) => {
  if (!req.session.usuarioId) return res.json({ rol: null });
  res.json({ rol: req.session.rol });
});

// ------------------------------------------------------------
// 8. ARRANQUE
// ------------------------------------------------------------
inicializarBaseDeDatos()
  .then(() => {
    app.listen(PORT, () => console.log(`Taxi-AV escuchando en el puerto ${PORT}`));
  })
  .catch((err) => {
    console.error('No se pudo inicializar la base de datos:', err);
    process.exit(1);
  });
