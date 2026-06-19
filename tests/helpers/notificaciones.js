const sgMail = require('@sendgrid/mail');
const fs = require('fs');
const path = require('path');

sgMail.setApiKey(process.env.SENDGRID_KEY);

function formatearDetalle(texto) {
  // Si el texto contiene una URL, convertirla en link clicable
  return texto.replace(
    /(https?:\/\/[^\s<>"]+)/g,
    '<a href="$1" style="color:#0066cc;">$1</a>'
  );
}

async function notificarError({ titulo, mensaje, detalles = [], screenshotPath = null }) {
  const listaErrores = detalles
    .map((d, i) => `<li>${i + 1}. ${formatearDetalle(d)}</li>`)
    .join('');

  const html = `
    <h2 style="color: #cc0000;">🚨 Error detectado en producción</h2>
    <p><strong>${mensaje}</strong></p>
    ${detalles.length > 0 ? `<h3>Detalle:</h3><ul>${listaErrores}</ul>` : ''}
    ${screenshotPath ? `<h3>Captura de pantalla:</h3><img src="cid:screenshot" style="max-width:100%; border:1px solid #ccc;"/>` : ''}
    <hr/>
    <p style="color: #666; font-size: 12px;">
      Generado automáticamente por Playwright Smoke Tests<br/>
      Fecha: ${new Date().toLocaleString('es-AR')}
    </p>
  `;

  const attachments = [];
  if (screenshotPath && fs.existsSync(screenshotPath)) {
    const imageData = fs.readFileSync(screenshotPath).toString('base64');
    attachments.push({
      content: imageData,
      filename: path.basename(screenshotPath),
      type: 'image/png',
      disposition: 'inline',
      content_id: 'screenshot',
    });
  }

  try {
    await sgMail.send({
      to: process.env.MAIL_TO,
      from: process.env.MAIL_FROM,
      subject: `🚨 [pipe.store DEV] ${titulo}`,
      html,
      attachments,
    });
    console.log(`📧 Notificación enviada: ${titulo}`);
  } catch (error) {
    console.error(`❌ Error enviando notificación: ${error.message}`);
  }
}

module.exports = { notificarError };
