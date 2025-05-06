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
// RUTA GET: muestra la pantalla en blanco al entrar
app.get('/ventaxdia', (req, res) => {
  // versión “vacía” de resumenMovs para que el EJS nunca choque
  const emptyGroups = { A3: [], A4: [] };
  const resumenVacio = {
    carga:  { A3: [], A4: [] },
    vacio:  { A3: [], A4: [] },
    lleno:  { A3: [], A4: [] }
  };
  // Lo mismo para el resumen final (sum cero)
  const resumenSum = { carga: { A3:0, A4:0 }, vacio: { A3:0, A4:0 }, lleno: { A3:0, A4:0 } };
  // Y notificaciones neutras
  const notiVacia = { A3:{ tipo:'ok', diff:0 }, A4:{ tipo:'ok', diff:0 } };

  res.render('ventaxdia', {
    title: 'Venta por Día',
    resultados: null,
    parametros: {},
    // Para que EJS encuentre siempre el objeto
    detalleMovs: resumenVacio,
    resumenMovs: resumenSum,
    notificaciones: notiVacia,
    // Totales y precios pueden quedar a 0
    totales: { debe:0, venta:0, cobrado_ctdo:0, cobrado_ccte:0, bidones_bajados:0 },
    priceA3: 0,
    priceA4: 0
  });
});


// RUTA POST: el procesamiento real
app.post('/ventaxdia', async (req, res) => {
  try {
    const { cod_rep, fecha, cod_zona } = req.body;
    if (!cod_rep || !fecha || !cod_zona) {
      return res.status(400).send('Todos los campos son requeridos.');
    }

    // 1) Consulta principal
    const [results] = await req.db.query(`
      SELECT 
        hc.cod_cliente,
        sh.nom_cliente,
        hc.cod_prod,
        SUM(hc.debe)        AS debe_total,
        hc.venta,
        hc.cobrado_ctdo,
        hc.cobrado_ccte,
        hc.bidones_bajados,
        hc.motivo,
        hh_max.secuencia
      FROM soda_hoja_completa hc
      INNER JOIN (
        SELECT cod_cliente, MAX(secuencia) AS secuencia
        FROM soda_hoja_header
        GROUP BY cod_cliente
      ) hh_max 
        ON hc.cod_cliente = hh_max.cod_cliente
      INNER JOIN soda_hoja_header sh 
        ON sh.cod_cliente = hc.cod_cliente 
       AND sh.secuencia  = hh_max.secuencia
      WHERE 
        hc.cod_rep   = ? 
        AND hc.fecha    = ? 
        AND hc.cod_zona = ?
      GROUP BY 
        hc.cod_cliente, sh.nom_cliente, hc.cod_prod,
        hc.venta, hc.cobrado_ctdo, hc.cobrado_ccte,
        hc.bidones_bajados, hc.motivo, hh_max.secuencia
      ORDER BY hh_max.secuencia ASC
    `, [cod_rep, fecha, cod_zona]);

    // 2) Totales generales
    let totalDebe = 0, totalVenta = 0, totalCobradoCDTO = 0, totalCobradoCCTE = 0, totalBidones = 0;
    results.forEach(r => {
      totalDebe        += parseFloat(r.debe_total)    || 0;
      totalVenta       += parseFloat(r.venta)         || 0;
      totalCobradoCDTO += parseFloat(r.cobrado_ctdo)  || 0;
      totalCobradoCCTE += parseFloat(r.cobrado_ccte)  || 0;
      totalBidones     += parseFloat(r.bidones_bajados) || 0;
    });

    // 3) Precios A3 / A4
    const [prices] = await req.db.query('SELECT cod_prod, precio FROM soda_precios');
    let priceA3 = 0, priceA4 = 0;
    prices.forEach(p => {
      if (p.cod_prod === 'A3') priceA3 = parseFloat(p.precio) || 0;
      if (p.cod_prod === 'A4') priceA4 = parseFloat(p.precio) || 0;
    });

    // 4) Movimientos de soda_cardes
    const [movsRaw] = await req.db.query(`
      SELECT movimiento, cod_prod, cantidad
      FROM soda_cardes
      WHERE cod_rep = ? AND fecha = ? AND cod_zona = ?
    `, [cod_rep, fecha, cod_zona]);

    // 5) Armar resumenMovs
    const detalleMovs = { carga:{A3:[],A4:[]}, vacio:{A3:[],A4:[]}, lleno:{A3:[],A4:[]} };
    movsRaw.forEach(r => {
      if (detalleMovs[r.movimiento] && detalleMovs[r.movimiento][r.cod_prod] !== undefined) {
        detalleMovs[r.movimiento][r.cod_prod].push(+r.cantidad);
      }
    });
    const resumenMovs = { carga:{}, vacio:{}, lleno:{} };
    Object.keys(detalleMovs).forEach(m => {
      ['A3','A4'].forEach(prod => {
        const arr = detalleMovs[m][prod];
        resumenMovs[m][prod] = { values: arr, sum: arr.reduce((a,b)=>a+b,0) };
      });
    });

    // 6) Préstamo / recupero
    const notificaciones = {};
    ['A3','A4'].forEach(prod => {
      const c = resumenMovs.carga[prod].sum;
      const f = resumenMovs.vacio[prod].sum + resumenMovs.lleno[prod].sum;
      notificaciones[prod] = f < c
        ? { tipo:'presto', diff:c-f }
        : f > c
          ? { tipo:'recupero', diff:f-c }
          : { tipo:'ok', diff:0 };
    });

    // 7) Rendiciones cobradas
    const [rendiciones] = await req.db.query(`
      SELECT rub.descripcion, r.importe
      FROM soda_rendiciones r
      JOIN soda_rubros_rendiciones rub
        ON r.cod_gasto = rub.cod
      WHERE r.cod_rep = ? AND r.fecha = ?
    `, [cod_rep, fecha]);
    
    // 7.1) Calcular total de rendiciones
      const totalRendiciones = rendiciones
      .reduce((sum, r) => sum + (parseFloat(r.importe) || 0), 0);

    // 8) Render único
    res.render('ventaxdia', {
      title: 'Venta por Día',
      resultados: results,
      parametros: { cod_rep, fecha, cod_zona },
      totales: {
        debe: totalDebe,
        venta: totalVenta,
        cobrado_ctdo: totalCobradoCDTO,
        cobrado_ccte: totalCobradoCCTE,
        bidones_bajados: totalBidones
      },
      priceA3,
      priceA4,
      resumenMovs,
      notificaciones,
      rendiciones,
      totalRendiciones
    });

  } catch (err) {
    console.error('Error ejecutando la consulta:', err);
    if (!res.headersSent) res.status(500).send('Error en el servidor.');
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


app.get('/hojaruta', async (req, res) => {
  try {
    const { cod_rep, cod_zona, mes, anio } = req.query;
    if (!cod_rep || !cod_zona || !mes || !anio) {
      return res.render('hojaruta', { title: 'Hoja Ruta', data: [], params: {} });
    }

    const sql = `
      SELECT 
        hh.cod_cliente,
        hh.nom_cliente,
        hc.cod_prod,
        FLOOR((DAY(STR_TO_DATE(hc.fecha,'%Y-%m-%d'))-1)/7)+1 AS semana,
        hh.saldiA3,
        hh.saldiA4,
        SUM(hc.venta)       AS venta,
        SUM(hc.cobrado_ctdo) AS cobrado_ctdo,
        SUM(hc.cobrado_ccte) AS cobrado_ccte,
        hh.secuencia
      FROM soda_hoja_header hh
      LEFT JOIN soda_hoja_completa hc
        ON hh.cod_rep      = hc.cod_rep
       AND hh.cod_zona    = hc.cod_zona
       AND hh.cod_cliente = hc.cod_cliente
       AND MONTH(STR_TO_DATE(hc.fecha,'%Y-%m-%d')) = ?
       AND YEAR(STR_TO_DATE(hc.fecha,'%Y-%m-%d'))  = ?
      WHERE hh.cod_rep   = ?
        AND hh.cod_zona = ?
      GROUP BY
        hh.cod_cliente,
        hh.nom_cliente,
        hc.cod_prod,
        semana,
        hh.saldiA3,
        hh.saldiA4,
        hh.secuencia
      ORDER BY
        hh.secuencia ASC,
        hh.nom_cliente,
        hc.cod_prod,
        semana;
    `;

    const [rows] = await req.db.query(sql, [mes, anio, cod_rep, cod_zona]);

    // Pivot: agrupar por cliente+producto
    const pivot = {};
    rows.forEach(r => {
      const key = `${r.cod_cliente}-${r.cod_prod}`;
      if (!pivot[key]) {
        pivot[key] = {
          cod_cliente: r.cod_cliente,
          nom_cliente: r.nom_cliente,
          cod_prod:    r.cod_prod,
          semanas:     { 1: {}, 2: {}, 3: {}, 4: {}, 5: {} }
        };
      }
      // escoge saldo inicial según producto
      const saldoInicial = r.cod_prod === 'A3'
        ? r.saldiA3
        : r.cod_prod === 'A4'
          ? r.saldiA4
          : 0;

      pivot[key].semanas[r.semana] = {
        saldo_inicial: Number(saldoInicial)   || 0,
        venta:         Number(r.venta)        || 0,
        cobrado_ctdo:  Number(r.cobrado_ctdo) || 0,
        cobrado_ccte:  Number(r.cobrado_ccte) || 0,
        resultado:     0
      };
    });

    // Calcular resultado acumulado por semana
    Object.values(pivot).forEach(client => {
      let acc = client.semanas[1].saldo_inicial || 0;
      for (let w = 1; w <= 5; w++) {
        const s = client.semanas[w];
        s.resultado = acc + s.venta - s.cobrado_ctdo - s.cobrado_ccte;
        client.semanas[w] = s;
        acc = s.resultado;
      }
    });

    res.render('hojaruta', {
      title: 'Hoja Ruta',
      data:  Object.values(pivot),
      params:{ cod_rep, cod_zona, mes, anio }
    });
  } catch (err) {
    console.error('Error en /hojaruta:', err);
    res.status(500).send('Error en el servidor');
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
