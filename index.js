const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ─── CONFIGURACION ────────────────────────────────────────────────
const NOMBRE_GRUPO_DOCIFY = 'ACTA DOCIFY 13 - GONZALEZ';

// Grupos donde el bot NO debe responder aunque detecte RFC o idCIF
const GRUPOS_IGNORADOS = [
    'id Cif Daniel pagos diarios',
];

const CSF_URL  = 'https://constancia-7xk29.vercel.app/';
const CSF_USER = 'daniel.gonzalez';
const CSF_PASS = 'GonzalezCIF26';

// Tu numero de WhatsApp (para recibir alertas cuando algo falla)
// Formato: 521 + 10 digitos + @c.us  ej: '5219821108077@c.us'
const NUMERO_DANIEL = '5219821042410@c.us';


const RFC_REGEX   = /\b([A-Z&Ñ]{3,4}\d{6}[A-Z0-9]{3})\b/i;
const CURP_REGEX  = /[A-Z]{4}\d{6}[HM][A-Z]{5}[A-Z0-9]\d/i;
const IDCIF_REGEX = /\bID\s*(\d{8,11})\b/i; // Requiere prefijo 'ID' para evitar falsos positivos

const solicitudesActa = new Map();
const esperandoCurp   = new Map();
const esperandoIdCIF  = new Map();
const tipoActaPendiente  = new Map(); // numeroCliente -> 'NACIMIENTO'|'MATRIMONIO'|'DIVORCIO'|'DEFUNCION'
const esperandoImagenCSF = new Map(); // numeroCliente -> true si el bot pidio imagen de constancia

// ─── COLA DE GENERACION CSF ───────────────────────────────────────
const colaCSF = []; // { rfc, idcif, numeroCliente, resolve }
let procesandoCSF = false;
// ─────────────────────────────────────────────────────────────────

// ─── FUNCION: Validar formato de CURP y dar retroalimentación específica ─
function validarCURP(texto) {
    // Extraemos solo lo que parece un intento de CURP: letras y numeros juntos, sin espacios,
    // de tamaño parecido a 18 (entre 14 y 22 para detectar intentos con error)
    const intento = texto.toUpperCase().match(/\b[A-Z0-9]{14,22}\b/);
    if (!intento) return null; // No parece ni un intento de CURP, ignoramos

    const valor = intento[0];

    // Si ya es una CURP perfecta, no hay error que reportar
    if (CURP_REGEX.test(valor) && valor.length === 18) return null;

    const errores = [];

    if (valor.length < 18) {
        errores.push(`Le faltan caracteres: tiene ${valor.length}, debe tener 18.`);
    } else if (valor.length > 18) {
        errores.push(`Tiene caracteres de más: tiene ${valor.length}, debe tener 18.`);
    } else {
        // Tiene 18 caracteres pero el formato no es válido, revisamos parte por parte
        if (!/^[A-Z]{4}/.test(valor)) errores.push('Los primeros 4 caracteres deben ser letras.');
        if (!/^[A-Z]{4}\d{6}/.test(valor)) errores.push('Los caracteres 5 al 10 deben ser números (fecha de nacimiento AAMMDD).');
        if (!/^[A-Z]{4}\d{6}[HM]/.test(valor)) errores.push('El carácter 11 debe ser H (hombre) o M (mujer).');
        if (!/^[A-Z]{4}\d{6}[HM][A-Z]{5}/.test(valor)) errores.push('Los caracteres 12 al 16 deben ser letras.');
        if (!/\d$/.test(valor)) errores.push('El último carácter debe ser un número.');
        if (errores.length === 0) errores.push('El formato no es válido.');
    }

    return { valor, errores };
}


const server = http.createServer((req, res) => { res.writeHead(200); res.end('Bot activo'); });
server.listen(process.env.PORT || 3000);

// ─── LIMPIEZA DE ESTADOS: eliminar sesiones inactivas cada 30 min ─
const TIMEOUT_SESION = 30 * 60 * 1000; // 30 minutos
setInterval(() => {
    const ahora = Date.now();
    for (const [key, val] of esperandoIdCIF.entries()) {
        if (val.ts && ahora - val.ts > TIMEOUT_SESION) {
            esperandoIdCIF.delete(key);
            esperandoCurp.delete(key);
            tipoActaPendiente.delete(key);
            esperandoImagenCSF.delete(key);
            console.log(`🧹 Sesion expirada limpiada: ${key}`);
        }
    }
}, TIMEOUT_SESION);

// ─── FUNCION: Generar CSF ─────────────────────────────────────────
async function generarCSF(rfc, idcif) {
    // Cargar puppeteer compatible con CommonJS y ESM
    let puppeteer;
    try {
        puppeteer = require('puppeteer');
    } catch(e) {
        try {
            // puppeteer-core v21+ es ESM — usar dynamic import
            const mod = await import('puppeteer-core');
            puppeteer = mod.default || mod;
        } catch(e2) {
            console.error('❌ No se pudo cargar puppeteer ni puppeteer-core:', e2.message);
            return null;
        }
    }

    console.log(`🌐 Generando CSF: RFC=${rfc} idCIF=${idcif}`);

    const downloadPath = path.join(process.cwd(), 'descargas', `req_${Date.now()}`);
    if (!fs.existsSync(path.join(process.cwd(), 'descargas'))) fs.mkdirSync(path.join(process.cwd(), 'descargas'));
    fs.mkdirSync(downloadPath, { recursive: true });

    // puppeteer-core requiere especificar la ruta del ejecutable de Chrome.
    // Buscamos Chrome en las rutas más comunes de Windows.
    const rutasChrome = [
        // Linux (Railway/servidor)
        process.env.CHROMIUM_PATH || '',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        // Windows (local)
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        (process.env.LOCALAPPDATA || '') + '\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    ].filter(Boolean);
    const executablePath = rutasChrome.find(p => { try { return fs.existsSync(p); } catch(e) { return false; } });
    if (executablePath) console.log(`🌐 Usando navegador: ${executablePath}`);

    const browser = await puppeteer.launch({
        headless: true,
        executablePath: executablePath || undefined, // undefined = puppeteer usa su propio Chromium
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    try {
        const page = await browser.newPage();

        // Configurar descarga — compatible con puppeteer v19 (target) y v21+ (createCDPSession)
        let cdpSession;
        try {
            cdpSession = await page.createCDPSession();          // puppeteer v21+
        } catch(e) {
            cdpSession = await page.target().createCDPSession(); // puppeteer v19
        }
        await cdpSession.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath });

        // Ir a la pagina
        await page.goto(CSF_URL, { waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise(r => setTimeout(r, 1000));

        // Si ya hay una sesion activa (de un intento anterior fallido), cerrarla primero
        const sesionPrevia = await page.evaluate(() => {
            const btns = document.querySelectorAll('button');
            for (const btn of btns) {
                if (btn.textContent.toLowerCase().includes('cerrar sesión')) {
                    btn.click();
                    return true;
                }
            }
            return false;
        });
        if (sesionPrevia) {
            console.log('🔄 Sesión previa detectada, cerrando...');
            await new Promise(r => setTimeout(r, 2000));
        }

        // Login — llenar usuario y contraseña
        await page.evaluate((user, pass) => {
            const inputs = document.querySelectorAll('input');
            inputs.forEach(input => {
                if (input.type === 'text' || input.placeholder?.toLowerCase().includes('usuario')) {
                    input.value = user;
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                }
                if (input.type === 'password') {
                    input.value = pass;
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                }
            });
        }, CSF_USER, CSF_PASS);

        // Click en Entrar
        await page.evaluate(() => {
            const btns = document.querySelectorAll('button');
            btns.forEach(btn => {
                if (btn.textContent.trim().toLowerCase().includes('entrar')) btn.click();
            });
        });

        await new Promise(r => setTimeout(r, 4000));

        // Verificar que inició sesión buscando el textarea de pegado rápido
        let loggedIn = await page.evaluate(() => !!document.querySelector('textarea'));

        if (!loggedIn) {
            // Verificar si el error es "sesión activa en otro dispositivo"
            const errorSesion = await page.evaluate(() => {
                const body = document.body?.innerText || '';
                return body.includes('sesión activa') || body.includes('otro dispositivo');
            });

            if (errorSesion) {
                console.log('⚠️ Sesión activa en otro dispositivo detectada. Intentando forzar cierre...');
                // Intentar hacer click en botón para forzar cierre de sesión
                const forzado = await page.evaluate(() => {
                    const btns = Array.from(document.querySelectorAll('button, a'));
                    const btn = btns.find(b => /cerrar|forzar|desconectar|continuar|override/i.test(b.textContent));
                    if (btn) { btn.click(); return true; }
                    return false;
                });

                if (forzado) {
                    console.log('🔄 Click en botón de forzar cierre, reintentando login...');
                    await new Promise(r => setTimeout(r, 3000));
                } else {
                    // No hay botón — rellenar y enviar el form de nuevo (algunos sitios lo permiten)
                    console.log('🔄 Reintentando login para desplazar la sesión anterior...');
                    await page.evaluate((user, pass) => {
                        const inputs = document.querySelectorAll('input');
                        inputs.forEach(input => {
                            if (input.type === 'text') { input.value = user; input.dispatchEvent(new Event('input', { bubbles: true })); }
                            if (input.type === 'password') { input.value = pass; input.dispatchEvent(new Event('input', { bubbles: true })); }
                        });
                    }, CSF_USER, CSF_PASS);
                    await new Promise(r => setTimeout(r, 500));
                    await page.evaluate(() => {
                        const btns = document.querySelectorAll('button');
                        btns.forEach(btn => { if (btn.textContent.trim().toLowerCase().includes('entrar')) btn.click(); });
                    });
                    await new Promise(r => setTimeout(r, 4000));
                }

                loggedIn = await page.evaluate(() => !!document.querySelector('textarea'));
            }

            if (!loggedIn) {
                console.log('⚠️ No se pudo iniciar sesión en CSF');
                try {
                    const errorMsg = await page.evaluate(() => document.body?.innerText?.slice(0, 200) || '');
                    if (errorMsg) console.log('   Estado de página:', errorMsg);
                    await page.screenshot({ path: path.join(process.cwd(), 'debug_login.png') });
                    console.log('   Screenshot guardado en debug_login.png');
                } catch(e) {}
                await browser.close();
                return null;
            }
        }

        // Usar pegado rápido — escribir RFC e idCIF en el textarea
        const textoRapido = `RFC: ${rfc}\nidCIF: ${idcif}`;
        await page.evaluate((texto) => {
            const textarea = document.querySelector('textarea');
            if (textarea) {
                textarea.value = texto;
                textarea.dispatchEvent(new Event('input', { bubbles: true }));
                textarea.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }, textoRapido);

        await new Promise(r => setTimeout(r, 1000));

        // Presionar Ctrl+Enter para generar
        await page.focus('textarea');
        await page.keyboard.down('Control');
        await page.keyboard.press('Enter');
        await page.keyboard.up('Control');

        console.log('⏳ Esperando descarga del PDF...');

        await page.screenshot({ path: path.join(process.cwd(), 'debug_antes_generar.png') });

        // Esperar PDF hasta 90 segundos
        let pdfPath = null;
        for (let i = 0; i < 90; i++) {
            await new Promise(r => setTimeout(r, 1000));
            const archivos = fs.readdirSync(downloadPath).filter(f =>
                f.endsWith('.pdf') && !f.endsWith('.crdownload') && !f.endsWith('.tmp')
            );
            if (archivos.length > 0) {
                pdfPath = path.join(downloadPath, archivos[0]);
                console.log(`✅ PDF descargado: ${archivos[0]}`);
                break;
            }
            // A los 20s sin PDF, tomar screenshot para diagnosticar y reintentar el botón
            if (i === 20) {
                console.log('⏳ 20s sin PDF, verificando estado de la página...');
                await page.screenshot({ path: path.join(process.cwd(), 'debug_20s.png') });
                // Intentar hacer click en botón de generar/descargar por si Ctrl+Enter no funcionó
                await page.evaluate(() => {
                    const btns = Array.from(document.querySelectorAll('button'));
                    const btnGenerar = btns.find(b =>
                        /generar|descargar|constancia|generate|download/i.test(b.textContent)
                    );
                    if (btnGenerar) { btnGenerar.click(); console.log('Click en botón generar'); }
                }).catch(() => {});
            }
        }

        // Cerrar sesion antes de cerrar el navegador, para no dejar sesion colgada
        try {
            await page.evaluate(() => {
                const btns = document.querySelectorAll('button');
                for (const btn of btns) {
                    if (btn.textContent.toLowerCase().includes('cerrar sesión')) { btn.click(); return; }
                }
            });
            await new Promise(r => setTimeout(r, 1000));
        } catch(e) {}

        await browser.close();
        if (!pdfPath) {
            // PDF no descargado — tomar screenshot final y limpiar carpeta temporal
            console.log('⚠️ PDF no descargado en 90s — revisando logs de Puppeteer');
            await page.screenshot({ path: path.join(process.cwd(), 'debug_timeout.png') }).catch(() => {});
            try { fs.rmSync(downloadPath, { recursive: true, force: true }); } catch(e) {}
        }
        return pdfPath; // La carpeta se limpia despues de enviar el PDF (cuando pdfPath != null)

    } catch (err) {
        console.error('Error generarCSF:', err.message);
        console.error('Stack:', err.stack);
        try {
            const page = (await browser.pages())[0];
            if (page) {
                await page.screenshot({ path: path.join(process.cwd(), 'debug_error.png') });
                // Intentar cerrar sesion incluso si hubo error
                await page.evaluate(() => {
                    const btns = document.querySelectorAll('button');
                    for (const btn of btns) {
                        if (btn.textContent.toLowerCase().includes('cerrar sesión')) { btn.click(); return; }
                    }
                });
                await new Promise(r => setTimeout(r, 1000));
            }
        } catch(e) {}
        try { await browser.close(); } catch(e) {}
        try { fs.rmSync(downloadPath, { recursive: true, force: true }); } catch(e) {}
        return null;
    }
}

// ─── FUNCION: Notificar a Daniel cuando algo falla ───────────────
async function notificarDaniel(mensaje) {
    try {
        const chat = await client.getChatById(NUMERO_DANIEL);
        await chat.sendMessage(mensaje);
    } catch(e) {
        console.error('Error notificando a Daniel:', e.message);
    }
}

// ─── COLA Y REINTENTOS DE CSF ─────────────────────────────────────
// Procesa una solicitud a la vez (evita conflictos de sesion en Puppeteer)
// e intenta hasta 2 veces antes de rendirse.
async function procesarColaCSF() {
    if (colaCSF.length === 0) { procesandoCSF = false; return; }
    procesandoCSF = true;

    const { rfc, idcif, numeroCliente, resolve } = colaCSF.shift();
    let pdfPath = null;

    for (let intento = 1; intento <= 2; intento++) {
        console.log(`🔄 CSF intento ${intento}/2 — RFC: ${rfc}`);
        pdfPath = await generarCSF(rfc, idcif);
        if (pdfPath) break;
        if (intento < 2) {
            console.log('⚠️ Intento 1 fallido, esperando 5s antes de reintentar...');
            await new Promise(r => setTimeout(r, 5000));
        }
    }

    if (!pdfPath) {
        // Dos intentos fallidos → avisar a Daniel para atender manualmente
        await notificarDaniel(
            `⚠️ *Fallo CSF — atender manualmente*\n\n` +
            `RFC: *${rfc}*\nidCIF: *${idcif}*\nCliente: ${numeroCliente}\n\n` +
            `No se pudo generar después de 2 intentos.`
        );
    }

    resolve(pdfPath);
    procesarColaCSF(); // siguiente en la cola
}

function encolarCSF(rfc, idcif, numeroCliente) {
    return new Promise((resolve) => {
        colaCSF.push({ rfc, idcif, numeroCliente, resolve });
        if (!procesandoCSF) procesarColaCSF();
    });
}

// ─── FUNCION: Leer QR de imagen ──────────────────────────────────
async function leerQRdeImagen(mediaBase64) {
    const tmpPath = path.join(process.cwd(), `tmp_qr_${Date.now()}.jpg`);
    try {
        // Cargar jimp compatible con CommonJS (v0.x) y ESM (v1.x)
        let Jimp;
        try {
            const jimpModule = require('jimp');
            Jimp = jimpModule.Jimp || jimpModule;
        } catch(e) {
            // jimp v1+ es ESM — usar dynamic import
            const mod = await import('jimp');
            Jimp = mod.Jimp || mod.default;
        }

        const jsQR = require('jsqr');
        fs.writeFileSync(tmpPath, Buffer.from(mediaBase64, 'base64'));
        const imagen = await Jimp.read(tmpPath);
        const { data, width, height } = imagen.bitmap;
        const code = jsQR(data, width, height);
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        return code ? code.data : null;
    } catch (err) {
        console.error('Error leerQR:', err.message);
        if (fs.existsSync(tmpPath)) try { fs.unlinkSync(tmpPath); } catch(e) {}
        return null;
    }
}

// ─── FUNCION: Extraer RFC e idCIF del URL del QR ─────────────────
function extraerDatosDeURL(url) {
    try {
        // Solo procesamos QRs del SAT (ignora comprobantes de pago y otros)
        if (!url.includes('sat.gob.mx')) return null;

        const match = url.match(/D3=([^&]+)/);
        if (!match) return null;
        const partes = match[1].split('_');
        if (partes.length < 2) return null;

        const idcif = partes[0];
        const rfc   = partes[1];

        // Validar que el RFC tenga formato correcto
        if (!RFC_REGEX.test(rfc)) return null;
        // Validar que el idCIF sean solo dígitos (8-11)
        if (!/^\d{8,11}$/.test(idcif)) return null;

        return { idcif, rfc };
    } catch { return null; }
}

// ─── CLIENTE WHATSAPP ─────────────────────────────────────────────
const client = new Client({
    authStrategy: new LocalAuth(),
    webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
    },
    puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        headless: true
    }
});

client.on('qr', (qr) => {
    console.log('=== ESCANEA ESTE QR CON WHATSAPP ===');
    qrcode.generate(qr, { small: true });
});

let grupoDocifyId = null;

client.on('ready', async () => {
    console.log('✅ Bot conectado y listo');
    try {
        const chats = await client.getChats();
        const grupo = chats.find(c => c.isGroup && c.name.includes(NOMBRE_GRUPO_DOCIFY));
        if (grupo) {
            grupoDocifyId = grupo.id._serialized;
            console.log(`✅ Grupo Docify encontrado: ${grupo.name}`);
        } else {
            console.log('⚠️ No se encontró el grupo Docify — verifica el nombre en NOMBRE_GRUPO_DOCIFY');
        }
    } catch(e) {
        console.error('Error buscando grupo Docify:', e.message);
    }
});

client.on('message', async (msg) => {
    try {
        const chat = await msg.getChat();
        // LOG DE DIAGNÓSTICO — ayuda a identificar de dónde vienen los mensajes
        console.log(`📩 Mensaje de: ${msg.from} | Grupo: ${chat.isGroup ? chat.name : 'NO'} | Tipo: ${msg.type} | Body: ${(msg.body || '').substring(0, 50)}`);

        const esGrupoDocify  = chat.isGroup && chat.name.includes(NOMBRE_GRUPO_DOCIFY);
        const esGrupoIgnorado = chat.isGroup && GRUPOS_IGNORADOS.some(n => chat.name.includes(n));
        if (esGrupoIgnorado) return; // Proveedores u otros grupos → ignorar completamente

        // ── MENSAJES DEL GRUPO DOCIFY ─────────────────────────────
        if (esGrupoDocify) {
            // Caso 1: Llega un PDF con el documento (exito)
            if (msg.hasMedia && msg.type === 'document') {
                const nombreArchivo = msg._data?.filename || '';
                const curpEnArchivo = nombreArchivo.replace('.pdf', '').toUpperCase();
                const numeroCliente = solicitudesActa.get(curpEnArchivo);
                if (numeroCliente) {
                    console.log(`📄 Acta recibida para ${curpEnArchivo}`);
                    const media = await msg.downloadMedia();
                    const chatCliente = await client.getChatById(numeroCliente);
                    await chatCliente.sendMessage('✅ Aquí está tu acta:');
                    await chatCliente.sendMessage(media, { sendMediaAsDocument: true, filename: `${curpEnArchivo}.pdf` });
                    solicitudesActa.delete(curpEnArchivo);
                }
                return;
            }

            // Caso 2: Llega un mensaje de texto (puede ser error, "ya entregada", etc.)
            if (msg.body) {
                const textoMsg = msg.body;
                // Buscamos la CURP dentro del mensaje (suele venir despues de "Dato:")
                const matchCurpEnTexto = textoMsg.toUpperCase().match(CURP_REGEX);
                if (matchCurpEnTexto) {
                    const curpDetectada = matchCurpEnTexto[0];
                    const numeroCliente = solicitudesActa.get(curpDetectada);
                    if (numeroCliente) {
                        const esError = textoMsg.includes('❌') || textoMsg.toLowerCase().includes('no hay registros');
                        const yaEntregada = textoMsg.toLowerCase().includes('ya fue entregada');

                        const chatCliente = await client.getChatById(numeroCliente);

                        if (esError) {
                            console.log(`⚠️ Error de Docify para ${curpDetectada}: sin registros`);
                            await chatCliente.sendMessage(
                                '❌ No encontramos registros para tu CURP en el sistema.\n\n' +
                                'Verifica que tu CURP esté certificada en RENAPO, o si crees que es un error, contáctanos directamente.'
                            );
                            solicitudesActa.delete(curpDetectada);
                        } else if (yaEntregada) {
                            console.log(`ℹ️ Acta ya entregada antes para ${curpDetectada}`);
                            await chatCliente.sendMessage(
                                '📋 Esta acta ya fue generada anteriormente. Si necesitas que te la reenviemos, contáctanos directamente.'
                            );
                            solicitudesActa.delete(curpDetectada);
                        }
                        // Si es otro tipo de mensaje (ej. "Solicitud recibida...") simplemente lo ignoramos,
                        // ya que es solo una confirmacion intermedia sin accion necesaria
                    }
                }
            }
            return;
        }

        if (chat.isGroup) return;

        const texto         = (msg.body || '').trim();
        const textoMayus    = texto.toUpperCase();
        const numeroCliente = msg.from;

        // ── ARCHIVO PDF: extraer RFC del nombre del archivo ──────────
        // El SAT genera PDFs con nombre que incluye el RFC (ej: MOHL780629MCCRRR05_RFC.pdf)
        // jimp no puede leer QR de PDFs, así que usamos el nombre del archivo
        if (msg.hasMedia && msg.type === 'document') {
            const nombreArchivo = (msg._data?.filename || '').toUpperCase();
            const mimeType = msg._data?.mimetype || '';

            if (mimeType.includes('pdf') || nombreArchivo.endsWith('.PDF')) {
                // Buscar RFC en el nombre del archivo (sin requerir word boundary)
                const RFC_LOOSE = /([A-Z&Ñ]{3,4}\d{6}[A-Z0-9]{3})/i;
                const matchRfcEnPDF = nombreArchivo.match(RFC_LOOSE);

                if (matchRfcEnPDF) {
                    const rfcDelPDF = matchRfcEnPDF[1].toUpperCase();
                    console.log(`📄 PDF recibido — RFC en nombre de archivo: ${rfcDelPDF}`);
                    esperandoIdCIF.set(numeroCliente, { rfc: rfcDelPDF, idcif: null, ts: Date.now() });
                    esperandoImagenCSF.set(numeroCliente, true);
                    await msg.reply(
                        `✅ Recibí tu constancia en PDF.\nRFC detectado: *${rfcDelPDF}*\n\n` +
                        `Ahora necesito tu *ID (idCIF)* — lo encuentras en la parte superior de la constancia como un número de 11 dígitos.\n\nMándamelo y genero la nueva constancia de inmediato.`
                    );
                } else {
                    // PDF sin RFC reconocible en el nombre
                    await msg.reply(
                        '📄 Recibí un PDF pero no pude identificar el RFC.\n\n' +
                        'Por favor mándame:\n1️⃣ Una *foto* de tu constancia (con el QR visible)\n2️⃣ O escríbeme tu *RFC* y tu *ID (idCIF)* por texto'
                    );
                }
                return;
            }
        }

        // ── IMAGEN: detectar si es constancia del SAT (QR) ───────────
        if (msg.hasMedia && (msg.type === 'image' || msg.type === 'document')) {
            const media = await msg.downloadMedia();
            const urlQR = await leerQRdeImagen(media.data);

            if (urlQR) {
                const datos = extraerDatosDeURL(urlQR);
                if (datos) {
                    // Es una constancia del SAT con QR válido → procesar
                    esperandoImagenCSF.delete(numeroCliente);
                    const enEspera = colaCSF.length + (procesandoCSF ? 1 : 0);
                    const msgEspera = enEspera > 0
                        ? `✅ QR leído:\nRFC: *${datos.rfc}*\nidCIF: *${datos.idcif}*\n\n⏳ Hay ${enEspera} solicitud(es) antes que la tuya. Te aviso cuando esté lista.`
                        : `✅ QR leído:\nRFC: *${datos.rfc}*\nidCIF: *${datos.idcif}*\n\n⏳ Generando constancia...`;
                    await msg.reply(msgEspera);
                    const pdfPath = await encolarCSF(datos.rfc, datos.idcif, numeroCliente);
                    if (pdfPath) {
                        try {
                            const pdfMedia = MessageMedia.fromFilePath(pdfPath);
                            // Obtener referencia fresca al chat (la original puede quedar stale
                            // después de los 40+ segundos que tarda Puppeteer)
                            const chatFresh = await client.getChatById(numeroCliente);
                            await chatFresh.sendMessage('✅ Aquí está tu Constancia de Situación Fiscal:');
                            await chatFresh.sendMessage(pdfMedia, { sendMediaAsDocument: true, filename: `CSF_${datos.rfc}.pdf` });
                        } catch(envioErr) {
                            console.error('❌ Error enviando PDF por QR:', envioErr.message);
                            await notificarDaniel(`⚠️ PDF generado pero falló el envío\nRFC: ${datos.rfc}\nCliente: ${numeroCliente}\nError: ${envioErr.message}`);
                        }
                        try { fs.rmSync(path.dirname(pdfPath), { recursive: true, force: true }); } catch(e) {}
                    } else {
                        await msg.reply('❌ No pude generar la constancia. Intenta de nuevo o contáctanos directamente.');
                    }
                } else {
                    // Tiene QR pero no es del SAT (comprobante de pago, etc.) → ignorar
                }
            } else {
                // No se pudo leer el QR
                if (esperandoImagenCSF.get(numeroCliente)) {
                    await msg.reply('📸 No pude leer el QR de tu imagen. Por favor mándame una foto *más clara* de tu Constancia de Situación Fiscal, asegurándote de que el código QR se vea bien.');
                }
                // Si no estaba en flujo, ignorar silenciosamente
            }
            return;
        }

        // ── TEXTO: detectar RFC y/o idCIF (en cualquier orden, mismo o distinto mensaje) ─
        const matchRFC = textoMayus.match(RFC_REGEX);
        const tieneRFC = matchRFC && !textoMayus.match(CURP_REGEX);

        // Buscamos el idCIF quitando primero el RFC del texto
        const textoSinRFC = tieneRFC ? textoMayus.replace(matchRFC[0], '') : textoMayus;

        // Primero intentar con prefijo "ID xxx"; si no hay prefijo, aceptar numero suelto
        // cuando: hay RFC en el mismo mensaje, O el cliente ya está esperando dar su idCIF
        let matchID = textoSinRFC.match(IDCIF_REGEX);
        if (!matchID && (tieneRFC || esperandoIdCIF.has(numeroCliente))) {
            matchID = textoSinRFC.match(/\b(\d{8,11})\b/);
        }
        const tieneID    = !!matchID;
        const tieneSinID = textoMayus.includes('SIN ID');

        if (tieneRFC || tieneID) {
            // Limpiar estado de actas si el cliente cambia de flujo a CSF
            esperandoCurp.delete(numeroCliente);
            tipoActaPendiente.delete(numeroCliente);
            const pendiente = esperandoIdCIF.get(numeroCliente) || {};
            let rfc   = pendiente.rfc;
            let idcif = pendiente.idcif;

            if (tieneRFC) {
                rfc = matchRFC[1].toUpperCase();
                console.log(`📨 RFC de ${numeroCliente}: ${rfc}`);
            }
            if (tieneID) {
                idcif = matchID[1];
                console.log(`📨 idCIF de ${numeroCliente}: ${idcif}`);
            }

            // Cliente mandó RFC pero dice "SIN ID" → pedirle que lo consiga
            if (rfc && tieneSinID && !idcif) {
                esperandoIdCIF.set(numeroCliente, { rfc, idcif: null, ts: Date.now() });
                await msg.reply(
                    `✅ RFC recibido: *${rfc}*\n\n` +
                    `⚠️ Para generar tu constancia también necesito tu *ID (idCIF)*.\n\n` +
                    `Lo encuentras en:\n• Una constancia anterior (número de 11 dígitos en la parte superior)\n• Portal del SAT → sat.gob.mx → "Genera tu constancia de situación fiscal"\n\n` +
                    `Cuando lo tengas, mándamelo y lo proceso de inmediato.`
                );
                return;
            }

            // Si ya tenemos los dos datos, generamos la constancia
            if (rfc && idcif) {
                esperandoIdCIF.delete(numeroCliente);
                const enEspera = colaCSF.length + (procesandoCSF ? 1 : 0);
                const msgEspera = enEspera > 0
                    ? `✅ Datos recibidos:\nRFC: *${rfc}*\nidCIF: *${idcif}*\n\n⏳ Hay ${enEspera} solicitud(es) antes que la tuya. Te aviso cuando esté lista.`
                    : `✅ Datos recibidos:\nRFC: *${rfc}*\nidCIF: *${idcif}*\n\n⏳ Generando constancia, espera unos segundos...`;
                await msg.reply(msgEspera);
                const pdfPath = await encolarCSF(rfc, idcif, numeroCliente);
                if (pdfPath) {
                    try {
                        const pdfMedia = MessageMedia.fromFilePath(pdfPath);
                        // Obtener referencia fresca al chat (la original puede quedar stale
                        // después de los 40+ segundos que tarda Puppeteer)
                        const chatFresh = await client.getChatById(numeroCliente);
                        await chatFresh.sendMessage('✅ Aquí está tu Constancia de Situación Fiscal:');
                        await chatFresh.sendMessage(pdfMedia, { sendMediaAsDocument: true, filename: `CSF_${rfc}.pdf` });
                    } catch(envioErr) {
                        console.error('❌ Error enviando PDF por texto:', envioErr.message);
                        await notificarDaniel(`⚠️ PDF generado pero falló el envío\nRFC: ${rfc}\nCliente: ${numeroCliente}\nError: ${envioErr.message}`);
                    }
                    try { fs.rmSync(path.dirname(pdfPath), { recursive: true, force: true }); } catch(e) {}
                } else {
                    await msg.reply('❌ No pude generar la constancia. Intenta de nuevo o contáctanos directamente.');
                }
                return;
            }

            // Si solo tenemos uno de los dos, guardamos y pedimos el que falta
            esperandoIdCIF.set(numeroCliente, { rfc, idcif, ts: Date.now() });
            if (rfc && !idcif) {
                esperandoImagenCSF.set(numeroCliente, true);
                await msg.reply(`✅ RFC recibido: *${rfc}*\nAhora mándame el *ID* (idCIF).`);
            } else if (idcif && !rfc) {
                esperandoImagenCSF.set(numeroCliente, true);
                await msg.reply(`✅ ID recibido: *${idcif}*\nAhora mándame el *RFC*.`);
            }
            return;
        }

        // ── TEXTO: detectar CURP (actas) ──────────────────────────
        const matchCurp = textoMayus.match(CURP_REGEX);
        if (matchCurp) {
            const curp = matchCurp[0].toUpperCase();

            // Si el cliente estaba en flujo de CSF (esperando RFC o idCIF)
            // y NO está en flujo de actas, la CURP es un error — le explicamos la diferencia
            if (esperandoIdCIF.has(numeroCliente) && !esperandoCurp.get(numeroCliente)) {
                await msg.reply(
                    `⚠️ Eso que mandaste es tu *CURP*, no tu *RFC*.\n\n` +
                    `El RFC tiene *13 caracteres* (4 letras + 6 números + 3 caracteres), por ejemplo: *GORL980330HCC*\n\n` +
                    `Lo encuentras en:\n• Tu constancia de situación fiscal anterior\n• El portal del SAT: sat.gob.mx`
                );
                return;
            }

            // Verificar que la CURP no sea parte de una cadena mas larga (ej. GORL980330HCCNMS17X)
            const idxCurp = textoMayus.indexOf(curp);
            const charAntes = idxCurp > 0 ? textoMayus[idxCurp - 1] : ' ';
            const charDespues = idxCurp + 18 < textoMayus.length ? textoMayus[idxCurp + 18] : ' ';
            if (/[A-Z0-9]/i.test(charAntes) || /[A-Z0-9]/i.test(charDespues)) {
                // Hay caracteres pegados antes o despues — no es una CURP valida
                const validacion = validarCURP(textoMayus);
                if (validacion) {
                    await msg.reply(
                        `⚠️ La CURP que mandaste no tiene el formato correcto:\n*${validacion.valor}*\n\n` +
                        validacion.errores.map(e => `• ${e}`).join('\n') +
                        `\n\nUna CURP válida tiene 18 caracteres, por ejemplo: *GORL980330HCCNMS17*\n\nRevisa e inténtalo de nuevo.`
                    );
                    esperandoCurp.set(numeroCliente, true);
                }
                return;
            }

            // Buscamos si el tipo de acta viene en el mismo mensaje
            const palabrasMatrimonioInline = ['MATRIMONIO', 'CASAD', 'BODA'];
            const palabrasDivorcioInline   = ['DIVORCIO', 'DIVORCIAD'];
            const palabrasDefuncionInline  = ['DEFUNCION', 'DEFUNCIÓN', 'FALLECI', 'MUERTE'];
            const palabrasNacimientoInline = ['NACIMIENTO'];

            let tipoEnMensaje = null;
            if (palabrasMatrimonioInline.some(p => textoMayus.includes(p))) tipoEnMensaje = 'MATRIMONIO';
            else if (palabrasDivorcioInline.some(p => textoMayus.includes(p))) tipoEnMensaje = 'DIVORCIO';
            else if (palabrasDefuncionInline.some(p => textoMayus.includes(p))) tipoEnMensaje = 'DEFUNCION';
            else if (palabrasNacimientoInline.some(p => textoMayus.includes(p))) tipoEnMensaje = 'NACIMIENTO';

            // Prioridad: tipo en el mismo mensaje > tipo guardado de antes > NACIMIENTO por defecto
            const tipoActa = tipoEnMensaje || tipoActaPendiente.get(numeroCliente) || 'NACIMIENTO';

            console.log(`📨 CURP de ${numeroCliente}: ${curp} (tipo: ${tipoActa})`);
            await msg.reply(`⏳ Consultando tu acta de ${tipoActa.toLowerCase()}, en unos segundos te la enviamos...`);
            solicitudesActa.set(curp, numeroCliente);
            esperandoCurp.delete(numeroCliente);
            tipoActaPendiente.delete(numeroCliente);
            if (grupoDocifyId) {
                const grupoChat = await client.getChatById(grupoDocifyId);
                await grupoChat.sendMessage(`${curp} ${tipoActa}`);
            } else {
                console.log('⚠️ Grupo Docify no encontrado, reintentando busqueda...');
                const chats = await client.getChats();
                const grupo = chats.find(c => c.isGroup && c.name.includes(NOMBRE_GRUPO_DOCIFY));
                if (grupo) {
                    grupoDocifyId = grupo.id._serialized;
                    await grupo.sendMessage(`${curp} ${tipoActa}`);
                }
            }
            return;
        }

        // ── TEXTO: detectar intento de CURP con formato incorrecto ────
        // Solo validamos si el cliente esta en proceso de mandar su CURP
        if (esperandoCurp.get(numeroCliente)) {
            const validacion = validarCURP(texto);
            if (validacion) {
                console.log(`⚠️ CURP con formato incorrecto de ${numeroCliente}: ${validacion.valor}`);
                await msg.reply(
                    `⚠️ La CURP que mandaste no tiene el formato correcto:\n*${validacion.valor}*\n\n` +
                    validacion.errores.map(e => `• ${e}`).join('\n') +
                    `\n\nUna CURP válida tiene 18 caracteres, por ejemplo: *GORL980330HCCNMS17*\n\n` +
                    `Por favor revisa e inténtalo de nuevo.`
                );
                return;
            }
        }

        // ── TEXTO: palabras clave ─────────────────────────────────
        // El bot SOLO responde si se menciona explicitamente uno de estos tramites.
        // Cualquier otro mensaje (saludos, preguntas generales, etc.) se ignora
        // por completo para que Daniel pueda responder manualmente sin interferencia.
        const palabrasCSF        = ['CONSTANCIA', 'SITUACION', 'FISCAL', 'CSF'];
        const palabrasRFCmencion = ['RFC'];
        const palabrasNacimiento = ['NACIMIENTO'];
        const palabrasMatrimonio = ['MATRIMONIO', 'CASAD', 'BODA'];
        const palabrasDivorcio   = ['DIVORCIO', 'DIVORCIAD'];
        const palabrasDefuncion  = ['DEFUNCION', 'DEFUNCIÓN', 'FALLECI', 'MUERTE'];
        const palabrasActaGenerica = ['ACTA'];

        if (palabrasCSF.some(p => textoMayus.includes(p)) || palabrasRFCmencion.some(p => textoMayus.includes(p))) {
            // Limpiar estado de actas si el cliente cambia de flujo
            esperandoCurp.delete(numeroCliente);
            tipoActaPendiente.delete(numeroCliente);
            esperandoImagenCSF.set(numeroCliente, true);
            await msg.reply('📄 Para tu *Constancia de Situación Fiscal*:\n\n1️⃣ *Mándame la foto* de tu constancia (con QR visible)\n2️⃣ O mándame tu *RFC* y luego tu *ID (idCIF)*');
            return;
        }

        // Detectar tipo especifico de acta
        let tipoDetectado = null;
        if (palabrasMatrimonio.some(p => textoMayus.includes(p))) tipoDetectado = 'MATRIMONIO';
        else if (palabrasDivorcio.some(p => textoMayus.includes(p))) tipoDetectado = 'DIVORCIO';
        else if (palabrasDefuncion.some(p => textoMayus.includes(p))) tipoDetectado = 'DEFUNCION';
        else if (palabrasNacimiento.some(p => textoMayus.includes(p))) tipoDetectado = 'NACIMIENTO';

        if (tipoDetectado) {
            // Limpiar estado de CSF si el cliente cambia de flujo
            esperandoIdCIF.delete(numeroCliente);
            esperandoImagenCSF.delete(numeroCliente);
            tipoActaPendiente.set(numeroCliente, tipoDetectado);
            esperandoCurp.set(numeroCliente, true);
            const nombreBonito = {
                NACIMIENTO: 'nacimiento', MATRIMONIO: 'matrimonio',
                DIVORCIO: 'divorcio', DEFUNCION: 'defunción'
            }[tipoDetectado];
            await msg.reply(`📋 Para tu *acta de ${nombreBonito}* necesito tu *CURP*.\n\nLa encuentras en:\n• curp.sep.gob.mx\n• Tu INE o pasaporte\n\nEnvíamela y en segundos te entrego el documento 📄`);
            return;
        }

        // Pidio "acta" generico sin especificar tipo
        if (palabrasActaGenerica.some(p => textoMayus.includes(p))) {
            // Limpiar estado de CSF si el cliente cambia de flujo
            esperandoIdCIF.delete(numeroCliente);
            esperandoImagenCSF.delete(numeroCliente);
            // Marcar que estamos esperando tipo + CURP
            esperandoCurp.set(numeroCliente, true);
            await msg.reply(
                '📋 ¿Qué tipo de acta necesitas?\n\n' +
                '1️⃣ Nacimiento\n2️⃣ Matrimonio\n3️⃣ Divorcio\n4️⃣ Defunción\n\n' +
                'Respóndeme con el número o el tipo, y después tu CURP.'
            );
            return;
        }

        // Si ya está esperando CURP y el cliente responde con número (1-4) o nombre de tipo
        if (esperandoCurp.get(numeroCliente) && !tipoActaPendiente.get(numeroCliente)) {
            const tipoMapa = {
                '1': 'NACIMIENTO', 'NACIMIENTO': 'NACIMIENTO',
                '2': 'MATRIMONIO', 'MATRIMONIO': 'MATRIMONIO', 'CASAD': 'MATRIMONIO', 'BODA': 'MATRIMONIO',
                '3': 'DIVORCIO',   'DIVORCIO': 'DIVORCIO',
                '4': 'DEFUNCION',  'DEFUNCION': 'DEFUNCION',
            };
            const limpio = textoMayus.trim();
            const tipoSel = tipoMapa[limpio] ||
                Object.entries(tipoMapa).find(([k]) => limpio.startsWith(k) && k.length > 1)?.[1];
            if (tipoSel) {
                tipoActaPendiente.set(numeroCliente, tipoSel);
                const nombre = { NACIMIENTO: 'nacimiento', MATRIMONIO: 'matrimonio', DIVORCIO: 'divorcio', DEFUNCION: 'defunción' }[tipoSel];
                await msg.reply(`📋 Perfecto, acta de *${nombre}*.\n\nAhora mándame tu *CURP*.\n\nLa encuentras en:\n• curp.sep.gob.mx\n• Tu INE o pasaporte`);
                return;
            }
        }

        // Si ya estaba esperando CURP de una solicitud de acta ya iniciada,
        // seguimos esperando aunque el mensaje no repita la palabra "acta"
        if (esperandoCurp.get(numeroCliente)) {
            await msg.reply('📋 Necesito tu *CURP* para continuar con tu acta.\n\nLa encuentras en:\n• curp.sep.gob.mx\n• Tu INE o pasaporte');
            return;
        }

        // Cualquier otro mensaje se ignora completamente — Daniel responde manualmente

    } catch(err) {
        console.error('Error en mensaje:', err.message);
    }
});

client.initialize();
