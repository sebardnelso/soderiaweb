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

// Ruta para mostrar el formulario de login
app.get('/clientes', (req, res) => {
  res.render('clientes', { title: 'clientes' });
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


app.post('/ventaxdia', async (req, res) => {
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
    const { cod_rep, cod_zona, mes_desde, mes_hasta, anio } = req.query;
    if (!cod_rep || !cod_zona || !mes_desde || !mes_hasta || !anio) {
      return res.render('hojaruta', { title: 'Hoja Ruta', data: [], params: {} });
    }

    // Buscar los saldos iniciales por cliente y producto según el primer día encontrado
    const [saldosIniciales] = await req.db.query(`
      SELECT 
        cod_cliente, cod_prod, MIN(STR_TO_DATE(fecha, '%Y-%m-%d')) AS fecha_min
      FROM soda_hoja_completa
      WHERE cod_rep = ? AND cod_zona = ?
        AND MONTH(STR_TO_DATE(fecha, '%Y-%m-%d')) BETWEEN ? AND ?
        AND YEAR(STR_TO_DATE(fecha, '%Y-%m-%d')) = ?
      GROUP BY cod_cliente, cod_prod
    `, [cod_rep, cod_zona, mes_desde, mes_hasta, anio]);

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
        semana;
      `,
      [mes_desde, mes_hasta, anio, cod_rep, cod_zona]
    );

    const pivot = {};
    rows.forEach(r => {
      const key = `${r.cod_cliente}-${r.cod_prod}`;
      const semanaIndex = (r.mes - mes_desde) * 5 + r.semana;
      if (!pivot[key]) {
        pivot[key] = {
          cod_cliente: r.cod_cliente,
          nom_cliente: r.nom_cliente,
          cod_prod:    r.cod_prod,
          semanas:     {}
        };
      }

      const saldoInicial = saldosMap[key] || 0;
      pivot[key].semanas[semanaIndex] = {
        saldo_inicial: semanaIndex === 1 ? saldoInicial : undefined,
        venta:         Number(r.venta) || 0,
        cobrado_ctdo:  Number(r.cobrado_ctdo) || 0,
        cobrado_ccte:  Number(r.cobrado_ccte) || 0,
        resultado:     0
      };
    });

    Object.values(pivot).forEach(cli => {
      const semanas = cli.semanas;
      let acc = semanas[1]?.saldo_inicial || 0;
      for (let w = 1; w <= (mes_hasta - mes_desde + 1) * 5; w++) {
        const s = semanas[w] || { venta: 0, cobrado_ctdo: 0, cobrado_ccte: 0 };
        if (!semanas[w]) semanas[w] = s;
        s.resultado = acc + s.venta - s.cobrado_ctdo - s.cobrado_ccte;
        acc = s.resultado;
      }
    });

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
app.get('/liquidaciones', async (req, res) => {
  try {
    const { cod_rep, fecha_desde, fecha_hasta } = req.query;

    const parametros = {
      cod_rep:     cod_rep     || '',
      fecha_desde: fecha_desde || '',
      fecha_hasta: fecha_hasta || ''
    };
    console.log('PARAMETROS:', parametros);

    let rendiciones = [];
    let ventas = [];
    let totalLiquido = 0;
    let totalBidones = 0;

    if (cod_rep !== undefined && fecha_desde && fecha_hasta) {
      // --------------------
      // 1) Rendiciones (solo si cod_rep != 0)
      if (cod_rep !== '0') {
        [rendiciones] = await req.db.query(
          `SELECT 
             r.fecha, 
             rub.descripcion, 
             r.importe 
           FROM soda_rendiciones r
           JOIN soda_rubros_rendiciones rub 
             ON r.cod_gasto = rub.cod
           WHERE r.cod_rep = ?
             AND r.cod_gasto = 12
             AND r.fecha BETWEEN ? AND ?
           ORDER BY r.fecha`,
          [cod_rep, fecha_desde, fecha_hasta]
        );
      } else {
        // Si cod_rep = 0, no mostrar rendiciones individuales
        rendiciones = [];
      }

      const totalAdelantos = rendiciones
        .reduce((sum, r) => sum + Number(r.importe), 0);

      // --------------------
      // 2) Ventas por todos o uno
      const condition = cod_rep === '0' ? '1=1' : 'hc.cod_rep = ?';
      const params = cod_rep === '0'
        ? [fecha_desde, fecha_hasta]
        : [cod_rep, fecha_desde, fecha_hasta];

      let [rawVentas] = await req.db.query(
        `SELECT
           hc.fecha,
           hc.cod_prod,
           SUM(hc.venta)               AS cantidad,
           SUM(hc.cobrado_ctdo)        AS cobrado_ctdo,
           SUM(hc.cobrado_ccte)        AS cobrado_ccte,
           SUM(hc.bidones_bajados)     AS bidones_vendidos,
           SUM(hc.cobrado_ctdo * p.precio) AS monto_ctdo,
           SUM(hc.cobrado_ccte * p.precio) AS monto_ccte
         FROM soda_hoja_completa hc
         JOIN soda_precios p ON hc.cod_prod = p.cod_prod
         WHERE ${condition}
           AND hc.fecha BETWEEN ? AND ?
         GROUP BY hc.fecha, hc.cod_prod
         ORDER BY hc.fecha, hc.cod_prod`,
        params
      );

      ventas = rawVentas.map(v => ({
        fecha:            v.fecha,
        cod_prod:         v.cod_prod,
        cantidad:         Number(v.cantidad),
        cobrado_ctdo:     Number(v.cobrado_ctdo),
        cobrado_ccte:     Number(v.cobrado_ccte),
        bidones_vendidos: Number(v.bidones_vendidos),
        monto_ctdo:       Number(v.monto_ctdo),
        monto_ccte:       Number(v.monto_ccte)
      }));

      // Sumar montos y bidones
      const sumaMontos = ventas.reduce((sum, v) => sum + v.monto_ctdo + v.monto_ccte, 0);
      totalBidones = ventas.reduce((sum, v) => sum + v.bidones_vendidos, 0);
      totalLiquido = sumaMontos - totalAdelantos;
    }

    res.render('liquidaciones', {
      title:        'Liquidaciones',
      parametros,
      rendiciones,
      ventas,
      totalLiquido,
      totalBidones
    });

  } catch (err) {
    console.error('Error en /liquidaciones:', err);
    res.status(500).send('Error en el servidor.');
  }
});

app.get('/clientes', async (req, res) => {
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
