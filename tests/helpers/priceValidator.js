// tests/helpers/priceValidator.js

/**
 * Reglas de validación para precios de pipe.store
 * Detecta el bug conocido de precios "rotos" (ej: AR$ 179.769.313.486.231.570.000...)
 */

const PRECIO_RULES = {
  PREFIX: 'AR$',
  MAX_LENGTH: 20,        // era 20 — precios como "AR$ 10.888.886,67" tienen 18 chars
  MAX_DIGITS: 12,        // era 10 — ese precio tiene exactamente 10 dígitos
  MIN_VALUE: 1_000,
  MAX_VALUE: 999_999_999, // era 99_999_999 — subimos el techo a ~1 millón de dólares
};

/**
 * Extrae el valor numérico de un string de precio argentino
 * Ej: "AR$ 249.999,00" → 249999.00
 * @param {string} rawPrice
 * @returns {number}
 */
function parsePrecioARS(rawPrice) {
  // Remover prefijo y espacios
  const sinPrefijo = rawPrice.replace('AR$', '').trim();

  // Formato argentino: puntos como separadores de miles, coma como decimal
  // "249.999,00" → "249999.00"
  const normalizado = sinPrefijo
    .replace(/\./g, '')   // quitar puntos de miles
    .replace(',', '.');   // coma decimal → punto

  return parseFloat(normalizado);
}

/**
 * Valida un precio individual y retorna un objeto con el resultado
 * @param {string} rawPrice - Texto del precio tal como aparece en la UI
 * @returns {{ valid: boolean, precio: string, errores: string[] }}
 */
function validarPrecio(rawPrice) {
  const errores = [];
  const precio = rawPrice.trim();

  // 1. Debe contener el prefijo de moneda
  if (!precio.includes(PRECIO_RULES.PREFIX)) {
    errores.push(`No contiene "${PRECIO_RULES.PREFIX}" — valor: "${precio}"`);
  }

  // 2. Longitud razonable (un precio roto es extremadamente largo)
  if (precio.length >= PRECIO_RULES.MAX_LENGTH) {
    errores.push(
      `Longitud sospechosa: ${precio.length} caracteres (máx esperado: ${PRECIO_RULES.MAX_LENGTH})`
    );
  }

  // 3. Cantidad de dígitos numéricos
  const soloDigitos = precio.replace(/\D/g, '');
  if (soloDigitos.length === 0) {
    errores.push('No contiene dígitos numéricos');
  } else if (soloDigitos.length >= PRECIO_RULES.MAX_DIGITS) {
    errores.push(
      `Demasiados dígitos: ${soloDigitos.length} (máx esperado: ${PRECIO_RULES.MAX_DIGITS}) — posible precio roto`
    );
  }

  // 4. Valor numérico dentro de rango razonable
  const valorNumerico = parsePrecioARS(precio);
  if (!isNaN(valorNumerico)) {
    if (valorNumerico < PRECIO_RULES.MIN_VALUE) {
      errores.push(`Precio demasiado bajo: ${valorNumerico} (mín: ${PRECIO_RULES.MIN_VALUE})`);
    }
    if (valorNumerico > PRECIO_RULES.MAX_VALUE) {
      errores.push(
        `Precio absurdamente alto: ${valorNumerico} (máx: ${PRECIO_RULES.MAX_VALUE}) — posible precio roto`
      );
    }
  }

  // 5. No debe tener saltos de línea ni ser multi-línea en la UI
  if (/\n/.test(precio)) {
    errores.push('Precio contiene saltos de línea — indica overflow en la UI');
  }

  return {
    valid: errores.length === 0,
    precio,
    errores,
  };
}

/**
 * Valida un array de precios y retorna un reporte completo
 * @param {string[]} precios
 * @returns {{ total: number, validos: number, invalidos: number, detalle: object[] }}
 */
function validarPrecios(precios) {
  const detalle = precios.map(validarPrecio);
  const validos = detalle.filter((r) => r.valid).length;

  return {
    total: precios.length,
    validos,
    invalidos: detalle.filter((r) => !r.valid).length,
    detalle,
  };
}

module.exports = { validarPrecio, validarPrecios, parsePrecioARS, PRECIO_RULES };
