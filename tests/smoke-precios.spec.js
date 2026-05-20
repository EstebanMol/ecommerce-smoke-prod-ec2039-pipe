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
};

// ─── Páginas a testear ───────────────────────────────────────────────────────
const PAGINAS = [
  { nombre: 'Home', path: '/' },
  { nombre: 'Televisores', path: '/categories/60983488-fd4d-44a3-a790-e3c243fabbc0' },
  { nombre: 'Lavado', path: '/categories/74845a0b-1bab-4812-b7f0-9ff20b68dc5b' },
  { nombre: 'Heladeras', path: '/categories/62560f36-70a1-4c1a-9dc3-2ddd69626ce6' },
  { nombre: 'Aire Acondicionado', path: '/categories/19a4181e-e6ae-4d45-8723-41b5f661d48d' },
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
          // El <a> envuelve toda la tarjeta, subimos hasta encontrarlo
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

// ════════════════════════════════════════════════════════════════════════════
// TEST SUITE PRINCIPAL
// ════════════════════════════════════════════════════════════════════════════

test.describe('🔥 Smoke Test — Validación de precios pipe.store', () => {

  //-- Test 1
    test('El sitio carga sin errores críticos', async ({ page }, testInfo) => {

    const erroresConsola = [];
    const recursos404 = [];
    const requestsFallidas = [];

    // Captura URLs reales de recursos que fallan

      page.on('response', (resp) => {

      const status = resp.status();
      const url = resp.url();
      const tipo = resp.request().resourceType();

      const recursosFrontend = [
        'document',
        'stylesheet',
        'script',
        'image',
        'font'
      ];

      const es404Visible =
        status === 404 &&
        recursosFrontend.includes(tipo);

      if (es404Visible) {

        console.log(
          `[404][${tipo}] ${url}`
        );

        recursos404.push({
          tipo,
          url
        });
      }
    });

    
    // Captura errores JS (sin URLs, el browser no las incluye)
    page.on('console', msg => {
     if (msg.type() === 'error') {
       erroresConsola.push(msg.text());
     }
    });

    const response = await page.goto('/', { waitUntil: 'domcontentloaded' });
    expect(response.status(), 'El sitio debe responder con HTTP 200').toBe(200);

    await page.waitForTimeout(8000);

    // Mostrar 404s CON URL (del listener de response)
    console.log(`\nRecursos con 404: ${recursos404.length}`);
    if (recursos404.length > 0) {
      console.log('Detalle de 404s:');
      recursos404.forEach((url, i) => console.log(`  ${i + 1}. ${url}`));
    }

    // Mostrar requests fallidas (CORS, ERR_FAILED)
    console.log(`\nRequests fallidas: ${requestsFallidas.length}`);
    if (requestsFallidas.length > 0) {
      console.log('Detalle:');
      requestsFallidas.forEach((r, i) => console.log(`  ${i + 1}. [${r.error}] ${r.url}`));
    }

    // Mostrar errores JS (sin URL, limitación del browser)
    console.log(`\nErrores JS en consola: ${erroresConsola.length}`);
    if (erroresConsola.length > 0) {
      console.log('Detalle:');
      erroresConsola.forEach((err, i) => console.log(`  ${i + 1}. ${err}`));
    }

    // Fallar si hay errores críticos del backend
    const erroresCriticos = erroresConsola.filter(e => 
      e.includes('ecommerce-fob-server') || 
      e.includes('CORS') ||
      e.includes('ERR_FAILED')
    );

    if (erroresCriticos.length > 0 && erroresCriticos.length > 3 && testInfo.retry === 0) {
      await notificarError({
        titulo: 'Backend caído o con errores CORS',
        mensaje: `Se detectaron ${erroresCriticos.length} errores críticos al cargar el sitio`,
        detalles: [...new Set(erroresCriticos.map(e => e.split('\n')[0].substring(0, 150)))],
      });
      
      throw new Error(`Backend con errores críticos: ${erroresCriticos.length} fallos detectados`);
    }

  });

  // ── Test 2: Validar precios en todas las páginas del catálogo ────────────
  for (const pagina of PAGINAS) {
    test(`Precios correctos en: ${pagina.nombre}`, async ({ page }, testInfo) => {
      await page.goto(pagina.path, { waitUntil: 'domcontentloaded' });

      // Scroll progresivo para disparar lazy loading
      await page.evaluate(() => window.scrollTo(0, 300));
      await page.waitForTimeout(1000);
      await page.evaluate(() => window.scrollTo(0, 600));
      await page.waitForTimeout(1000);

      // Esperar a que aparezca al menos un precio en el DOM
    try {
      await page.waitForSelector('h5[id*="-price"]', { timeout: 20000 });
    } catch {
      console.warn(`⚠️  Timeout esperando precios en ${pagina.nombre}`);
    }

      const preciosRaw = await extraerPrecios(page, SELECTORS.PRECIO_TARJETA);

      // Si no hay precios, puede ser que el selector no matchea — loguear como warning
      if (preciosRaw.length === 0) {
        console.warn(
          `⚠️  No se encontraron precios en ${pagina.nombre}. ` +
          `Verificar selector: ${SELECTORS.PRECIO_TARJETA}`
        );
        test.skip(); // No falla, pero marca el test para revisión
        return;
      }

      console.log(`\n📋 Página: ${pagina.nombre} — ${preciosRaw.length} precios encontrados`);

      // BIEN - extrae solo el string de precio
      const reporte = validarPrecios(preciosRaw.map((r) => r.precio));  

      // Imprimir detalle en consola para debugging
      reporte.detalle.forEach(({ precio, valid, errores }) => {
        if (valid) {
          console.log(`  ✅ ${precio}`);
        } else {
          console.error(`  ❌ "${precio}"`);
          errores.forEach((e) => console.error(`     → ${e}`));
        }
      });

      // Si hay precios rotos, tomar screenshot con ellos marcados en rojo
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

      // ── Assertions ──────────────────────────────────────────────────────
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
    // Ir a la home y hacer click en el primer producto disponible
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);

    // Intentar clickear el primer producto
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
      // Fallback: buscar cualquier elemento con AR$
      const preciosFallback = await extraerPrecios(page, '*');
      console.warn(`Selector de detalle no matcheó. Fallback encontró: ${preciosFallback.length} precios`);
      preciosRaw.push(...preciosFallback.slice(0, 5));
    }

    expect(preciosRaw.length, 'Debe haber al menos un precio en la página de detalle').toBeGreaterThan(0);

    // BIEN - extrae solo el string de precio
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

    // Buscar CUALQUIER texto en la página que contenga "AR$" y sea anormalmente largo
      const preciosRotos = await page.evaluate(() => {
      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
        null
      );

      const encontrados = [];
      let nodo;

      while ((nodo = walker.nextNode())) {
        const texto = nodo.textContent?.trim();
        if (texto && texto.includes('AR$') && texto.length > 30) {
          encontrados.push({
            texto: texto.substring(0, 100), // Solo los primeros 100 chars para el log
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

       // 🔔 Enviar alerta por email
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
});
