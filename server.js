// app.js
const express = require('express');
const path = require('path');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise'); // Usamos la versión promise
const session = require('express-session');
const app = express();
const port = process.env.PORT || 3000;

app.use(session({
  secret: 'S1e7b0@3',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false } // en producción poné secure: true solo con HTTPS
}));

dotenv.config();



// Configurar EJS como motor de vistas
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
const expressLayouts = require('express-ejs-layouts');
app.use(expressLayouts);
app.set('layout', 'layout'); // layout.ejs por defecto

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
  queueLimit: 0,
  connectTimeout: 10000,
  // ✅ Previene desconexiones
  enableKeepAlive: true,
  keepAliveInitialDelay: 0
});

// Hacer que el pool esté disponible en todas las rutas
app.use((req, res, next) => {
  req.db = pool;
  next();
});
function verificarLogin(req, res, next) {
  if (req.session.usuario) {
    return next();
  } else {
    return res.redirect('/login');
  }
}
// Mostrar el formulario de login
app.get('/login', (req, res) => {
  res.render('login', {
  title: 'Login',
  error: null,
  layout: 'layout-login'
});
});

// Procesar el formulario de login
app.post('/login', async (req, res) => {
  const { nombre, password } = req.body;

  const [result] = await req.db.query(
    'SELECT * FROM usuario WHERE nombre = ? AND password = ?',
    [nombre, password]
  );

  if (result.length > 0) {
    req.session.usuario = result[0].nombre;
    res.redirect('/menu');
  } else {
    res.render('login', { title: 'Login', error: 'Usuario o contraseña incorrectos' });
  }
});


// Ruta para mostrar el formulario de login
app.get('/clientes', (req, res) => {
  res.render('clientes', { title: 'clientes' });
});




// Ruta para mostrar el menú
app.get('/menu', verificarLogin,(req, res) => {
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


app.post('/ventaxdia', verificarLogin,async (req, res) => {
  try {
    const { cod_rep, fecha, cod_zona } = req.body;
    if (!cod_rep || !fecha || !cod_zona) {
      return res.status(400).send('Todos los campos son requeridos.');
    }

    const [results] = await req.db.query(
      `SELECT
         hl.cod_cliente,
         sh.nom_cliente,
         hl.cod_prod,
         COALESCE(hc_sum.debe_total,
           CASE WHEN hl.cod_prod='A3' THEN sh.saldiA3
                WHEN hl.cod_prod='A4' THEN sh.saldiA4
                ELSE 0 END
         ) AS debe_total,
         COALESCE(hc_sum.venta,0)        AS venta,
         COALESCE(hc_sum.cobrado_ctdo,0) AS cobrado_ctdo,
         COALESCE(hc_sum.cobrado_ccte,0) AS cobrado_ccte,
         COALESCE(hc_sum.bidones,0)      AS bidones_bajados,
         hc_sum.motivo,
         sh.secuencia
       FROM
        ( SELECT DISTINCT cod_cliente, cod_prod
          FROM soda_hoja_linea
          WHERE cod_rep=? AND cod_zona=? AND cod_prod IN('A3','A4','DIS')
        ) hl
       JOIN
        ( SELECT sh2.cod_cliente, sh2.nom_cliente, sh2.saldiA3, sh2.saldiA4, sh2.secuencia
          FROM soda_hoja_header sh2
          INNER JOIN (
            SELECT cod_cliente, MAX(secuencia) AS secuencia
            FROM soda_hoja_header
            WHERE cod_rep=? AND cod_zona=?
            GROUP BY cod_cliente
          ) hm 
            ON hm.cod_cliente=sh2.cod_cliente 
           AND hm.secuencia  =sh2.secuencia
        ) sh 
          ON sh.cod_cliente=hl.cod_cliente
       LEFT JOIN
        (
          SELECT 
            cod_cliente, cod_prod,
            SUM(debe)        AS debe_total,
            SUM(venta)       AS venta,
            SUM(cobrado_ctdo)AS cobrado_ctdo,
            SUM(cobrado_ccte)AS cobrado_ccte,
            SUM(bidones_bajados) AS bidones,
            GROUP_CONCAT(DISTINCT motivo) AS motivo
          FROM (
            SELECT DISTINCT
              cod_rep, fecha, cod_zona,
              cod_cliente, cod_prod,
              debe, venta, cobrado_ctdo, cobrado_ccte, bidones_bajados, motivo
            FROM soda_hoja_completa
            WHERE cod_rep=? AND fecha=? AND cod_zona=?
          ) AS distinct_rows
          GROUP BY cod_cliente, cod_prod
        ) hc_sum
          ON hc_sum.cod_cliente=hl.cod_cliente
         AND hc_sum.cod_prod   =hl.cod_prod
       ORDER BY sh.secuencia ASC
      `,
      [cod_rep, cod_zona, cod_rep, cod_zona, cod_rep, fecha, cod_zona]
    );

    let totalDebe = 0, totalVenta = 0, totalCobCD = 0, totalCobCC = 0, totalBid = 0;
    const detalleCobranzaA3 = [];
    const detalleCobranzaA4 = [];

    results.forEach(r => {
      totalDebe  += +r.debe_total    || 0;
      totalVenta += +r.venta         || 0;
      totalCobCD += +r.cobrado_ctdo  || 0;
      totalCobCC += +r.cobrado_ccte  || 0;
      totalBid   += +r.bidones_bajados|| 0;

      if (r.cod_prod === 'A3' && r.cobrado_ccte > 0) {
        detalleCobranzaA3.push({ cod_cliente: r.cod_cliente, cobrado: Number(r.cobrado_ccte) });
      }
      if (r.cod_prod === 'A4' && r.cobrado_ccte > 0) {
        detalleCobranzaA4.push({ cod_cliente: r.cod_cliente, cobrado: Number(r.cobrado_ccte) });
      }
    });

    const [prices] = await req.db.query(`SELECT cod_prod, precio FROM soda_precios`);
    let priceA3 = 0, priceA4 = 0;
    prices.forEach(p => {
      if (p.cod_prod === 'A3') priceA3 = +p.precio;
      if (p.cod_prod === 'A4') priceA4 = +p.precio;
    });

    const [movsRaw] = await req.db.query(
      `SELECT movimiento, cod_prod, cantidad
       FROM soda_cardes
       WHERE cod_rep=? AND fecha=? AND cod_zona=?`,
      [cod_rep, fecha, cod_zona]
    );
    const detalleMovs = { carga:{A3:[],A4:[]}, vacio:{A3:[],A4:[]}, lleno:{A3:[],A4:[]} };
    movsRaw.forEach(r => {
      if (detalleMovs[r.movimiento] && detalleMovs[r.movimiento][r.cod_prod] !== undefined) {
        detalleMovs[r.movimiento][r.cod_prod].push(+r.cantidad);
      }
    });
    const resumenMovs = {};
    ['carga','vacio','lleno'].forEach(mov => {
      resumenMovs[mov] = {};
      ['A3','A4'].forEach(prod => {
        const arr = detalleMovs[mov][prod];
        resumenMovs[mov][prod] = { values: arr, sum: arr.reduce((a,b)=>a+b,0) };
      });
    });

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

    const [rendiciones] = await req.db.query(
      `SELECT rub.descripcion, r.importe
       FROM soda_rendiciones r
       JOIN soda_rubros_rendiciones rub ON r.cod_gasto=rub.cod
       WHERE r.cod_rep=? AND r.fecha=?`,
      [cod_rep, fecha]
    );
    const totalRendiciones = rendiciones.reduce((s,r)=>s+(+r.importe||0),0);

    res.render('ventaxdia', {
      title: 'Venta por Día',
      resultados: results,
      parametros: { cod_rep, fecha, cod_zona },
      totales: {
        debe: totalDebe,
        venta: totalVenta,
        cobrado_ctdo: totalCobCD,
        cobrado_ccte: totalCobCC,
        bidones_bajados: totalBid
      },
      priceA3,
      priceA4,
      resumenMovs,
      notificaciones,
      rendiciones,
      totalRendiciones,
      detalleCobranzaA3,
      detalleCobranzaA4
    });

  } catch (err) {
    console.error('Error en /ventaxdia:', err);
    if (!res.headersSent) res.status(500).send('Error en el servidor.');
  }
});







// Ruta GET para clientenuevo
app.get('/clientenuevo', verificarLogin,async (req, res) => {
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


app.get('/hojaruta', verificarLogin, async (req, res) => {
  try {
    const { cod_rep, cod_zona, mes_desde, mes_hasta, anio } = req.query;
    if (!cod_rep || !cod_zona || !mes_desde || !mes_hasta || !anio) {
      return res.render('hojaruta', { title: 'Hoja Ruta', data: [], params: {} });
    }

    // Buscar los saldos iniciales por cliente y producto según el primer día encontrado
    const [saldosIniciales] = await req.db.query(
      `SELECT 
        cod_cliente, cod_prod, MIN(STR_TO_DATE(fecha, '%Y-%m-%d')) AS fecha_min
      FROM soda_hoja_completa
      WHERE cod_rep = ? AND cod_zona = ?
        AND MONTH(STR_TO_DATE(fecha, '%Y-%m-%d')) BETWEEN ? AND ?
        AND YEAR(STR_TO_DATE(fecha, '%Y-%m-%d')) = ?
      GROUP BY cod_cliente, cod_prod`,
      [cod_rep, cod_zona, mes_desde, mes_hasta, anio]
    );

    const saldosMap = {};
    for (const s of saldosIniciales) {
      const [debeRow] = await req.db.query(
        `SELECT debe FROM soda_hoja_completa 
         WHERE cod_cliente = ? AND cod_prod = ? AND STR_TO_DATE(fecha, '%Y-%m-%d') = ?
         LIMIT 1`,
        [s.cod_cliente, s.cod_prod, s.fecha_min]
      );
      if (debeRow.length) {
        saldosMap[`${s.cod_cliente}-${s.cod_prod}`] = Number(debeRow[0].debe) || 0;
      }
    }

    const [rows] = await req.db.query(
      `SELECT 
        hh.cod_cliente,
        hh.nom_cliente,
        hc.cod_prod,
        MONTH(STR_TO_DATE(hc.fecha,'%Y-%m-%d')) AS mes,
        FLOOR((DAY(STR_TO_DATE(hc.fecha,'%Y-%m-%d'))-1)/7)+1 AS semana,
        SUM(hc.venta)         AS venta,
        SUM(hc.cobrado_ctdo)  AS cobrado_ctdo,
        SUM(hc.cobrado_ccte)  AS cobrado_ccte,
        hh.secuencia
      FROM soda_hoja_header hh
      LEFT JOIN soda_hoja_completa hc
        ON hh.cod_rep      = hc.cod_rep
       AND hh.cod_zona    = hc.cod_zona
       AND hh.cod_cliente = hc.cod_cliente
       AND MONTH(STR_TO_DATE(hc.fecha,'%Y-%m-%d')) BETWEEN ? AND ?
       AND YEAR(STR_TO_DATE(hc.fecha,'%Y-%m-%d')) = ?
      WHERE hh.cod_rep   = ?
        AND hh.cod_zona = ?
      GROUP BY
        hh.cod_cliente,
        hh.nom_cliente,
        hc.cod_prod,
        mes,
        semana,
        hh.secuencia
      ORDER BY
        hh.secuencia ASC,
        hh.nom_cliente,
        hc.cod_prod,
        mes,
        semana`,
      [mes_desde, mes_hasta, anio, cod_rep, cod_zona]
    );

    // 🔁 Construir estructura de datos pivot
    const pivot = {};
    const semanasUnicas = new Set(); // << agregamos esto

    rows.forEach(r => {
      const key = `${r.cod_cliente}-${r.cod_prod}`;
      const semKey = `${r.mes}-${r.semana}`;
      semanasUnicas.add(semKey); // << guardamos todas las semanas usadas

      if (!pivot[key]) {
        pivot[key] = {
          cod_cliente: r.cod_cliente,
          nom_cliente: r.nom_cliente,
          cod_prod:    r.cod_prod,
          semanas:     {}
        };
      }

      pivot[key].semanas[semKey] = {
        saldo_inicial: undefined,
        venta:         Number(r.venta) || 0,
        cobrado_ctdo:  Number(r.cobrado_ctdo) || 0,
        cobrado_ccte:  Number(r.cobrado_ccte) || 0,
        resultado:     0
      };
    });

    // 🔧 Asegurar que cada cliente-prod tenga TODAS las semanas (aunque no haya movimiento)
    Object.values(pivot).forEach(cli => {
      semanasUnicas.forEach(sem => {
        if (!cli.semanas[sem]) {
          cli.semanas[sem] = {
            saldo_inicial: undefined,
            venta: 0,
            cobrado_ctdo: 0,
            cobrado_ccte: 0,
            resultado: 0
          };
        }
      });
    });

    // ✅ Calcular resultados acumulando saldos por semana
    Object.values(pivot).forEach(cli => {
      const semanas = cli.semanas;
      const claves = Object.keys(semanas).sort((a, b) => {
        const [ma, wa] = a.split('-').map(Number);
        const [mb, wb] = b.split('-').map(Number);
        return ma === mb ? wa - wb : ma - mb;
      });

      let saldo = saldosMap[`${cli.cod_cliente}-${cli.cod_prod}`] || 0;
      claves.forEach(k => {
        const s = semanas[k];
        s.saldo_inicial = saldo;
        s.resultado = saldo + s.venta - s.cobrado_ctdo - s.cobrado_ccte;
        saldo = s.resultado;
      });
    });

    // Enviar a la vista
    res.render('hojaruta', {
      title: 'Hoja Ruta',
      data: Object.values(pivot),
      params: { cod_rep, cod_zona, mes_desde, mes_hasta, anio }
    });
  } catch (err) {
    console.error('Error en /hojaruta:', err);
    res.status(500).send('Error en el servidor');
  }
});




// RUTA CORREGIDA: /hojaruta/cliente
app.get('/hojaruta/cliente', async (req, res) => {
  try {
    const { cod_cliente, mes_desde, mes_hasta, anio } = req.query;

    if (!cod_cliente || !mes_desde || !mes_hasta || !anio) {
      return res.render('hojaruta', { title: 'Hoja Ruta', data: [], params: req.query });
    }

    // Obtener saldo inicial de cada producto desde la primera fecha encontrada
    const [saldos] = await req.db.query(`
      SELECT cod_prod, debe
      FROM soda_hoja_completa
      WHERE cod_cliente = ?
        AND MONTH(STR_TO_DATE(fecha,'%Y-%m-%d')) BETWEEN ? AND ?
        AND YEAR(STR_TO_DATE(fecha,'%Y-%m-%d')) = ?
      ORDER BY STR_TO_DATE(fecha,'%Y-%m-%d') ASC
    `, [cod_cliente, mes_desde, mes_hasta, anio]);

    let saldosIniciales = {};
    saldos.forEach(r => {
      if (!saldosIniciales[r.cod_prod]) {
        saldosIniciales[r.cod_prod] = Number(r.debe) || 0;
      }
    });

    const [rows] = await req.db.query(`
      SELECT 
        hh.cod_cliente,
        hh.nom_cliente,
        hc.cod_prod,
        MONTH(STR_TO_DATE(hc.fecha,'%Y-%m-%d')) AS mes,
        FLOOR((DAY(STR_TO_DATE(hc.fecha,'%Y-%m-%d'))-1)/7)+1 AS semana,
        SUM(hc.venta)         AS venta,
        SUM(hc.cobrado_ctdo)  AS cobrado_ctdo,
        SUM(hc.cobrado_ccte)  AS cobrado_ccte,
        hh.secuencia
      FROM soda_hoja_header hh
      LEFT JOIN soda_hoja_completa hc
        ON hh.cod_cliente = hc.cod_cliente
       AND MONTH(STR_TO_DATE(hc.fecha,'%Y-%m-%d')) BETWEEN ? AND ?
       AND YEAR(STR_TO_DATE(hc.fecha,'%Y-%m-%d')) = ?
      WHERE hh.cod_cliente = ?
      GROUP BY
        hh.cod_cliente, hh.nom_cliente, hc.cod_prod, mes, semana,
        hh.secuencia
      ORDER BY
        hh.secuencia, hh.nom_cliente, hc.cod_prod, mes, semana
    `, [mes_desde, mes_hasta, anio, cod_cliente]);

    const pivot = {};
    rows.forEach(r => {
      const key = `${r.cod_cliente}-${r.cod_prod}`;
      const semKey = `${r.mes}-${r.semana}`;
      if (!pivot[key]) {
        pivot[key] = {
          cod_cliente: r.cod_cliente,
          nom_cliente: r.nom_cliente,
          cod_prod:    r.cod_prod,
          semanas:     {}
        };
      }
      pivot[key].semanas[semKey] = {
        venta: Number(r.venta) || 0,
        cobrado_ctdo: Number(r.cobrado_ctdo) || 0,
        cobrado_ccte: Number(r.cobrado_ccte) || 0,
        resultado: 0
      };
    });

    Object.values(pivot).forEach(cli => {
      const claves = Object.keys(cli.semanas).sort((a, b) => {
        const [ma, wa] = a.split('-').map(Number);
        const [mb, wb] = b.split('-').map(Number);
        return ma === mb ? wa - wb : ma - mb;
      });

      let saldo = saldosIniciales[cli.cod_prod] || 0;
      claves.forEach(k => {
        const s = cli.semanas[k];
        s.saldo_inicial = saldo;
        s.resultado = saldo + s.venta - s.cobrado_ctdo - s.cobrado_ccte;
        saldo = s.resultado;
        cli.semanas[k] = s;
      });
    });

    res.render('hojaruta', {
      title: 'Hoja Ruta',
      data: Object.values(pivot),
      params: req.query
    });
  } catch (err) {
    console.error('Error en /hojaruta/cliente:', err);
    res.status(500).send('Error en el servidor');
  }
});


// 1. BACKEND: Rutas en app.js o cobranza.js (si lo separás por módulos)

app.get('/cobranza', async (req, res) => {
  try {
    const [rubros] = await req.db.query('SELECT * FROM soda_rubros_rendiciones ORDER BY cod');
    const [cobranzas] = await req.db.query(
      `SELECT r.id, r.fecha, r.cod_rep, r.cod_gasto, rub.descripcion, r.importe 
       FROM soda_rendiciones r
       JOIN soda_rubros_rendiciones rub ON r.cod_gasto = rub.cod
       WHERE r.fecha = CURDATE()`
    );

    res.render('cobranza', { title: 'Cobranza', rubros, cobranzas });
  } catch (err) {
    console.error('Error en /cobranza:', err);
    res.status(500).send('Error en el servidor.');
  }
});

app.post('/cobranza/agregar', async (req, res) => {
  try {
    const { cod_rep, cod_gasto, importe } = req.body;
    await req.db.query(
      'INSERT INTO soda_rendiciones (fecha, cod_rep, cod_gasto, importe) VALUES (CURDATE(), ?, ?, ?)',
      [cod_rep, cod_gasto, importe]
    );
    res.redirect('/cobranza');
  } catch (err) {
    console.error('Error al agregar cobranza:', err);
    res.status(500).send('Error al agregar cobranza.');
  }
});

app.post('/cobranza/eliminar/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await req.db.query('DELETE FROM soda_rendiciones WHERE id = ?', [id]);
    res.redirect('/cobranza');
  } catch (err) {
    console.error('Error al eliminar:', err);
    res.status(500).send('Error al eliminar.');
  }
});

app.post('/cobranza/modificar', async (req, res) => {
  try {
    const { id, cod_rep, cod_gasto, importe } = req.body;
    await req.db.query(
      `UPDATE soda_rendiciones 
       SET cod_rep = ?, cod_gasto = ?, importe = ?
       WHERE id = ?`,
      [cod_rep, cod_gasto, importe, id]
    );
    res.redirect('/cobranza');
  } catch (err) {
    console.error('Error al modificar cobranza:', err);
    res.status(500).send('Error al modificar.');
  }
});

// app.js (o server.js)

// GET /liquidaciones — muestra formulario y, si vienen parámetros, los resultados
// app.js o server.js

// GET /liquidaciones — muestra formulario y, si vienen parámetros, los resultados
// BACKEND COMPLETO
app.get('/liquidaciones', verificarLogin,async (req, res) => {
  try {
    const { cod_rep, fecha_desde, fecha_hasta } = req.query;

    const parametros = {
      cod_rep:     cod_rep     || '',
      fecha_desde: fecha_desde || '',
      fecha_hasta: fecha_hasta || ''
    };

    let rendiciones = [];
    let ventas = [];
    let totalBidones = 0;
    let diferencias = [];
    let resumenPorProducto = {
      A3: { contado: 0, ccte: 0 },
      A4: { contado: 0, ccte: 0 }
    };

    let totalCobrado = 0;
    let subtotal20 = 0;
    let totalAdelantos = 0;
    let totalDiferencias = 0;
    let totalFinal = 0;

    if (cod_rep !== undefined && fecha_desde && fecha_hasta) {
      // Adelantos
      if (cod_rep === '0') {
        [rendiciones] = await req.db.query(
          `SELECT r.fecha, rub.descripcion, r.importe 
           FROM soda_rendiciones r
           JOIN soda_rubros_rendiciones rub ON r.cod_gasto = rub.cod
           WHERE r.cod_gasto = 12
             AND r.fecha BETWEEN ? AND ?
           ORDER BY r.fecha`,
          [fecha_desde, fecha_hasta]
        );
      } else {
        [rendiciones] = await req.db.query(
          `SELECT r.fecha, rub.descripcion, r.importe 
           FROM soda_rendiciones r
           JOIN soda_rubros_rendiciones rub ON r.cod_gasto = rub.cod
           WHERE r.cod_rep = ? AND r.cod_gasto = 12
             AND r.fecha BETWEEN ? AND ?
           ORDER BY r.fecha`,
          [cod_rep, fecha_desde, fecha_hasta]
        );
      }

      totalAdelantos = rendiciones.reduce((sum, r) => sum + Number(r.importe), 0);

      const condition = cod_rep === '0' ? '1=1' : 'hc.cod_rep = ?';
      const params = cod_rep === '0'
        ? [fecha_desde, fecha_hasta]
        : [cod_rep, fecha_desde, fecha_hasta];

      const [rawData] = await req.db.query(
        `SELECT hc.fecha, hc.cod_prod, hc.cod_rep, hc.cod_zona, hc.cod_cliente,
                hc.venta, hc.cobrado_ctdo, hc.cobrado_ccte,
                hc.bidones_bajados,
                (hc.cobrado_ctdo * p.precio) AS monto_ctdo,
                (hc.cobrado_ccte * p.precio) AS monto_ccte
         FROM soda_hoja_completa hc
         JOIN soda_precios p ON hc.cod_prod = p.cod_prod
         WHERE ${condition} AND hc.fecha BETWEEN ? AND ?
         ORDER BY hc.fecha, hc.cod_prod`,
        params
      );

      const vistos = new Set();
      const sinDuplicados = [];

      rawData.forEach(r => {
        const key = `${r.cod_rep}_${r.cod_prod}_${r.cod_zona}_${r.cod_cliente}_${r.fecha.toISOString().slice(0,10)}`;
        if (!vistos.has(key)) {
          vistos.add(key);
          sinDuplicados.push(r);
        }
      });

      const agrupadas = {};

      sinDuplicados.forEach(v => {
        const key = `${v.fecha.toISOString().slice(0,10)}_${v.cod_prod}`;
        if (!agrupadas[key]) {
          agrupadas[key] = {
            fecha: v.fecha,
            cod_prod: v.cod_prod,
            cantidad: 0,
            cobrado_ctdo: 0,
            cobrado_ccte: 0,
            bidones_vendidos: 0,
            monto_ctdo: 0,
            monto_ccte: 0
          };
        }
        agrupadas[key].cantidad         += Number(v.venta);
        agrupadas[key].cobrado_ctdo     += Number(v.cobrado_ctdo);
        agrupadas[key].cobrado_ccte     += Number(v.cobrado_ccte);
        agrupadas[key].bidones_vendidos += Number(v.bidones_bajados);
        agrupadas[key].monto_ctdo       += Number(v.monto_ctdo);
        agrupadas[key].monto_ccte       += Number(v.monto_ccte);
      });

      ventas = Object.values(agrupadas);

      totalCobrado = ventas.reduce((sum, v) => sum + v.monto_ctdo + v.monto_ccte, 0);
      subtotal20 = totalCobrado * 0.2;
      totalBidones = ventas.reduce((sum, v) => sum + v.cantidad, 0); // ahora suma venta, no bidones

      // Rendidas por día
      let rendidasPorDia = [];

      if (cod_rep === '0') {
        [rendidasPorDia] = await req.db.query(
          `SELECT fecha, SUM(importe) AS rendido
           FROM soda_rendiciones
           WHERE fecha BETWEEN ? AND ?
           GROUP BY fecha`,
          [fecha_desde, fecha_hasta]
        );
      } else {
        [rendidasPorDia] = await req.db.query(
          `SELECT fecha, SUM(importe) AS rendido
           FROM soda_rendiciones
           WHERE cod_rep = ? AND fecha BETWEEN ? AND ?
           GROUP BY fecha`,
          [cod_rep, fecha_desde, fecha_hasta]
        );
      }

      const mapaRendidas = {};
      rendidasPorDia.forEach(r => {
        mapaRendidas[r.fecha.toISOString().slice(0, 10)] = Number(r.rendido);
      });

      const diferenciaPorDia = {};
      ventas.forEach(v => {
        const fechaKey = v.fecha.toISOString().slice(0, 10);
        const totalDia = v.monto_ctdo + v.monto_ccte;
        if (!diferenciaPorDia[fechaKey]) diferenciaPorDia[fechaKey] = 0;
        diferenciaPorDia[fechaKey] += totalDia;
      });

      diferencias = Object.entries(diferenciaPorDia).map(([fecha, cobrado]) => {
        const rendido = mapaRendidas[fecha] || 0;
        return { fecha, cobrado, rendido, diferencia: rendido - cobrado };
      });

      totalDiferencias = diferencias.reduce((sum, d) => sum + d.diferencia, 0);
      totalFinal = subtotal20 - totalAdelantos + totalDiferencias;

      ventas.forEach(v => {
        if (v.cod_prod === 'A3' || v.cod_prod === 'A4') {
          resumenPorProducto[v.cod_prod].contado += v.cobrado_ctdo;
          resumenPorProducto[v.cod_prod].ccte    += v.cobrado_ccte;
        }
      });
    }

    res.render('liquidaciones', {
      title: 'Liquidaciones',
      parametros,
      rendiciones,
      ventas,
      diferencias,
      resumenPorProducto,
      totalBidones,
      totalCobrado,
      subtotal20,
      totalAdelantos,
      totalDiferencias,
      totalFinal
    });

  } catch (err) {
    console.error('Error en /liquidaciones:', err);
    res.status(500).send('Error en el servidor.');
  }
});



app.get('/clientes', verificarLogin,async (req, res) => {
  try {
    const [clientes] = await req.db.query(`SELECT cod_rep, cod_zona, fecha, orden, cod_cliente, nom_cliente, domicilio, localidad, celular, secuencia, saldiA3, saldiA4 FROM soda_hoja_header`);
    res.render('clientes', { clientes }); // si querés pasar la lista a un dropdown o tabla
  } catch (err) {
    console.error('Error al obtener clientes:', err);
    res.status(500).send('Error en el servidor.');
  }
});


app.post('/clientes/guardar', async (req, res) => {
  try {
    const data = req.body;

    const query = `INSERT INTO soda_hoja_header 
      (cod_rep, cod_zona, fecha, orden, cod_cliente, nom_cliente, domicilio, localidad, celular, secuencia, saldiA3, saldiA4)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

    await req.db.query(query, [
      data.cod_rep, data.cod_zona, data.fecha, data.orden,
      data.cod_cliente, data.nom_cliente, data.domicilio, data.localidad,
      data.celular, data.secuencia, data.saldiA3, data.saldiA4
    ]);

    // Insertar movimientos en soda_hoja_linea para A3 y A4
    const movimientos = [
      ['A3', data.saldiA3],
      ['A4', data.saldiA4]
    ];

    for (const [cod_prod, debe] of movimientos) {
      await req.db.query(`
        INSERT INTO soda_hoja_linea
        (cod_rep, cod_zona, orden, cod_cliente, cod_prod, debe, venta, cobrado_ctdo, cobrado_ccte)
        VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0)
      `, [
        data.cod_rep, data.cod_zona, data.orden, data.cod_cliente,
        cod_prod, debe
      ]);
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error('❌ Error al guardar cliente:', err);
    res.status(500).send('Error al guardar cliente.');
  }
});




app.post('/clientes/modificar', async (req, res) => {
  try {
    const data = req.body;

    const query = `UPDATE soda_hoja_header SET
      cod_rep = ?, cod_zona = ?, fecha = ?, orden = ?, nom_cliente = ?, 
      domicilio = ?, localidad = ?, celular = ?, secuencia = ?, saldiA3 = ?, saldiA4 = ?
      WHERE cod_cliente = ?`;

    await req.db.query(query, [
      data.cod_rep, data.cod_zona, data.fecha, data.orden,
      data.nom_cliente, data.domicilio, data.localidad, data.celular,
      data.secuencia, data.saldiA3, data.saldiA4, data.cod_cliente
    ]);

    res.redirect('/clientes');
  } catch (err) {
    console.error('Error al modificar cliente:', err);
    res.status(500).send('Error al modificar cliente.');
  }
});


app.post('/clientes/eliminar', async (req, res) => {
  try {
    const { cod_cliente } = req.body;

    await req.db.query(`DELETE FROM soda_hoja_header WHERE cod_cliente = ?`, [cod_cliente]);

    res.redirect('/clientes');
  } catch (err) {
    console.error('Error al eliminar cliente:', err);
    res.status(500).send('Error al eliminar cliente.');
  }
});

app.get('/clientes/buscar', async (req, res) => {
  const { cod_cliente } = req.query;
  if (!cod_cliente) return res.json({ success: false, message: 'Código requerido' });

  try {
    const [rows] = await req.db.query(
      `SELECT cod_cliente, nom_cliente, domicilio, localidad, celular, cod_rep, cod_zona, fecha, orden, secuencia, saldiA3, saldiA4 
       FROM soda_hoja_header WHERE cod_cliente = ? LIMIT 1`,
      [cod_cliente]
    );

    if (rows.length) {
      res.json({ success: true, cliente: rows[0] });
    } else {
      res.json({ success: false, message: 'No encontrado' });
    }
  } catch (err) {
    console.error('Error en /clientes/buscar:', err);
    res.status(500).json({ success: false, message: 'Error del servidor' });
  }
});


app.get('/clientes/buscarPorNombre', async (req, res) => {
  const { nombre } = req.query;
  if (!nombre) return res.json([]);

  try {
    const [rows] = await req.db.query(
      `SELECT cod_cliente, nom_cliente, domicilio, localidad, celular, cod_rep, cod_zona, fecha, orden, secuencia, saldiA3, saldiA4
       FROM soda_hoja_header
       WHERE nom_cliente LIKE CONCAT('%', ?, '%')
       ORDER BY nom_cliente ASC
       LIMIT 10`,
      [nombre]
    );
    res.json(rows);
  } catch (err) {
    console.error('Error en /clientes/buscarPorNombre:', err);
    res.status(500).json([]);
  }
});
app.get('/clientes/nuevoCodigo', async (req, res) => {
  try {
    // Obtener valor actual
    const [[{ codigo }]] = await req.db.query(`SELECT codigo FROM numeracion LIMIT 1`);

    // Actualizar: sumarle 1
    await req.db.query(`UPDATE numeracion SET codigo = codigo + 1`);

    // Devolver el valor original
    res.json({ success: true, codigo });
  } catch (err) {
    console.error('Error en /clientes/nuevoCodigo:', err);
    res.status(500).json({ success: false, message: 'Error en el servidor' });
  }
});

app.get('/clientes/porZona', async (req, res) => {
  const { cod_zona } = req.query;
  try {
    const [rows] = await req.db.query(
      `SELECT cod_rep, cod_zona, fecha, orden, cod_cliente, nom_cliente, domicilio, localidad, celular, secuencia, saldiA3, saldiA4 
       FROM soda_hoja_header WHERE cod_zona = ? ORDER BY secuencia`, [cod_zona]);
    res.json(rows);
  } catch (err) {
    console.error('Error en /clientes/porZona:', err);
    res.status(500).json([]);
  }
});

app.post('/clientes/actualizarCampo', async (req, res) => {
  const { cod_cliente, campo, valor } = req.body;
  try {
    await req.db.query(`UPDATE soda_hoja_header SET \`${campo}\` = ? WHERE cod_cliente = ?`, [valor, cod_cliente]);
    res.sendStatus(200);
  } catch (err) {
    console.error('Error en /clientes/actualizarCampo:', err);
    res.sendStatus(500);
  }
});

// ----------------------------
// RUTAS TAPAS Y BIDONES
// ----------------------------

// GET /tapasbidones — listado, filtro y formulario
app.get('/tapasbidones', verificarLogin,async (req, res) => {
  try {
    let fechaDesde = req.query.fechaDesde || null;
    let fechaHasta = req.query.fechaHasta || null;
    const cod_rep = parseInt(req.query.cod_rep) || 0;
    const cod_zona = parseInt(req.query.cod_zona) || 0;
    const hoy = new Date();
    const primerDiaMes = new Date(hoy.getFullYear(), hoy.getMonth(), 1);

    if (!fechaDesde) fechaDesde = primerDiaMes.toISOString().slice(0, 10);
    if (!fechaHasta) fechaHasta = hoy.toISOString().slice(0, 10);

    const [stocks] = await req.db.query(
      `SELECT id, fecha, tapas, bidon_a3, bidon_a4, bases
       FROM soda_stock
       WHERE fecha BETWEEN ? AND ?
       ORDER BY fecha`,
      [fechaDesde, fechaHasta]
    );

    let reportCount = 0;
    let totalBidonesBajados = 0;
    let vaciosA3 = 0;
    let vaciosA4 = 0;
    let bidonesA3 = 0;
    let bidonesA4 = 0;
    let resumenCardes = [];
    let diferenciasPorDia = [];

    let llenosA3 = 0;
    let llenosA4 = 0;
    let totalMovA3 = 0;
    let totalMovA4 = 0;
    let diferenciasTotales = null;

    let totalDiferenciaA3Pos = 0;
    let totalDiferenciaA3Neg = 0;
    let totalDiferenciaA4Pos = 0;
    let totalDiferenciaA4Neg = 0;
    let pinchados = 0;

    if (fechaDesde && fechaHasta) {
      const [[{ totalVenta }]] = await req.db.query(
        `SELECT SUM(venta) AS totalVenta
         FROM (
           SELECT MAX(venta) AS venta
           FROM soda_hoja_completa
           WHERE fecha BETWEEN ? AND ?
           GROUP BY cod_rep, cod_cliente, cod_prod, fecha
         ) AS sub`,
        [fechaDesde, fechaHasta]
      );
      reportCount = totalVenta || 0;

      const [[{ totalBajados }]] = await req.db.query(
        `SELECT SUM(bidones_bajados) AS totalBajados
         FROM (
           SELECT MAX(bidones_bajados) AS bidones_bajados
           FROM soda_hoja_completa
           WHERE fecha BETWEEN ? AND ?
           GROUP BY cod_rep, cod_cliente, cod_prod, fecha
         ) AS sub`,
        [fechaDesde, fechaHasta]
      );
      totalBidonesBajados = totalBajados || 0;

      const [desglose] = await req.db.query(
        `SELECT cod_prod, SUM(bidones_bajados) AS total
         FROM (
           SELECT cod_prod, MAX(bidones_bajados) AS bidones_bajados
           FROM soda_hoja_completa
           WHERE fecha BETWEEN ? AND ?
           GROUP BY cod_rep, cod_cliente, cod_prod, fecha
         ) AS sub
         GROUP BY cod_prod`,
        [fechaDesde, fechaHasta]
      );

      desglose.forEach(row => {
        if (row.cod_prod === 'A3') bidonesA3 = row.total || 0;
        if (row.cod_prod === 'A4') bidonesA4 = row.total || 0;
      });

      const condiciones = [`fecha BETWEEN ? AND ?`];
      const params = [fechaDesde, fechaHasta];

      if (cod_rep > 0) {
        condiciones.push(`cod_rep = ?`);
        params.push(cod_rep);
      }
      if (cod_zona > 0) {
        condiciones.push(`cod_zona = ?`);
        params.push(cod_zona);
      }

      const whereClause = condiciones.join(' AND ');

      const [cardes] = await req.db.query(
        `SELECT fecha, cod_rep, cod_zona, cod_prod, movimiento, SUM(cantidad) AS total
         FROM soda_cardes
         WHERE ${whereClause}
         GROUP BY fecha, cod_rep, cod_zona, cod_prod, movimiento
         ORDER BY fecha`,
        params
      );

      const datosPorDia = {};

      for (let row of cardes) {
        const clave = `${row.fecha}_${row.cod_rep}_${row.cod_zona}_${row.cod_prod}`;
        if (!datosPorDia[clave]) {
          datosPorDia[clave] = {
            fecha: row.fecha,
            cod_rep: row.cod_rep,
            cod_zona: row.cod_zona,
            cod_prod: row.cod_prod,
            lleno: 0,
            vacio: 0,
            carga: 0
          };
        }

        if (row.movimiento === 'lleno') datosPorDia[clave].lleno = Number(row.total);
        if (row.movimiento === 'vacio') datosPorDia[clave].vacio = Number(row.total);
        if (row.movimiento === 'carga') datosPorDia[clave].carga = Number(row.total);
      }

      const agrupadas = {};

      for (let clave in datosPorDia) {
        const d = datosPorDia[clave];
        const total = d.lleno + d.vacio;
        const dif = total - d.carga;

        resumenCardes.push({
          fecha: d.fecha,
          cod_rep: d.cod_rep,
          cod_zona: d.cod_zona,
          cod_prod: d.cod_prod,
          lleno: d.lleno,
          vacio: d.vacio,
          carga: d.carga,
          total_mov: total,
          diferencia: dif
        });

        if (d.cod_prod === 'A3') {
          if (dif > 0) totalDiferenciaA3Pos += dif;
          if (dif < 0) totalDiferenciaA3Neg += dif;
        }
        if (d.cod_prod === 'A4') {
          if (dif > 0) totalDiferenciaA4Pos += dif;
          if (dif < 0) totalDiferenciaA4Neg += dif;
        }

        const fechaKey = d.fecha;
        if (!agrupadas[fechaKey]) agrupadas[fechaKey] = { fecha: d.fecha, A3: 0, A4: 0 };
        if (d.cod_prod === 'A3' && dif !== 0) agrupadas[fechaKey].A3 = dif;
        if (d.cod_prod === 'A4' && dif !== 0) agrupadas[fechaKey].A4 = dif;
      }

      diferenciasPorDia = Object.values(agrupadas).filter(d => d.A3 !== 0 || d.A4 !== 0);

      const [[{ pinchados: pinch = 0 } = {}]] = await req.db.query(
        `SELECT SUM(cantidad) AS pinchados
         FROM soda_cardes
         WHERE movimiento = 'pinchados' AND ${whereClause}`,
        params
      );
      pinchados = pinch;

      const [vacios] = await req.db.query(
        `SELECT cod_prod, SUM(cantidad) AS total
         FROM soda_cardes
         WHERE movimiento = 'vacio' AND ${whereClause}
         GROUP BY cod_prod`,
        params
      );

      const [llenos] = await req.db.query(
        `SELECT cod_prod, SUM(cantidad) AS total
         FROM soda_cardes
         WHERE movimiento = 'lleno' AND ${whereClause}
         GROUP BY cod_prod`,
        params
      );

      vacios.forEach(row => {
        if (row.cod_prod === 'A3') vaciosA3 = Number(row.total || 0);
        if (row.cod_prod === 'A4') vaciosA4 = Number(row.total || 0);
      });

      llenos.forEach(row => {
        if (row.cod_prod === 'A3') llenosA3 = Number(row.total || 0);
        if (row.cod_prod === 'A4') llenosA4 = Number(row.total || 0);
      });

      totalMovA3 = vaciosA3 + llenosA3;
      totalMovA4 = vaciosA4 + llenosA4;

      const [[{ totalTapasMov }]] = await req.db.query(
        `SELECT SUM(cantidad) AS total
         FROM soda_cardes
         WHERE movimiento = 'tapas' AND ${whereClause}`,
        params
      );

      const [cargas] = await req.db.query(
        `SELECT cod_prod, SUM(cantidad) AS total
         FROM soda_cardes
         WHERE movimiento = 'carga' AND ${whereClause}
         GROUP BY cod_prod`,
        params
      );

      let cargaA3 = 0;
      let cargaA4 = 0;
      cargas.forEach(row => {
        if (row.cod_prod === 'A3') cargaA3 = Number(row.total || 0);
        if (row.cod_prod === 'A4') cargaA4 = Number(row.total || 0);
      });

      const ultimoStock = stocks.at(-1);

      diferenciasTotales = {
        totaltapas: Number(totalVenta || 0) - Number(ultimoStock?.tapas || 0),
        difA3: totalMovA3 - cargaA3,
        difA4: totalMovA4 - cargaA4,
        difBase: Number(totalTapasMov || 0) - Number(ultimoStock?.bases || 0)
      };
    }

    res.render('tapasbidones', {
      title: 'Stock de Tapas y Bidones',
      formAction: '/tapasbidones',
      fechaDesde,
      fechaHasta,
      cod_rep,
      cod_zona,
      stocks,
      editedStock: null, // o el stock editado si aplica
      diferenciasPorDia,
      diferenciasTotales,
      resumenCardes,
      bidonesA3,
      bidonesA4,
      vaciosA3,
      vaciosA4,
      llenosA3,
      llenosA4,
      totalMovA3,
      totalMovA4,
      reportCount,
      totalBidonesBajados,
      totalDiferenciaA3Pos,
      totalDiferenciaA3Neg,
      totalDiferenciaA4Pos,
      totalDiferenciaA4Neg,
      pinchados
    });
  } catch (err) {
    console.error('Error en GET /tapasbidones:', err);
    res.status(500).send('Error en el servidor.');
  }
});

// POST /tapasbidones — agregar o modificar según id
app.post('/tapasbidones', async (req, res) => {
  try {
    const { id, fecha, tapas, bidon_a3, bidon_a4, bases } = req.body;

    // Si es edición, solo actualizás normalmente
    if (id) {
      await req.db.query(
        `UPDATE soda_stock
         SET fecha = ?, tapas = ?, bidon_a3 = ?, bidon_a4 = ?, bases = ?
         WHERE id = ?`,
        [fecha, tapas, bidon_a3, bidon_a4, bases, id]
      );
    } else {
      // Buscar el último stock (última fila por fecha)
      const [rows] = await req.db.query(
        `SELECT tapas, bidon_a3, bidon_a4, bases
         FROM soda_stock
         ORDER BY fecha DESC
         LIMIT 1`
      );

      let last = rows[0] || { tapas: 0, bidon_a3: 0, bidon_a4: 0, bases: 0 };

      // Sumar el nuevo ingreso al último stock
      const totalTapas    = Number(last.tapas)     + Number(tapas);
      const totalBidonA3  = Number(last.bidon_a3)  + Number(bidon_a3);
      const totalBidonA4  = Number(last.bidon_a4)  + Number(bidon_a4);
      const totalBases    = Number(last.bases)     + Number(bases);

      // Insertar nuevo stock con los valores acumulados
      await req.db.query(
        `INSERT INTO soda_stock (fecha, tapas, bidon_a3, bidon_a4, bases)
         VALUES (?, ?, ?, ?, ?)`,
        [fecha, totalTapas, totalBidonA3, totalBidonA4, totalBases]
      );
    }

    // Redirigir a la misma fecha para ver el resultado
    res.redirect(`/tapasbidones`);
  } catch (err) {
    console.error('Error en POST /tapasbidones:', err);
    res.status(500).send('Error en el servidor.');
  }
});



// POST /tapasbidones/delete/:id — eliminar registro
app.post('/tapasbidones/delete/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await req.db.query(
      `DELETE FROM soda_stock WHERE id = ?`,
      [id]
    );
    res.redirect('/tapasbidones');
  } catch (err) {
    console.error('Error en POST /tapasbidones/delete/:id:', err);
    res.status(500).send('Error en el servidor.');
  }
});

// GET /tapasbidones/edit/:id — cargar un registro para modificar
// GET /tapasbidones/edit/:id — cargar un registro para modificar
app.get('/tapasbidones/edit/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Obtener el stock a editar
    const [rows] = await req.db.query(
      `SELECT id, fecha, tapas, bidon_a3, bidon_a4, bases 
       FROM soda_stock 
       WHERE id = ?`,
      [id]
    );

    if (!rows.length) return res.redirect('/tapasbidones');

    const editedStock = rows[0];

    // Traer también el stock (aunque es uno solo)
    const [stocks] = await req.db.query(
      `SELECT id, fecha, tapas, bidon_a3, bidon_a4, bases 
       FROM soda_stock 
       ORDER BY fecha DESC`
    );

    res.render('tapasbidones', {
      title: 'Editar Stock',
      stocks,
      editedStock,
      formAction: '/tapasbidones',
      fechaDesde: '',     // evitar ReferenceError
      fechaHasta: '',     // evitar ReferenceError
      reportCount: null   // para que no aparezca el bloque informe
    });

  } catch (err) {
    console.error('Error en GET /tapasbidones/edit/:id:', err);
    res.status(500).send('Error en el servidor.');
  }
});

// backend/server.js (o tu archivo de rutas)
// Devuelve datos de header para un cliente dado
app.get('/api/cliente-header', async (req, res) => {
  const cod_cliente = req.query.cod_cliente;
  if (!cod_cliente) {
    return res.json({ success: false, message: 'Falta el parámetro cod_cliente' });
  }

  try {
    const [[row]] = await req.db.query(
      `SELECT nom_cliente,
              domicilio,
              saldiA3,
              saldiA4
       FROM soda_hoja_header
       WHERE cod_cliente = ?`,
      [cod_cliente]
    );

    if (!row) {
      return res.json({ success: false, message: 'Cliente no encontrado' });
    }

    res.json({
      success:     true,
      nom_cliente: row.nom_cliente,
      domicilio:   row.domicilio,
      saldiA3:     row.saldiA3,
      saldiA4:     row.saldiA4
    });
  } catch (err) {
    console.error('Error en GET /api/cliente-header:', err);
    res.status(500).json({ success: false, message: 'Error en servidor' });
  }
});

// backend/server.js (o tu archivo de rutas)

// GET: mostrar formulario y listado de ventas en planta
app.get('/venta-planta', verificarLogin,async (req, res) => {
  try {
    // Obtener todas las ventas en planta (cod_rep=100, cod_zona=100)
    const [ventasPlanta] = await req.db.query(
      `SELECT fecha, cod_cliente, cod_prod,
              venta AS cantidad,
              cobrado_ctdo AS pago_efectivo,
              cobrado_ccte AS pago_ctacte,
              bidones_bajados AS bidones_devolvio,
              debe
       FROM soda_hoja_completa
       WHERE cod_rep = 100 AND cod_zona = 100
       ORDER BY fecha DESC`
    );
    res.render('ventaplanta', {
  title: 'Venta en Planta',
  ventasPlanta
});
  } catch (err) {
    console.error('Error en GET /venta-planta:', err);
    res.status(500).send('Error en el servidor.');
  }
});

// POST: guardar nueva venta en planta y actualizar saldos
app.post('/venta-planta', verificarLogin,async (req, res) => {
  const {
    cod_cliente,
    cod_prod,
    cantidad,
    bidones_devolvio,
    pago_efectivo,
    pago_ctacte,
    fecha
  } = req.body;

  // Valores fijos para planta
  const cod_rep  = 100;
  const cod_zona = 100;

  try {
    await req.db.query('START TRANSACTION');

    // 1) Obtener saldo actual del header antes de la operación
    const field = cod_prod === 'A4' ? 'saldiA4' : 'saldiA3';
    const [[current]] = await req.db.query(
      `SELECT ${field} AS currentSaldo
       FROM soda_hoja_header
       WHERE cod_cliente = ?`,
      [cod_cliente]
    );
    const currentSaldo = Number(current.currentSaldo || 0);

    // 2) Calcular nuevo saldo sólo si hubo cuenta corriente
    const decremento = Number(pago_ctacte || 0);
    const newSaldo = currentSaldo - decremento;

    // 3) Insertar en soda_hoja_completa incluyendo el campo 'debe'
    await req.db.query(
      `INSERT INTO soda_hoja_completa
         (cod_rep, cod_zona, cod_cliente, cod_prod, fecha,
          venta, bidones_bajados, cobrado_ctdo, cobrado_ccte, debe)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [cod_rep, cod_zona, cod_cliente, cod_prod, fecha,
       cantidad, bidones_devolvio, pago_efectivo, pago_ctacte, newSaldo]
    );

    // 4) Actualizar saldo en soda_hoja_header sólo si pago_ctacte > 0
    if (decremento > 0) {
      await req.db.query(
        `UPDATE soda_hoja_header
         SET ${field} = ?
         WHERE cod_cliente = ?`,
        [newSaldo, cod_cliente]
      );
    }

    await req.db.query('COMMIT');

    // 5) Redirigir para recargar listado con la nueva venta
    res.redirect('/venta-planta');
  } catch (err) {
    await req.db.query('ROLLBACK');
    console.error('Error en POST /venta-planta:', err);
    res.status(500).send('Error guardando la venta.');
  }
});


// Ruta raíz (redirige a login)
app.get('/', verificarLogin,(req, res) => {
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