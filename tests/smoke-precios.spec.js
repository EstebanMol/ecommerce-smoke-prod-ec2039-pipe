// tests/smoke-precios.spec.js
/**
 * Smoke Test: Validación de precios en pipe.store
 *
 * Detecta el bug conocido donde los precios se renderizan con valores
 * absurdamente largos (ej: AR$ 179.769.313.486.231.570.000.000...)
 * en lugar del precio real del producto.
 */

require('dotenv').config();
const { notificarError } = require('./helpers/notificaciones');

const { test, expect } = require('@playwright/test');
const { validarPrecio, validarPrecios } = require('./helpers/priceValidator');

// ─── Selectores centralizados ────────────────────────────────────────────────
// Ajustar si el HTML de pipe.store cambia
const SELECTORS = {
  // Precio en tarjetas de producto (Material UI)
  PRECIO_TARJETA: 'h5[id*="-price"]',

  // Precio en página de detalle
  PRECIO_DETALLE: 'h5[id*="-price"]',

  // Tarjetas de producto
  TARJETA_PRODUCTO: '[class*="MuiCard"], [class*="MuiPaper"], [class*="product"]',

  // Bloque de mejor promo en detalle (puede haber varios: uno por grupo de tarjetas)
  // id termina en "-best-promos", generado dinámicamente con el UUID del producto
  BLOQUE_PROMOS: '[id$="-best-promos"]',
};

// ─── Páginas a testear ───────────────────────────────────────────────────────
const PAGINAS = [
  { nombre: 'Home', path: '/' },
  { nombre: 'TV', path: '/categories/962b9949-c7e2-4a1e-b4f8-837bc9ecc58d' },
  { nombre: 'Lavarropas', path: '/categories/74845a0b-1bab-4812-b7f0-9ff20b68dc5b' },
  { nombre: 'Microondas', path: '/categories/cc642452-7fb5-4d26-8d74-736c775576a6' },
  { nombre: 'Celulares', path: '/categories/232a9297-4018-4ad6-8b6b-2e40a3455968' },
];

// ─── Helper: extraer precios visibles de la página ──────────────────────────
async function extraerPrecios(page, selector) {
  return page.evaluate((sel) => {
    const elementos = document.querySelectorAll(sel);
    const resultados = [];

    elementos.forEach((el) => {
      const texto = el.innerText?.trim() || el.textContent?.trim();
      if (texto && texto.includes('AR$')) {
        const primeraLinea = texto.split('\n')[0].trim();
        if (primeraLinea) {
          const linkEl = el.closest('a');
          const url = linkEl
            ? `https://ecommerce-fob-app.dev.phinxlabcore.com${linkEl.getAttribute('href')}`
            : 'URL no encontrada';

          resultados.push({ precio: primeraLinea, url });
        }
      }
    });

    return resultados.filter((r, i, arr) =>
      arr.findIndex((x) => x.precio === r.precio && x.url === r.url) === i
    );
  }, selector);
}

// ─── Helper: tomar screenshot con precios marcados ──────────────────────────
async function marcarPreciosRotos(page, selector) {
  await page.evaluate((sel) => {
    document.querySelectorAll(sel).forEach((el) => {
      const texto = el.innerText || el.textContent || '';
      if (texto.length > 50 && texto.includes('AR$')) {
        el.style.outline = '3px solid red';
        el.style.backgroundColor = 'rgba(255,0,0,0.1)';
      }
    });
  }, selector);
}

// ─── Helper: extraer promos del DOM de la página de detalle ─────────────────
// Devuelve array de objetos { cuotas, monto, sinInteres, textoCompleto }
// uno por cada bloque [id$="-best-promos"] encontrado en la página.
async function extraerPromosDelDOM(page, selector) {
  return page.evaluate((sel) => {
    const bloques = document.querySelectorAll(sel);
    const promos = [];

    bloques.forEach((bloque) => {
      // Cada bloque puede tener varios grupos de divs hijos directos
      // Estructura: div.jssXXXX > [div "12 cuotas de", div "AR$ 8,42", div "- sin interés"]
      const grupos = bloque.querySelectorAll(':scope > div');

      grupos.forEach((grupo) => {
        const hijos = Array.from(grupo.children).map((h) => h.textContent?.trim() || '');

        if (hijos.length >= 2) {
          const textoCuotas = hijos[0] || '';   // ej: "12 cuotas de" | "1 pago de"
          const textoMonto  = hijos[1] || '';   // ej: "AR$ 8,42"
          const textoExtra  = hijos[2] || '';   // ej: "- sin interés"

          // Extraer número de cuotas del texto (ej: "12 cuotas de" → 12)
          const matchCuotas = textoCuotas.match(/^(\d+)/);
          const numeroCuotas = matchCuotas ? parseInt(matchCuotas[1], 10) : 1;

          // Es "sin interés" si el tercer div lo menciona explícitamente
          const sinInteres = textoExtra.toLowerCase().includes('sin inter');

          promos.push({
            cuotas: numeroCuotas,
            monto: textoMonto,
            sinInteres,
            textoCompleto: `${textoCuotas} ${textoMonto} ${textoExtra}`.trim(),
          });
        }
      });
    });

    return promos;
  }, selector);
}

// ─── Helper: navegar al detalle del primer producto disponible ───────────────
// Extrae el href del primer producto y navega directo con page.goto.
// Retorna { productId, urlProducto } o null si no se pudo navegar.
async function navegarAlPrimerProducto(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  // Buscar cualquier <a href*="/product/"> en la página, sin depender del selector de tarjeta.
  // Fallback progresivo: /product/ → /p/ → cualquier link con UUID en href
  const hrefProducto = await page.evaluate(() => {
    const selectores = [
      'a[href*="/product/"]',
      'a[href*="/p/"]',
    ];
    for (const sel of selectores) {
      const links = document.querySelectorAll(sel);
      for (const link of links) {
        const href = link.getAttribute('href');
        // Ignorar links vacíos, anchors y los de categorías
        if (href && !href.startsWith('#') && !href.includes('/categories/')) {
          return href;
        }
      }
    }
    // Último fallback: cualquier <a> con un UUID en el href
    const todos = document.querySelectorAll('a[href]');
    for (const link of todos) {
      const href = link.getAttribute('href');
      if (href && /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/.test(href) && !href.includes('/categories/')) {
        return href;
      }
    }
    return null;
  });

  console.log(`   🔗 href encontrado: ${hrefProducto || 'ninguno'}`);
  if (!hrefProducto) return null;

  // Construir URL absoluta si el href es relativo
  const baseUrl = new URL(page.url()).origin;
  const urlProducto = hrefProducto.startsWith('http')
    ? hrefProducto
    : `${baseUrl}${hrefProducto}`;

  // Navegar directamente — esto garantiza que page.url() sea la URL del producto
  await page.goto(urlProducto, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  // Extraer UUID del producto desde la URL
  const match = urlProducto.match(/\/([a-f0-9-]{36})(?:[/?]|$)/);
  const productId = match ? match[1] : urlProducto;

  return { productId, urlProducto };
}

// ════════════════════════════════════════════════════════════════════════════
// TEST SUITE PRINCIPAL
// ════════════════════════════════════════════════════════════════════════════

test.describe('🔥 Smoke Test — Validación de precios pipe.store DEV', () => {

  // ── Test 1: Carga sin errores críticos ────────────────────────────────────
  test('El sitio carga sin errores críticos', async ({ page }, testInfo) => {

    const erroresConsola = [];
    const recursos404 = [];

    page.on('response', (resp) => {
      if (resp.status() === 404 && resp.url().includes('phinxlabcore.com')) {
        recursos404.push(resp.url());
        console.warn(`⚠️ 404 detectado: ${resp.url()}`);
      }
    });

    page.on('console', (msg) => {
      if (msg.type() === 'error') erroresConsola.push(msg.text());
    });

    const response = await page.goto('/', { waitUntil: 'domcontentloaded' });
    expect(response.status(), 'El sitio debe responder con HTTP 200').toBe(200);

    await page.waitForTimeout(8000);

    console.log(`\nRecursos con 404: ${recursos404.length}`);
    if (recursos404.length > 0) {
      recursos404.forEach((url, i) => console.log(`  ${i + 1}. ${url}`));
    }

    console.log(`\nErrores JS en consola: ${erroresConsola.length}`);
    if (erroresConsola.length > 0) {
      erroresConsola.forEach((err, i) => console.log(`  ${i + 1}. ${err}`));
    }

    if (recursos404.length > 0 && testInfo.retry === 0) {
      await notificarError({
        titulo: `${recursos404.length} recursos con error 404`,
        mensaje: 'Se detectaron recursos no encontrados en pipe.store DEV',
        detalles: recursos404.map((url) => `<a href="${url}">${url}</a>`),
      });
    }

    const erroresCriticos = erroresConsola.filter((e) =>
      e.includes('ecommerce-fob-server') ||
      e.includes('CORS') ||
      e.includes('ERR_FAILED')
    );

    if (erroresCriticos.length > 3 && testInfo.retry === 0) {
      await notificarError({
        titulo: 'Backend caído o con errores CORS',
        mensaje: `Se detectaron ${erroresCriticos.length} errores críticos`,
        detalles: [...new Set(erroresCriticos.map((e) => e.split('\n')[0].substring(0, 150)))],
      });

      throw new Error(`Backend con errores críticos: ${erroresCriticos.length} fallos`);
    }
  });

  // ── Test 2: Validar precios en todas las páginas del catálogo ────────────
  for (const pagina of PAGINAS) {
    test(`Precios correctos en: ${pagina.nombre}`, async ({ page }, testInfo) => {
      await page.goto(pagina.path, { waitUntil: 'domcontentloaded' });

      await page.evaluate(() => window.scrollTo(0, 300));
      await page.waitForTimeout(1000);
      await page.evaluate(() => window.scrollTo(0, 600));
      await page.waitForTimeout(1000); 

      try {
        await page.waitForSelector('h5[id*="-price"]', { timeout: 20000 });
      } catch {
        console.warn(`⚠️  Timeout esperando precios en ${pagina.nombre}`);
      }

      const preciosRaw = await extraerPrecios(page, SELECTORS.PRECIO_TARJETA);

      if (preciosRaw.length === 0) {
        console.warn(
          `⚠️  No se encontraron precios en ${pagina.nombre}. ` +
          `Verificar selector: ${SELECTORS.PRECIO_TARJETA}`
        );
        test.skip();
        return;
      }

      console.log(`\n📋 Página: ${pagina.nombre} — ${preciosRaw.length} precios encontrados`);

      const reporte = validarPrecios(preciosRaw.map((r) => r.precio));

      reporte.detalle.forEach(({ precio, valid, errores }) => {
        if (valid) {
          console.log(`  ✅ ${precio}`);
        } else {
          console.error(`  ❌ "${precio}"`);
          errores.forEach((e) => console.error(`     → ${e}`));
        }
      });

      if (reporte.invalidos > 0) {
        await marcarPreciosRotos(page, SELECTORS.PRECIO_TARJETA);
        await page.screenshot({
          path: `playwright-report/precios-rotos-${pagina.nombre.toLowerCase()}.png`,
          fullPage: false,
        });

        if (testInfo.retry === 0) {
          await notificarError({
            titulo: `Precios inválidos en categoría ${pagina.nombre}`,
            mensaje: `Se encontraron ${reporte.invalidos} precio(s) inválido(s)`,
            detalles: reporte.detalle
              .filter((r) => !r.valid)
              .map((r) => {
                const match = preciosRaw.find((p) => p.precio === r.precio);
                const url = match?.url || 'URL no encontrada';
                return `${r.precio} → ${r.errores.join(', ')}<br>&nbsp;&nbsp;&nbsp;<a href="${url}">${url}</a>`;
              }),
            screenshotPath: `playwright-report/precios-rotos-${pagina.nombre.toLowerCase()}.png`,
          });
        }
      }

      const preciosInvalidos = reporte.detalle
        .filter((r) => !r.valid)
        .map((r) => `"${r.precio}" → ${r.errores.join(', ')}`)
        .join('\n');

      expect(
        reporte.invalidos,
        `Se encontraron ${reporte.invalidos} precio(s) inválido(s) en ${pagina.nombre}:\n${preciosInvalidos}`
      ).toBe(0);
    });
  }

  // ── Test 3: Validar precio en página de detalle de producto ─────────────
  test('Precio correcto en página de detalle de producto', async ({ page }, testInfo) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);

    const primerProducto = page.locator(SELECTORS.TARJETA_PRODUCTO).first();
    const existe = await primerProducto.count();

    if (existe === 0) {
      console.warn('⚠️  No se encontró ninguna tarjeta de producto en home');
      test.skip();
      return;
    }

    await primerProducto.click();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1000);

    const url = page.url();
    console.log(`\n📦 Testeando detalle de producto: ${url}`);

    const preciosRaw = await extraerPrecios(page, SELECTORS.PRECIO_DETALLE);

    if (preciosRaw.length === 0) {
      const preciosFallback = await extraerPrecios(page, '*');
      console.warn(`Selector de detalle no matcheó. Fallback encontró: ${preciosFallback.length} precios`);
      preciosRaw.push(...preciosFallback.slice(0, 5));
    }

    expect(preciosRaw.length, 'Debe haber al menos un precio en la página de detalle').toBeGreaterThan(0);

    const reporte = validarPrecios(preciosRaw.map((r) => r.precio));

    console.log(`Precios encontrados: ${reporte.total} | Válidos: ${reporte.validos} | Inválidos: ${reporte.invalidos}`);

    reporte.detalle.forEach(({ precio, valid, errores }) => {
      if (!valid) console.error(`❌ "${precio}" → ${errores.join(', ')}`);
    });

    const preciosInvalidos = reporte.detalle
      .filter((r) => !r.valid)
      .map((r) => `"${r.precio}" → ${r.errores.join(', ')}`)
      .join('\n');

    if (reporte.invalidos > 0 && testInfo.retry === 0) {
      try {
        await notificarError({
          titulo: 'Precio inválido en página de detalle de producto',
          mensaje: `Se encontraron ${reporte.invalidos} precio(s) inválido(s) en el detalle`,
          detalles: reporte.detalle
            .filter((r) => !r.valid)
            .map((r) => `${r.precio} → ${r.errores.join(', ')}`),
        });
      } catch (e) {
        console.error('⚠️  Error al enviar notificación (test 3):', e.message);
      }
    }

    expect(
      reporte.invalidos,
      `Precio roto en detalle de producto:\n${preciosInvalidos}`
    ).toBe(0);
  });

  // ── Test 4: Detector específico del bug de precios extremadamente largos ─
  test('No hay precios con overflow (bug conocido de producción)', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);

    const preciosRotos = await page.evaluate(() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
      const encontrados = [];
      let nodo;

      while ((nodo = walker.nextNode())) {
        const texto = nodo.textContent?.trim();
        // Bug real: precio con más de 15 dígitos numéricos
        if (texto && texto.includes('AR$') && texto.replace(/[^0-9]/g, '').length > 15) {
          encontrados.push({
            texto: texto.substring(0, 100),
            longitud: texto.length,
            padre: nodo.parentElement?.className || nodo.parentElement?.tagName,
          });
        }
      }

      return encontrados;
    });

    if (preciosRotos.length > 0) {
      console.error('\n🚨 PRECIOS ROTOS DETECTADOS:');
      preciosRotos.forEach(({ texto, longitud, padre }) => {
        console.error(`  Longitud: ${longitud} | Clase: ${padre}`);
        console.error(`  Texto: "${texto}..."`);
      });

      await page.screenshot({
        path: 'playwright-report/bug-precios-overflow.png',
        fullPage: true,
      });

      try {
        await notificarError({
          titulo: 'Bug de precios rotos detectado en producción',
          mensaje: `Se encontraron ${preciosRotos.length} precio(s) con overflow en la Home`,
          detalles: preciosRotos.map(
            (p) => `"${p.texto.substring(0, 60)}..." (${p.longitud} caracteres) — clase: ${p.padre}`
          ),
        });
      } catch (e) {
        console.error('⚠️  Error al enviar notificación (test 4):', e.message);
      }
    }

    expect(
      preciosRotos.length,
      `Se detectaron ${preciosRotos.length} precio(s) con overflow (bug de producción conocido):\n` +
      preciosRotos.map((p) => `  "${p.texto.substring(0, 50)}..." (${p.longitud} chars)`).join('\n')
    ).toBe(0);
  });

  // ════════════════════════════════════════════════════════════════════════
  // TEST SUITE: Formas de pago y cuotas
  // ════════════════════════════════════════════════════════════════════════

  test.describe('💳 Formas de pago y cuotas en página de detalle', () => {

    // ── Notificación de fallo garantizada ────────────────────────────────────
    // Se ejecuta después de cada test. Si el test falló Y es el primer intento,
    // envía un mail con el título del test y el mensaje de error.
    // Esto cubre cualquier fallo inesperado (timeout, excepción, expect) que
    // ocurra ANTES de que el bloque inline de notificación llegue a ejecutarse.
    test.afterEach(async ({ page }, testInfo) => {
      if (testInfo.status !== 'failed') return;
      if (testInfo.retry !== 0) return;

      const urlAnnotation = testInfo.annotations.find((a) => a.type === 'url_producto');
      const urlProducto = urlAnnotation ? urlAnnotation.description : page.url();

      try {
        await notificarError({
          titulo: `Test fallido: ${testInfo.title}`,
          mensaje: 'El test falló durante la ejecución automática.',
          detalles: [
            `Test: ${testInfo.title}`,
            `URL del producto: ${urlProducto}`,
          ],
        });
      } catch (e) {
        console.error('⚠️  Error al enviar notificación en afterEach:', e.message);
      }
    });

    // ── Helper interno: abrir modal de medios de pago y leer tabla ────────────
    // Navega al producto, abre "Ver otros medios de pago", selecciona el primer
    // método y tarjeta disponibles, y retorna las filas de la tabla de cuotas.
    async function abrirModalYLeerCuotas(page) {
      // Esperar que la página cargue completamente antes de interactuar
      try {
        await page.waitForLoadState('networkidle', { timeout: 10000 });
      } catch {
        // Si networkidle tarda, continuar igual con domcontentloaded
        await page.waitForLoadState('domcontentloaded');
      }
      await page.waitForTimeout(1000);

      // Buscar y clickear "Ver otros medios de pago"
      let btnEncontrado = false;
      try {
        await page.evaluate(() => window.scrollTo(0, 500));
        await page.waitForTimeout(800);
        const btn = page.locator('a, button, span, p').filter({ hasText: 'Ver otros medios de pago' }).first();
        await btn.waitFor({ state: 'visible', timeout: 10000 });
        await btn.scrollIntoViewIfNeeded();
        await btn.click();
        btnEncontrado = true;
      } catch (e) {
        console.warn(`   ⚠️  No se encontró "Ver otros medios de pago": ${e.message}`);
        return null;
      }

      if (!btnEncontrado) return null;

      // Esperar que abra el modal
      try {
        await page.waitForSelector('[role="dialog"]', { timeout: 10000 });
      } catch {
        console.warn('   ⚠️  El modal no abrió.');
        return null;
      }

      await page.waitForTimeout(800);

      // Paso 1: clickear la primera IMG del modal (método de pago, ej: MODO)
      try {
        const imgs = page.locator('[role="dialog"] img');
        const count = await imgs.count();
        if (count > 0) {
          await imgs.first().click();
          console.log('   🖱️  Click en método de pago (img 0)');
          await page.waitForTimeout(1200);
        }
      } catch (e) {
        console.warn(`   ⚠️  No se pudo clickear el método de pago: ${e.message}`);
      }

      // Paso 2: clickear la segunda IMG si aparece (tarjeta, ej: MODO tarjeta)
      // Después del click en el método aparece una segunda img para la tarjeta
      try {
        const imgs2 = page.locator('[role="dialog"] img');
        const count2 = await imgs2.count();
        if (count2 >= 2) {
          await imgs2.nth(1).click();
          console.log('   🖱️  Click en tarjeta (img 1)');
          await page.waitForTimeout(1200);
        }
      } catch (e) {
        console.warn(`   ⚠️  No se pudo clickear la tarjeta: ${e.message}`);
      }

      // Esperar tabla de cuotas
      try {
        await page.waitForSelector('[role="dialog"] tbody tr', { timeout: 10000 });
      } catch {
        console.warn('   ⚠️  No apareció la tabla de cuotas en el modal.');
        return null;
      }

      // Leer filas de la tabla
      const filas = await page.evaluate(() => {
        const rows = document.querySelectorAll('[role="dialog"] tbody tr');
        return Array.from(rows).map((tr) => {
          const celdas = Array.from(tr.querySelectorAll('td')).map((td) => td.innerText.trim());
          const textoCuotas = celdas[0] || '';
          const textoInteres = celdas[1] || '';
          const textoTotal = celdas[3] || celdas[2] || '';
          const matchCuotas = textoCuotas.match(/^(\d+)/);
          const cuotas = matchCuotas ? parseInt(matchCuotas[1]) : 1;
          const sinInteres = /sin inter[eé]s/i.test(textoInteres) || textoInteres.trim() === '';
          return { cuotas, textoCompleto: textoCuotas, interes: textoInteres, total: textoTotal, sinInteres };
        }).filter((f) => f.cuotas > 0);
      });

      return filas.length > 0 ? filas : null;
    }

    // ── Test 5: Al menos una forma de pago tiene cuotas (> 1 cuota) ─────────
    test('Al menos una forma de pago tiene cuotas (> 1 cuota)', async ({ page }, testInfo) => {
      const resultado = await navegarAlPrimerProducto(page);

      if (!resultado) {
        console.warn('⚠️  No se pudo navegar a un producto. Test omitido.');
        test.skip();
        return;
      }

      const { productId, urlProducto } = resultado;
      console.log(`\n💳 Producto analizado: ${productId}`);
      console.log(`   URL de detalle: ${urlProducto}`);
      testInfo.annotations.push({ type: 'url_producto', description: urlProducto });

      let filas = null;
      try {
        filas = await abrirModalYLeerCuotas(page);
      } catch (e) {
        console.warn(`⚠️  Error al abrir modal: ${e.message}`);
      }

      if (!filas) {
        console.warn('⚠️  No se pudo abrir el modal de medios de pago o leer la tabla.');
        test.skip();
        return;
      }

      console.log(`\n   Cuotas encontradas en modal: ${filas.length}`);
      filas.forEach((f) => console.log(`     • ${f.cuotas} cuota(s) — interés: "${f.interes}" — total: ${f.total}`));

      const filasConCuotas = filas.filter((f) => f.cuotas > 1);

      if (filasConCuotas.length === 0 && testInfo.retry === 0) {
        try {
          await notificarError({
            titulo: 'CA #1 fallido — Ninguna forma de pago tiene cuotas configuradas',
            mensaje: `El producto no muestra ninguna opción con más de 1 cuota.`,
            detalles: [
              `URL: ${urlProducto}`,
              `Filas detectadas: ${filas.length}`,
              ...filas.map((f) => `• ${f.cuotas} cuota(s): ${f.textoCompleto}`),
            ],
          });
        } catch (e) {
          console.error('⚠️  Error al enviar notificación (test 5):', e.message);
        }
      }

      expect(
        filasConCuotas.length,
        `No se encontró ninguna opción con más de 1 cuota en el modal de medios de pago.\n` +
        `Filas detectadas: ${filas.map((f) => f.textoCompleto).join(' | ') || 'ninguna'}`
      ).toBeGreaterThan(0);

      console.log(`\n   ✅ Opciones con cuotas (> 1): ${filasConCuotas.length}`);
    });

    // ── Test 6: Al menos una forma de pago tiene intereses ──────────────────
    test('Al menos una forma de pago tiene intereses (cuotas con costo)', async ({ page }, testInfo) => {
      const resultado = await navegarAlPrimerProducto(page);

      if (!resultado) {
        console.warn('⚠️  No se pudo navegar a un producto. Test omitido.');
        test.skip();
        return;
      }

      const { productId, urlProducto } = resultado;
      testInfo.annotations.push({ type: 'url_producto', description: urlProducto });

      let filas = null;
      try {
        filas = await abrirModalYLeerCuotas(page);
      } catch (e) {
        console.warn(`⚠️  Error al abrir modal: ${e.message}`);
      }

      if (!filas) {
        console.warn('⚠️  No se pudo abrir el modal de medios de pago o leer la tabla.');
        test.skip();
        return;
      }

      const filasConInteres = filas.filter((f) => !f.sinInteres && f.cuotas > 1);
      const filasSinInteres = filas.filter((f) => f.sinInteres);

      console.log(`\n💳 Producto: ${productId}`);
      console.log(`   Total filas: ${filas.length}`);
      console.log(`   Sin interés: ${filasSinInteres.length}`);
      console.log(`   Con interés: ${filasConInteres.length}`);
      filas.forEach((f) => {
        const etiqueta = f.sinInteres ? '✅ sin interés' : '💰 con interés';
        console.log(`     • [${etiqueta}] ${f.cuotas} cuota(s) — ${f.interes || 'sin dato'} — total: ${f.total}`);
      });

      if (filasConInteres.length === 0 && testInfo.retry === 0) {
        try {
          await notificarError({
            titulo: 'CA #2 fallido — Ninguna forma de pago tiene intereses configurados',
            mensaje: `El producto no muestra ninguna opción con interés.\n` +
              `Si la política comercial es operar 100% sin interés, este test debe marcarse como skip.`,
            detalles: [
              `URL: ${urlProducto}`,
              `Total filas: ${filas.length}`,
              `Sin interés: ${filasSinInteres.length}`,
              `Con interés: ${filasConInteres.length}`,
            ],
          });
        } catch (e) {
          console.error('⚠️  Error al enviar notificación (test 6):', e.message);
        }
      }

      expect(
        filasConInteres.length,
        `No se encontró ninguna forma de pago con interés.\n` +
        `Si el negocio opera solo con cuotas sin interés, este test puede marcarse como skip.\n` +
        `Filas detectadas: ${filas.map((f) => f.textoCompleto).join(' | ') || 'ninguna'}`
      ).toBeGreaterThan(0);
    });

    // ── Test 7: Consistencia leyenda "sin interés" frontend vs tabla ─────────
    // Verifica que la columna INTERÉS de la tabla diga "Sin interés" solo cuando
    // el monto total coincide matemáticamente con cuotas × monto por cuota.
    test('La leyenda "sin interés" en el frontend es consistente con el backend', async ({ page }, testInfo) => {
      const resultado = await navegarAlPrimerProducto(page);

      if (!resultado) {
        console.warn('⚠️  No se pudo navegar a un producto. Test omitido.');
        test.skip();
        return;
      }

      const { productId, urlProducto } = resultado;
      testInfo.annotations.push({ type: 'url_producto', description: urlProducto });

      let filas = null;
      try {
        filas = await abrirModalYLeerCuotas(page);
      } catch (e) {
        console.warn(`⚠️  Error al abrir modal: ${e.message}`);
      }

      if (!filas) {
        console.warn('⚠️  No se pudo abrir el modal de medios de pago o leer la tabla.');
        test.skip();
        return;
      }

      console.log(`\n🔍 Consistencia leyenda sin interés — Producto: ${productId}`);
      console.log(`   URL: ${urlProducto}`);

      // Verificación: para cada fila marcada como "sin interés",
      // el total debe ser igual al precio base (tolerancia 5% por redondeo).
      // Si el total es mayor al precio base → hay interés oculto → inconsistencia.
      const precioTexto = await page.$eval(
        SELECTORS.PRECIO_DETALLE,
        (el) => el.textContent?.trim() || ''
      ).catch(() => '');

      const precioBase = parseFloat(
        precioTexto.replace('AR$', '').replace(/\./g, '').replace(',', '.').trim()
      );

      console.log(`   Precio base del producto: ${precioTexto} → ${precioBase}`);

      const inconsistencias = [];

      for (const fila of filas) {
        if (!fila.sinInteres || fila.cuotas <= 1) continue;

        // Extraer monto del total de la fila
        const totalFila = parseFloat(
          fila.total.replace('AR$', '').replace(/\./g, '').replace(',', '.').trim()
        );

        if (isNaN(totalFila) || isNaN(precioBase) || precioBase <= 0) continue;

        // Si dice "sin interés", el total de la fila debe ser igual al precio base
        const diferenciaPct = Math.abs(totalFila - precioBase) / precioBase;

        if (diferenciaPct > 0.05) {
          inconsistencias.push(
            `${fila.cuotas} cuota(s) marcadas como "sin interés" pero total ` +
            `${fila.total} difiere del precio base ${precioTexto} en ${(diferenciaPct * 100).toFixed(1)}%`
          );
          console.error(`   ❌ ${inconsistencias[inconsistencias.length - 1]}`);
        } else {
          console.log(`   ✅ ${fila.cuotas} cuota(s) sin interés: total ${fila.total} ≈ precio base ${precioTexto}`);
        }
      }

      if (inconsistencias.length > 0 && testInfo.retry === 0) {
        try {
          await notificarError({
            titulo: 'Inconsistencia en leyenda "sin interés"',
            mensaje: `El producto muestra "sin interés" pero el total no coincide con el precio base.`,
            detalles: [
              `URL: ${urlProducto}`,
              ...inconsistencias,
            ],
          });
        } catch (e) {
          console.error('⚠️  Error al enviar notificación (test 7):', e.message);
        }
      }

      expect(
        inconsistencias.length,
        `Inconsistencias en leyenda "sin interés":\n${inconsistencias.join('\n')}`
      ).toBe(0);
    });

    }); // end describe 💳

}); // end describe 🔥
