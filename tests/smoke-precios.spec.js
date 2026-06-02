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
async function extraerPromosDelDOM(page) {
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
  }, sel);
}

// ─── Helper: navegar al detalle del primer producto disponible ───────────────
// Retorna el productId extraído de la URL, o null si no se pudo navegar.
async function navegarAlPrimerProducto(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  const primerProducto = page.locator(SELECTORS.TARJETA_PRODUCTO).first();
  if ((await primerProducto.count()) === 0) return null;

  // Interceptar la URL antes de navegar para capturar el UUID
  const [response] = await Promise.all([
    page.waitForResponse(
      (resp) =>
        resp.url().includes('ecommerce-fob-server') &&
        resp.url().includes('/publication/') &&
        // Excluir sub-rutas como /stock, /zone
        /\/publication\/[a-f0-9-]{36}$/.test(resp.url()),
      { timeout: 15000 }
    ),
    primerProducto.click(),
  ]);

  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(1500);

  // Extraer UUID del producto desde la URL del endpoint interceptado
  const match = response.url().match(/\/publication\/([a-f0-9-]{36})$/);
  return match ? match[1] : null;
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
  test('Precio correcto en página de detalle de producto', async ({ page }) => {
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

      await notificarError({
        titulo: 'Bug de precios rotos detectado en producción',
        mensaje: `Se encontraron ${preciosRotos.length} precio(s) con overflow en la Home`,
        detalles: preciosRotos.map(
          (p) => `"${p.texto.substring(0, 60)}..." (${p.longitud} caracteres) — clase: ${p.padre}`
        ),
      });
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

    // ── Fixture compartido: navega al detalle e intercepta el endpoint ──────
    // Usamos test.beforeEach implícito via helper para no repetir navegación.
    // Cada test navega por su cuenta para tener contexto limpio.

    // ── Test 5: Al menos una forma de pago tiene cuotas configuradas ────────
    test('Al menos una forma de pago tiene cuotas (> 1 cuota)', async ({ page }, testInfo) => {
      // ── Interceptar la respuesta del endpoint /publication/{uuid} ──────────
      // El backend devuelve los medios de pago dentro del objeto de publicación.
      // Capturamos la primera llamada que matchee el patrón UUID para extraer
      // los datos crudos y compararlos luego con lo renderizado en el DOM.
      let datosBackend = null;

      page.on('response', async (resp) => {
        if (
          /\/publication\/[a-f0-9-]{36}$/.test(resp.url()) &&
          resp.url().includes('phinxlabcore.com') &&
          datosBackend === null
        ) {
          try {
            datosBackend = await resp.json();
          } catch {
            // Si no es JSON ignorar (ej: preflight OPTIONS)
          }
        }
      });

      const productId = await navegarAlPrimerProducto(page);

      if (!productId) {
        console.warn('⚠️  No se pudo navegar a un producto. Test omitido.');
        test.skip();
        return;
      }

      console.log(`\n💳 Producto analizado: ${productId}`);
      console.log(`   URL de detalle: ${page.url()}`);

      // ── Esperar bloque de promos en el DOM ──────────────────────────────
      try {
        await page.waitForSelector(SELECTORS.BLOQUE_PROMOS, { timeout: 10000 });
      } catch {
        console.warn('⚠️  No se encontró el bloque de promos en el DOM.');
        test.skip();
        return;
      }

      const promos = await extraerPromosDelDOM(page, SELECTORS.BLOQUE_PROMOS);

      console.log(`\n   Promos encontradas en DOM: ${promos.length}`);
      promos.forEach((p) =>
        console.log(`     • ${p.textoCompleto} ${p.sinInteres ? '[sin interés]' : '[con interés]'}`)
      );

      // ── Verificar en datos del backend si hay cuotas > 1 ─────────────────
      // Estructura esperada: datosBackend.payment_methods[].installments[]
      // o datosBackend.promotions[].installments — descubrimos el path real
      // inspeccionando datosBackend si está disponible.
      if (datosBackend) {
        // Log del path de medios de pago para que el equipo pueda ajustar
        const keys = Object.keys(datosBackend);
        console.log(`\n   Keys del endpoint /publication: [${keys.join(', ')}]`);

        // Intentar extraer cuotas desde paths conocidos del backend
        const medioPago =
          datosBackend.payment_methods ||
          datosBackend.paymentMethods ||
          datosBackend.promotions ||
          datosBackend.installments ||
          null;

        if (medioPago) {
          console.log(`   Formas de pago en backend: ${JSON.stringify(medioPago).substring(0, 300)}...`);
        } else {
          console.warn('   ⚠️  No se encontró el campo de medios de pago en la respuesta del backend.');
          console.warn('   → Revisar manualmente la estructura en: keys del endpoint listadas arriba.');
        }
      } else {
        console.warn('   ⚠️  No se capturó respuesta del backend (posible caché o timing).');
      }

      // ── Assertion principal: DOM muestra al menos una promo con cuotas > 1 ─
      const promosConCuotas = promos.filter((p) => p.cuotas > 1);

      if (promosConCuotas.length === 0 && testInfo.retry === 0) {
        await page.screenshot({
          path: 'playwright-report/sin-cuotas-configuradas.png',
          fullPage: false,
        });
        await notificarError({
          titulo: 'CA #1 fallido — Ninguna forma de pago tiene cuotas configuradas',
          mensaje: `El producto ${productId} no muestra ninguna promoción con más de 1 cuota.`,
          detalles: [
            `Promos detectadas en DOM: ${promos.length}`,
            ...promos.map((p) => `• ${p.textoCompleto}`),
            promos.length === 0 ? '⚠️ El bloque de promos estaba vacío.' : '',
          ].filter(Boolean),
          screenshotPath: 'playwright-report/sin-cuotas-configuradas.png',
        });
      }

      expect(
        promosConCuotas.length,
        `No se encontró ninguna forma de pago con más de 1 cuota en el detalle del producto.\n` +
        `Promos detectadas: ${promos.map((p) => p.textoCompleto).join(' | ') || 'ninguna'}`
      ).toBeGreaterThan(0);

      console.log(`\n   ✅ Formas de pago con cuotas (> 1): ${promosConCuotas.length}`);
    });

    // ── Test 6: Al menos una forma de pago tiene intereses configurados ──────
    // "Con interés" = la leyenda NO dice "sin interés" en el tercer div
    test('Al menos una forma de pago tiene intereses (cuotas con costo)', async ({ page }, testInfo) => {
      const productId = await navegarAlPrimerProducto(page);

      if (!productId) {
        console.warn('⚠️  No se pudo navegar a un producto. Test omitido.');
        test.skip();
        return;
      }

      try {
        await page.waitForSelector(SELECTORS.BLOQUE_PROMOS, { timeout: 10000 });
      } catch {
        console.warn('⚠️  No se encontró el bloque de promos. Test omitido.');
        test.skip();
        return;
      }

      const promos = await extraerPromosDelDOM(page, SELECTORS.BLOQUE_PROMOS);

      const promosConInteres = promos.filter((p) => !p.sinInteres && p.cuotas > 1);
      const promosSinInteres = promos.filter((p) => p.sinInteres);

      console.log(`\n💳 Producto: ${productId}`);
      console.log(`   Total promos: ${promos.length}`);
      console.log(`   Sin interés: ${promosSinInteres.length}`);
      console.log(`   Con interés: ${promosConInteres.length}`);

      promos.forEach((p) => {
        const etiqueta = p.sinInteres ? '✅ sin interés' : '💰 con interés';
        console.log(`     • [${etiqueta}] ${p.textoCompleto}`);
      });

      // Este test es informativo / de configuración: si el negocio configuró
      // SOLO cuotas sin interés, el test falla como señal de revisión,
      // no necesariamente como bug. Ajustar según política comercial.

      if (promosConInteres.length === 0 && testInfo.retry === 0) {
        await page.screenshot({
          path: 'playwright-report/sin-intereses-configurados.png',
          fullPage: false,
        });
        await notificarError({
          titulo: 'CA #2 fallido — Ninguna forma de pago tiene intereses configurados',
          mensaje: `El producto ${productId} no muestra ninguna promoción con interés.\n` +
            `Si la política comercial es operar 100% sin interés, este test debe marcarse como skip.`,
          detalles: [
            `Total promos: ${promos.length}`,
            `Sin interés: ${promosSinInteres.length}`,
            `Con interés: ${promosConInteres.length}`,
            '─────────────────',
            ...promos.map((p) => `• [${p.sinInteres ? 'sin interés' : 'con interés'}] ${p.textoCompleto}`),
          ],
          screenshotPath: 'playwright-report/sin-intereses-configurados.png',
        });
      }

      expect(
        promosConInteres.length,
        `No se encontró ninguna forma de pago con interés en el detalle del producto.\n` +
        `Si el negocio opera solo con cuotas sin interés, este test puede marcarse como skip.\n` +
        `Promos detectadas: ${promos.map((p) => p.textoCompleto).join(' | ') || 'ninguna'}`
      ).toBeGreaterThan(0);
    });

    // ── Test 7: Consistencia entre DOM y backend para "sin interés" ──────────
    // Compara la leyenda renderizada en el frontend con los datos del backend.
    // Si el BO dice "sin interés" → el DOM debe mostrar "- sin interés".
    // Si el BO dice "con interés" → el DOM NO debe mostrar "- sin interés".
    test('La leyenda "sin interés" en el frontend es consistente con el backend', async ({ page }, testInfo) => {
      let datosBackend = null;
      let endpointUrl  = null;

      page.on('response', async (resp) => {
        if (
          /\/publication\/[a-f0-9-]{36}$/.test(resp.url()) &&
          resp.url().includes('phinxlabcore.com') &&
          datosBackend === null
        ) {
          try {
            datosBackend = await resp.json();
            endpointUrl  = resp.url();
          } catch { /* ignorar */ }
        }
      });

      const productId = await navegarAlPrimerProducto(page);

      if (!productId) {
        console.warn('⚠️  No se pudo navegar a un producto. Test omitido.');
        test.skip();
        return;
      }

      try {
        await page.waitForSelector(SELECTORS.BLOQUE_PROMOS, { timeout: 10000 });
      } catch {
        console.warn('⚠️  No se encontró el bloque de promos. Test omitido.');
        test.skip();
        return;
      }

      const promasDom = await extraerPromosDelDOM(page, SELECTORS.BLOQUE_PROMOS);

      console.log(`\n🔍 Consistencia frontend ↔ backend — Producto: ${productId}`);
      console.log(`   Endpoint capturado: ${endpointUrl || 'no capturado'}`);

      // ── Si no tenemos datos del backend, loguear y omitir la comparación ──
      if (!datosBackend) {
        console.warn(
          '   ⚠️  No se capturaron datos del backend.\n' +
          '   El endpoint puede llegar cacheado antes de que el listener se registre.\n' +
          '   Verificar si el producto ya estaba cacheado en el Service Worker.\n' +
          '   Sugerencia: agregar serviceWorkers: "block" en playwright.config.js'
        );

        // Aun sin datos del backend validamos que el DOM sea internamente consistente:
        // si hay una promo "sin interés" el monto por cuota debe ser menor o igual
        // al precio total dividido las cuotas (tolerancia 5% por redondeo).
        const inconsistenciasDom = [];

        for (const promo of promasDom) {
          if (!promo.sinInteres || promo.cuotas <= 1) continue;

          // Extraer precio total desde el DOM
          const precioTexto = await page.$eval(
            SELECTORS.PRECIO_DETALLE,
            (el) => el.textContent?.trim() || ''
          ).catch(() => '');

          const precioTotal = parseFloat(
            precioTexto.replace('AR$', '').replace(/\./g, '').replace(',', '.').trim()
          );
          const montoCuota = parseFloat(
            promo.monto.replace('AR$', '').replace(/\./g, '').replace(',', '.').trim()
          );

          if (!isNaN(precioTotal) && !isNaN(montoCuota) && precioTotal > 0) {
            const totalCalculado = montoCuota * promo.cuotas;
            const diferenciaPct  = Math.abs(totalCalculado - precioTotal) / precioTotal;

            if (diferenciaPct > 0.05) {
              inconsistenciasDom.push(
                `${promo.cuotas} cuotas de ${promo.monto} = ${totalCalculado.toFixed(2)} ` +
                `vs precio ${precioTotal} (diferencia ${(diferenciaPct * 100).toFixed(1)}%)`
              );
            }
          }
        }

        if (inconsistenciasDom.length > 0) {
          console.error('\n   ❌ Inconsistencias matemáticas en cuotas "sin interés":');
          inconsistenciasDom.forEach((i) => console.error(`     → ${i}`));

          if (testInfo.retry === 0) {
            await notificarError({
              titulo: 'Inconsistencia en cuotas sin interés',
              mensaje: `El monto por cuota no coincide con el precio total en el producto ${productId}`,
              detalles: inconsistenciasDom,
            });
          }

          expect(
            inconsistenciasDom.length,
            `Cuotas "sin interés" con monto incorrecto (diferencia > 5%):\n${inconsistenciasDom.join('\n')}`
          ).toBe(0);
        } else {
          console.log('   ✅ Montos de cuotas sin interés son matemáticamente consistentes.');
        }

        return;
      }

      // ── Tenemos datos del backend: buscar campo de medios de pago ──────────
      // Exploramos paths comunes; el log permite ajustar si cambia la estructura.
      const camposMedioPago = [
        datosBackend.payment_methods,
        datosBackend.paymentMethods,
        datosBackend.promotions,
        datosBackend.best_promotions,
        datosBackend.bestPromotions,
      ].filter(Boolean);

      console.log(`\n   Keys del backend: [${Object.keys(datosBackend).join(', ')}]`);

      if (camposMedioPago.length === 0) {
        // No encontramos el campo — loguear estructura para que el equipo lo mapee
        console.warn(
          '   ⚠️  No se encontró campo de medios de pago en la respuesta.\n' +
          `   Estructura recibida (primeros 500 chars): ${JSON.stringify(datosBackend).substring(0, 500)}\n` +
          '   → Actualizar el helper extraerPromosDelDOM o los paths de camposMedioPago en este test.'
        );

        // No fallamos el test por estructura desconocida, solo informamos
        test.info().annotations.push({
          type: 'warning',
          description: 'Estructura del endpoint /publication desconocida. Revisar manualmente.',
        });
        return;
      }

      // ── Comparación DOM vs backend ─────────────────────────────────────────
      // Para cada promo del DOM con "sin interés" verificamos que el backend
      // también la marque como sin interés.
      const promosDomSinInteres = promasDom.filter((p) => p.sinInteres);
      const inconsistencias = [];

      console.log(`\n   Promos en DOM: ${promasDom.length} (${promosDomSinInteres.length} sin interés)`);

      // Aplanar todos los medios de pago del backend en un array flat
      const medioPagoFlat = camposMedioPago.flat();

      for (const promoDom of promasDom) {
        // Buscar en el backend una promo con el mismo número de cuotas
        const matchBackend = medioPagoFlat.find((mp) => {
          const cuotasBackend =
            mp.installments ?? mp.cuotas ?? mp.quota ?? mp.installment_count ?? null;
          return cuotasBackend === promoDom.cuotas;
        });

        if (!matchBackend) {
          console.warn(
            `   ⚠️  No se encontró en el backend la promo de ${promoDom.cuotas} cuotas ` +
            `(puede estar en otro campo no mapeado)`
          );
          continue;
        }

        // Detectar si el backend marca esta promo como sin interés
        const sinInteresBackend =
          matchBackend.interest_free ??
          matchBackend.interestFree ??
          matchBackend.sin_interes ??
          matchBackend.no_interest ??
          (matchBackend.interest_rate === 0) ??
          false;

        const coincide = promoDom.sinInteres === Boolean(sinInteresBackend);

        if (!coincide) {
          inconsistencias.push(
            `${promoDom.cuotas} cuota(s): ` +
            `DOM dice "${promoDom.sinInteres ? 'sin interés' : 'con interés'}" ` +
            `pero backend dice "${sinInteresBackend ? 'sin interés' : 'con interés'}"`
          );
          console.error(`   ❌ Inconsistencia: ${inconsistencias[inconsistencias.length - 1]}`);
        } else {
          console.log(
            `   ✅ ${promoDom.cuotas} cuota(s): DOM y backend coinciden ` +
            `(${promoDom.sinInteres ? 'sin interés' : 'con interés'})`
          );
        }
      }

      if (inconsistencias.length > 0 && testInfo.retry === 0) {
        await notificarError({
          titulo: 'Inconsistencia cuotas frontend ↔ backend',
          mensaje: `El producto ${productId} tiene discrepancias en la leyenda de intereses`,
          detalles: inconsistencias,
        });
      }

      expect(
        inconsistencias.length,
        `Se encontraron ${inconsistencias.length} inconsistencia(s) entre DOM y backend:\n` +
        inconsistencias.join('\n')
      ).toBe(0);
    });

  }); // end describe 💳

}); // end describe 🔥
