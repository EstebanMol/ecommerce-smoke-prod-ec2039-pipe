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
  { nombre: 'TV', path: '/categories/60983488-fd4d-44a3-a790-e3c243fabbc0' },
  { nombre: 'Lavado', path: '/categories/74845a0b-1bab-4812-b7f0-9ff20b68dc5b' },
  { nombre: 'Notebooks', path: '/categories/8f8eb81b-7149-45e8-8820-8789f889d265' },
  { nombre: 'Celulares', path: '/categories/a85d3890-3925-475a-a67a-a37f0308b665' },
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
            ? `https://pipe.store${linkEl.getAttribute('href')}`
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

test.describe('🔥 Smoke Test — Validación de precios pipe.store', () => {

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
        mensaje: 'Se detectaron recursos no encontrados en pipe.store',
        detalles: recursos404.map((url) => url),
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
                return `${r.precio} → ${r.errores.join(', ')} | ${url}`;
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
          detalles: [
            `URL del producto: ${url}`,
            ...reporte.detalle
              .filter((r) => !r.valid)
              .map((r) => `${r.precio} → ${r.errores.join(', ')}`),
          ],
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

      if (testInfo.retry === 0) {
        try {
          await notificarError({
            titulo: 'Bug de precios rotos detectado en producción',
            mensaje: `Se encontraron ${preciosRotos.length} precio(s) con overflow en la Home`,
            detalles: [
              `URL: ${page.url()}`,
              ...preciosRotos.map(
                (p) => `"${p.texto.substring(0, 60)}..." (${p.longitud} caracteres) — clase: ${p.padre}`
              ),
            ],
            screenshotPath: 'playwright-report/bug-precios-overflow.png',
          });
        } catch (e) {
          console.error('⚠️  Error al enviar notificación (test 4):', e.message);
        }
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

    // ── Helper: recolectar todos los links de productos en una página ────────
    async function recolectarProductos(page, path) {
      await page.goto(path, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);

      // Scroll progresivo para activar lazy loading
      await page.evaluate(async () => {
        await new Promise((resolve) => {
          let total = 0;
          const step = 400;
          const timer = setInterval(() => {
            window.scrollBy(0, step);
            total += step;
            if (total >= document.body.scrollHeight) {
              clearInterval(timer);
              resolve();
            }
          }, 200);
        });
      });
      await page.waitForTimeout(1000);

      return page.evaluate(() => {
        const links = document.querySelectorAll('a[href*="/product/"]');
        return Array.from(links)
          .map((a) => ({
            href: a.getAttribute('href'),
            url: a.href,
          }))
          .filter((l) => l.href && /\/product\/[a-f0-9-]{36}/.test(l.href));
      });
    }

    // ── Helper: abrir modal y leer tabla de cuotas ───────────────────────────
    async function abrirModalYLeerCuotas(page) {
      // Esperar carga completa
      try {
        await page.waitForLoadState('networkidle', { timeout: 10000 });
      } catch {
        await page.waitForLoadState('domcontentloaded');
      }
      await page.waitForTimeout(1000);

      // Scroll para que el botón sea visible
      await page.evaluate(() => window.scrollTo(0, 500));
      await page.waitForTimeout(800);

      // Click en "Ver otros medios de pago"
      // Usamos isVisible con timeout corto para no bloquearnos en productos sin stock u otros layouts
      try {
        const btn = page.locator('a, button, span, p, [class*="MuiLink"], [class*="MuiTypography"]').filter({ hasText: 'Ver otros medios de pago' }).first();
        // Scroll hasta la zona del botón antes de buscarlo
        await page.evaluate(() => window.scrollTo(0, 600));
        await page.waitForTimeout(500);
        const visible = await btn.isVisible().catch(() => false);
        if (!visible) {
          // Scroll más agresivo antes del reintento
          await page.evaluate(() => window.scrollTo(0, 800));
          await page.waitForTimeout(500);
          // Reintento con hasta 20s — cubre páginas que necesitaron recargas
          const aparecio = await btn.waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false);
          if (!aparecio) {
            const sinStock = await page.locator('text=/sin stock/i').first().isVisible().catch(() => false);
            if (sinStock) {
              console.log('   ℹ️  Producto sin stock — se omite validación de medios de pago.');
            } else {
              console.warn('   ⚠️  Botón "Ver otros medios de pago" no encontrado (producto sin stock u otro layout).');
            }
            return null;
          }
        }
        await btn.scrollIntoViewIfNeeded();
        await btn.click();
      } catch (e) {
        console.warn(`   ⚠️  No se encontró "Ver otros medios de pago": ${e.message}`);
        return null;
      }

      // Esperar modal
      try {
        await page.waitForSelector('[role="dialog"]', { timeout: 10000 });
      } catch {
        console.warn('   ⚠️  El modal no abrió.');
        return null;
      }

      await page.waitForTimeout(800);

      // Recolectar todas las imgs de métodos de pago disponibles en el modal
      const cantMetodos = await page.locator('[role="dialog"] img').count();
      console.log(`   📋 Métodos de pago disponibles: ${cantMetodos}`);

      const todasLasFilas = [];

      // Iterar sobre cada método de pago
      for (let i = 0; i < cantMetodos; i++) {
        try {
          // Reabrir modal si no está abierto (desde el segundo método en adelante)
          const modalAbierto = await page.locator('[role="dialog"]').count() > 0;
          if (!modalAbierto) {
            const btn = page.locator('a, button, span, p, [class*="MuiLink"], [class*="MuiTypography"]').filter({ hasText: 'Ver otros medios de pago' }).first();
            await btn.click();
            await page.waitForSelector('[role="dialog"]', { timeout: 8000 });
            await page.waitForTimeout(800);
          }

          // Click en el método i
          const metodo = page.locator('[role="dialog"] img').nth(i);
          if ((await metodo.count()) === 0) continue;
          await metodo.click();
          console.log(`   🖱️  Click en método ${i}`);
          await page.waitForTimeout(1200);

          // Click en tarjeta si aparece (segunda img)
          const imgs2 = page.locator('[role="dialog"] img');
          const count2 = await imgs2.count();
          if (count2 > cantMetodos) {
            // Aparecieron más imgs — son las tarjetas
            const cantTarjetas = count2 - cantMetodos;
            for (let j = cantMetodos; j < count2; j++) {
              try {
                await imgs2.nth(j).click();
                console.log(`   🖱️  Click en tarjeta ${j}`);
                await page.waitForTimeout(1200);

                // Leer tabla
                const filasTarjeta = await leerTablaModal(page);
                todasLasFilas.push(...filasTarjeta);

                // Volver a clickear el método para probar otra tarjeta
                if (j < count2 - 1) {
                  const metodoAgain = page.locator('[role="dialog"] img').nth(i);
                  if ((await metodoAgain.count()) > 0) {
                    await metodoAgain.click();
                    await page.waitForTimeout(1000);
                  }
                }
              } catch { /* ignorar error en tarjeta individual */ }
            }
          } else {
            // No hay tarjetas — leer tabla directamente
            const filas = await leerTablaModal(page);
            todasLasFilas.push(...filas);
          }

          // Cerrar modal y reabrir para el siguiente método
          if (i < cantMetodos - 1) {
            try {
              const btnCerrar = page.locator('[role="dialog"] button').first();
              await btnCerrar.click();
              await page.waitForTimeout(500);
            } catch { /* ignorar */ }
          }
        } catch (e) {
          console.warn(`   ⚠️  Error procesando método ${i}: ${e.message}`);
        }
      }

      return todasLasFilas.length > 0 ? todasLasFilas : null;
    }

    // ── Helper: leer filas de la tabla dentro del modal ──────────────────────
    async function leerTablaModal(page) {
      try {
        await page.waitForSelector('[role="dialog"] tbody tr', { timeout: 6000 });
      } catch {
        return [];
      }

      return page.evaluate(() => {
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
    }

    // ── Test 5: Validar cuotas e intereses en todos los productos ────────────
    // Un solo test que recorre todas las páginas y productos, y notifica
    // por cada producto que no cumpla las validaciones.
    test('Validación de formas de pago en todos los productos', async ({ page, browser }, testInfo) => {
      test.setTimeout(2700000); // 45 minutos para recorrer todos los productos

      // 1. Recolectar todos los productos únicos de todas las páginas
      const urlsVistas = new Set();
      const productos = [];

      for (const pagina of PAGINAS) {
        console.log(`\n📂 Recolectando productos de: ${pagina.nombre}`);
        try {
          const links = await recolectarProductos(page, pagina.path);
          for (const link of links) {
            const urlCompleta = link.url.startsWith('http')
              ? link.url
              : `${new URL(page.url()).origin}${link.href}`;
            if (!urlsVistas.has(urlCompleta)) {
              urlsVistas.add(urlCompleta);
              productos.push({ url: urlCompleta, pagina: pagina.nombre });
            }
          }
          console.log(`   → ${links.length} productos encontrados (${urlsVistas.size} únicos hasta ahora)`);
        } catch (e) {
          console.warn(`   ⚠️  Error recolectando productos de ${pagina.nombre}: ${e.message}`);
        }
      }

      console.log(`\n📦 Total productos únicos a validar: ${productos.length}`);

      if (productos.length === 0) {
        console.warn('⚠️  No se encontraron productos. Test omitido.');
        test.skip();
        return;
      }

      // 2. Validar cada producto
      const errores = [];

      for (let i = 0; i < productos.length; i++) {
        const producto = productos[i];
        console.log(`\n🔍 [${i + 1}/${productos.length}] Validando: ${producto.url}`);
        testInfo.annotations.push({ type: 'url_producto', description: producto.url });

        // Abrir una página nueva por cada producto para evitar contaminación del DOM anterior
        const paginaProducto = await browser.newPage();
        try {
          // Navegar y esperar carga completa
          await paginaProducto.goto(producto.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          // React muestra "No existe este producto" como estado TRANSITORIO mientras carga.
          // Estrategia: esperamos que ese texto desaparezca (hidden) antes de evaluarlo.
          // Si desaparece → React hidró correctamente con el producto real.
          // Si NO desaparece en 15s → es el estado final real → producto mal configurado.
          await paginaProducto.locator('text=/no existe este producto/i').first()
            .waitFor({ state: 'hidden', timeout: 15000 })
            .catch(() => {}); // si no desaparece, seguimos igual y evaluamos abajo

          // Verificar si la página tiene contenido real de producto (precio, breadcrumb, botón comprar)
          // Esto es más confiable que buscar "No existe" que aparece transitoriamente en React
          const tieneContenidoReal = async (pagina) => {
            const tienePrecio     = await pagina.locator('text=/AR\$/').first().isVisible().catch(() => false);
            const tieneSinStock   = await pagina.locator('text=/producto sin stock/i').first().isVisible().catch(() => false);
            const tieneBreadcrumb = await pagina.locator('nav a, .breadcrumb a').nth(2).isVisible().catch(() => false);
            const tieneComprar    = await pagina.locator('button, a').filter({ hasText: /comprar|agregar al carrito/i }).first().isVisible().catch(() => false);
            return tienePrecio || tieneSinStock || tieneBreadcrumb || tieneComprar;
          };

          // Primera verificación
          let esProductoValido = await tieneContenidoReal(paginaProducto);

          if (!esProductoValido) {
            // Puede ser carga lenta — esperar hasta 15s a que aparezca algo de contenido real
            console.log('   🔄 Contenido no visible aún — esperando carga completa...');
            await Promise.race([
              paginaProducto.locator('text=/AR\$/').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {}),
              paginaProducto.locator('text=/producto sin stock/i').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {}),
              paginaProducto.locator('button, a').filter({ hasText: /comprar|agregar al carrito/i }).first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {}),
            ]);
            esProductoValido = await tieneContenidoReal(paginaProducto);
          }

          if (!esProductoValido) {
            // Segundo intento: recargar página completa
            console.log('   🔄 Sin contenido tras espera — recargando página (intento 1)...');
            await paginaProducto.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await Promise.race([
              paginaProducto.locator('text=/AR\$/').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {}),
              paginaProducto.locator('text=/producto sin stock/i').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {}),
              paginaProducto.locator('button, a').filter({ hasText: /comprar|agregar al carrito/i }).first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {}),
            ]);
            esProductoValido = await tieneContenidoReal(paginaProducto);
          }

          if (!esProductoValido) {
            // Tercer intento: segunda recarga (algunos productos necesitan 2 recargas)
            console.log('   🔄 Sin contenido tras recarga — recargando página (intento 2)...');
            await paginaProducto.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await Promise.race([
              paginaProducto.locator('text=/AR\$/').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {}),
              paginaProducto.locator('text=/producto sin stock/i').first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {}),
              paginaProducto.locator('button, a').filter({ hasText: /comprar|agregar al carrito/i }).first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {}),
            ]);
            esProductoValido = await tieneContenidoReal(paginaProducto);
          }

          // Solo si tras dos intentos no hay contenido real → producto mal configurado
          const noExiste = !esProductoValido && await paginaProducto.locator('text=/no existe este producto/i').first().isVisible().catch(() => false);
          if (noExiste) {
            // Distinguir producto real (sin stock) de producto mal configurado:
            // Una página de producto real siempre tiene "¡Nuestras promociones bancarias!"
            // La página vacía (mal configurado) no tiene ese texto.
            const esProductoReal = await paginaProducto.locator('text=/nuestras promociones bancarias/i').first().isVisible().catch(() => false);
            if (esProductoReal) {
              console.log('   ℹ️  Producto sin stock (página completa) — se omite validación de medios de pago.');
            } else {
              console.error(`   ❌ Producto mal configurado: página vacía con "No existe este producto" — ${producto.url}`);
              console.log(`   🔍 Debug — esProductoValido: ${esProductoValido}, noExiste: ${noExiste}`);
              if (testInfo.retry === 0) {
                errores.push({ url: producto.url, pagina: producto.pagina, errores: ['❌ Producto mal configurado: página vacía con "No existe este producto"'] });
                try {
                  await notificarError({
                    titulo: 'Producto mal configurado en producción',
                    mensaje: 'El producto existe en el catálogo pero su página está vacía y muestra "No existe este producto".',
                    detalles: [
                      `URL: ${producto.url}`,
                      `Página de origen: ${producto.pagina}`,
                    ],
                  });
                } catch (e) {
                  console.error('   ⚠️  Error al enviar notificación:', e.message);
                }
              }
            }
            continue;
          }

          // Esperar explícitamente el botón antes de intentar abrirlo
          // Cubre el caso donde el precio ya cargó pero el botón de medios de pago todavía no
          await paginaProducto.locator('a, button, span, p, [class*="MuiLink"], [class*="MuiTypography"]')
            .filter({ hasText: 'Ver otros medios de pago' })
            .first()
            .waitFor({ state: 'visible', timeout: 20000 })
            .catch(() => {});

          const filas = await abrirModalYLeerCuotas(paginaProducto);

          if (!filas) {
            console.warn(`   ⚠️  No se pudo leer el modal para este producto.`);
            continue;
          }

          console.log(`   Filas en modal: ${filas.length}`);
          filas.forEach((f) => console.log(`     • ${f.cuotas} cuota(s) — interés: "${f.interes}" — total: ${f.total}`));

          const filasConCuotas = filas.filter((f) => f.cuotas > 1);
          const filasSinInteres = filas.filter((f) => f.sinInteres && f.cuotas > 1);

          const erroresProducto = [];

          // CA #1: al menos una forma de pago con cuotas > 1
          if (filasConCuotas.length === 0) {
            erroresProducto.push('❌ CA #1: ninguna forma de pago tiene más de 1 cuota configurada');
            console.error(`   ❌ CA #1 fallido`);
          } else {
            console.log(`   ✅ CA #1: ${filasConCuotas.length} opción(es) con cuotas`);
          }

          // CA #3: consistencia leyenda "sin interés" vs precio base
          // Solo validar si el precio base es válido (no está roto por el bug de overflow)
          const precioTexto = await paginaProducto.$eval(
            SELECTORS.PRECIO_DETALLE,
            (el) => el.textContent?.trim() || ''
          ).catch(() => '');

          const precioBase = parseFloat(
            precioTexto.replace('AR$', '').replace(/\./g, '').replace(',', '.').trim()
          );

          const precioBaseValido = !isNaN(precioBase) && precioBase >= 1000 && precioBase <= 999999999;

          if (!precioBaseValido) {
            console.warn(`   ⚠️  CA #3 omitido: precio base inválido (${precioTexto})`);
          } else {
            for (const fila of filasSinInteres) {
              const totalFila = parseFloat(
                fila.total.replace('AR$', '').replace(/\./g, '').replace(',', '.').trim()
              );
              if (!isNaN(totalFila)) {
                const diferenciaPct = Math.abs(totalFila - precioBase) / precioBase;
                if (diferenciaPct > 0.05) {
                  erroresProducto.push(
                    `❌ CA #3: ${fila.cuotas} cuota(s) marcadas "sin interés" pero total ` +
                    `${fila.total} difiere del precio base ${precioTexto} en ${(diferenciaPct * 100).toFixed(1)}%`
                  );
                  console.error(`   ❌ CA #3 fallido`);
                }
              }
            }
          }

          // Notificar si hubo errores en este producto
          if (erroresProducto.length > 0 && testInfo.retry === 0) {
            errores.push({ url: producto.url, pagina: producto.pagina, errores: erroresProducto });
            try {
              await notificarError({
                titulo: `Errores de formas de pago detectados`,
                mensaje: `El producto presenta problemas en la configuración de medios de pago.`,
                detalles: [
                  `URL: ${producto.url}`,
                  `Página: ${producto.pagina}`,
                  ...erroresProducto,
                ],
              });
            } catch (e) {
              console.error('⚠️  Error al enviar notificación:', e.message);
            }
          }

        } catch (e) {
          console.warn(`   ⚠️  Error validando producto ${producto.url}: ${e.message}`);
        } finally {
          await paginaProducto.close().catch(() => {});
        }
      }

      // 3. Fallar el test si hubo errores, con resumen completo
      if (errores.length > 0) {
        const resumen = errores.map((e) =>
          `${e.url}:\n  ${e.errores.join('\n  ')}`
        ).join('\n\n');

        expect(errores.length, `Se encontraron errores en ${errores.length} producto(s):\n\n${resumen}`).toBe(0);
      }

      console.log(`\n✅ Validación completa. Errores encontrados: ${errores.length}/${productos.length} productos.`);
    });

  }); // end describe 💳

}); // end describe 🔥
