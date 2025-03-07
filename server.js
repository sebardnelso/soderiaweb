// app.js
const express = require('express');
const path = require('path');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise'); // Usamos la versión promise

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Configurar EJS como motor de vistas
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware para servir archivos estáticos
app.use(express.static(path.join(__dirname, 'public')));

// Middleware para parsear cuerpos de peticiones
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Crear un pool de conexiones
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Hacer que el pool esté disponible en todas las rutas
app.use((req, res, next) => {
  req.db = pool;
  next();
});

// Ruta para mostrar el formulario de login
app.get('/login', (req, res) => {
  res.render('login', { title: 'Login' });
});

// Ruta para procesar el login
app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).send('Debe ingresar usuario y contraseña.');
    }

    const [rows] = await req.db.query(
      'SELECT * FROM usuario WHERE nombre = ? AND password = ?',
      [username, password]
    );

    if (rows.length > 0) {
      // Login correcto
      res.redirect('/menu');
    } else {
      // Login incorrecto
      res.redirect('/login');
    }
  } catch (err) {
    console.error('Error en la consulta de usuario:', err);
    res.status(500).send('Error en el servidor.');
  }
});

// Ruta para mostrar el menú
app.get('/menu', (req, res) => {
  res.render('menu', { title: 'Menú' });
});

// Ruta GET para renderizar el formulario ventaxdia
app.get('/ventaxdia', (req, res) => {
  res.render('ventaxdia', {
    title: 'Venta por Día',
    resultados: null,
    parametros: {}
  });
});

// Ruta POST para ventaxdia con async/await
app.post('/ventaxdia', async (req, res) => {
  try {
    const { cod_rep, fecha, cod_zona } = req.body;
    if (!cod_rep || !fecha || !cod_zona) {
      return res.status(400).send('Todos los campos son requeridos.');
    }

    const query = `
      SELECT 
        hc.cod_cliente,
        sh.nom_cliente,
        hc.cod_prod,
        SUM(hl.debe) AS debe_total,
        hc.venta,
        hc.cobrado_ctdo,
        hc.cobrado_ccte,
        hc.bidones_bajados,
        hc.motivo,
        hh_max.secuencia
      FROM 
        soda_hoja_completa hc
      INNER JOIN 
        soda_hoja_linea hl ON hc.cod_cliente = hl.cod_cliente
      INNER JOIN 
        (
          SELECT cod_cliente, MAX(secuencia) AS secuencia
          FROM soda_hoja_header
          GROUP BY cod_cliente
        ) hh_max ON hc.cod_cliente = hh_max.cod_cliente
      INNER JOIN
        soda_hoja_header sh ON sh.cod_cliente = hc.cod_cliente AND sh.secuencia = hh_max.secuencia
      WHERE 
        hc.cod_rep = ? AND 
        hc.fecha = ? AND 
        hc.cod_zona = ?
      GROUP BY 
        hc.cod_cliente, sh.nom_cliente, hc.cod_prod, hc.venta, hc.cobrado_ctdo, hc.cobrado_ccte, hc.bidones_bajados, hc.motivo, hh_max.secuencia
      ORDER BY 
        hh_max.secuencia
    `;

    const [results] = await req.db.query(query, [cod_rep, fecha, cod_zona]);

    // Calcular totales
    let totalVenta = 0;
    let totalCobradoCDTO = 0;
    let totalCobradoCCTE = 0;
    let totalBidonesBajados = 0;

    results.forEach(row => {
      totalVenta += parseFloat(row.venta) || 0;
      totalCobradoCDTO += parseFloat(row.cobrado_ctdo) || 0;
      totalCobradoCCTE += parseFloat(row.cobrado_ccte) || 0;
      totalBidonesBajados += parseFloat(row.bidones_bajados) || 0;
    });

    res.render('ventaxdia', {
      title: 'Venta por Día',
      resultados: results,
      parametros: { cod_rep, fecha, cod_zona },
      totales: {
        venta: totalVenta,
        cobrado_ctdo: totalCobradoCDTO,
        cobrado_ccte: totalCobradoCCTE,
        bidones_bajados: totalBidonesBajados
      }
    });
  } catch (err) {
    console.error('Error ejecutando la consulta:', err);
    res.status(500).send('Error en el servidor.');
  }
});

// Ruta GET para clientenuevo
app.get('/clientenuevo', async (req, res) => {
  try {
    const query = `
      SELECT id, razon, localidad, celular, bidon, cantidad, numzona, secuencia, pago
      FROM clientenuevo
    `;
    const [results] = await req.db.query(query);
    res.render('clientenuevo', { title: 'Clientes Nuevos', resultados: results });
  } catch (err) {
    console.error('Error al consultar clientenuevo:', err);
    res.status(500).send('Error en el servidor.');
  }
});

// Ruta POST para eliminar un cliente nuevo por id
app.post('/clientenuevo/eliminar/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const query = `DELETE FROM clientenuevo WHERE id = ?`;
    await req.db.query(query, [id]);
    res.redirect('/clientenuevo');
  } catch (err) {
    console.error("Error al eliminar el registro:", err);
    res.status(500).send("Error en el servidor.");
  }
});

// Ruta raíz (redirige a login)
app.get('/', (req, res) => {
  res.redirect('/login');
});

// Middleware de manejo de errores
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send('Algo salió mal!');
});

// Iniciar el servidor
app.listen(port, () => {
  console.log(`Servidor escuchando en http://localhost:${port}`);
});
