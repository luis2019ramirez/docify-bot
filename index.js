const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const http = require('http');
const fs = require('fs');
const path = require('path');

// Limpiar archivos de bloqueo de Chromium de una sesion anterior (solo aplica si existen)
try {
    const authPath = process.env.WWEBJS_AUTH_PATH || path.join(process.cwd(), '.wwebjs_auth');
    const lockFile = path.join(authPath, 'session', 'SingletonLock');
    if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
} catch(e) {}

// ─── CONFIGURACION ────────────────────────────────────────────────
const NOMBRE_GRUPO_DOCIFY = 'ACTA DOCIFY 13 - GONZALEZ';
const CSF_URL  = 'https://constancia-7xk29.vercel.app/';
const CSF_USER = 'daniel.gonzalez';
const CSF_PASS = 'GonzalezCIF26';

const RFC_REGEX   = /\b([A-Z&Ñ]{3,4}\d{6}[A-Z0-9]{3})\b/i;
const CURP_REGEX  = /[A-Z]{4}\d{6}[HM][A-Z]{5}[A-Z0-9]\d/i;
const IDCIF_REGEX = /(?:ID\s*)?(\d{8,11})/i;

const solicitudesActa = new Map();
const esperandoCurp   = new Map();
const esperandoIdCIF  = new Map();
const tipoActaPendiente = new Map(); // numeroCliente -> 'NACIMIENTO'|'MATRIMONIO'|'DIVORCIO'|'DEFUNCION'
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

// ─── FUNCION: Generar CSF ─────────────────────────────────────────
async function generarCSF(rfc, idcif) {
    let puppeteer;
    try { puppeteer = require('puppeteer'); } catch(e) { puppeteer = require('puppeteer-core'); }

    console.log(`🌐 Generando CSF: RFC=${rfc} idCIF=${idcif}`);

    const downloadPath = path.join(process.cwd(), 'descargas');
    if (!fs.existsSync(downloadPath)) fs.mkdirSync(downloadPath);
    fs.readdirSync(downloadPath).forEach(f => {
        if (f.endsWith('.pdf')) try { fs.unlinkSync(path.join(downloadPath, f)); } catch(e) {}
    });

    const launchOptions = {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    };
    // En Railway (Linux) usamos el Chromium del sistema operativo
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
        launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    }
    const browser = await puppeteer.launch(launchOptions);

    try {
        const page = await browser.newPage();

        // Configurar descarga
        const cdpSession = await page.target().createCDPSession();
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
        const loggedIn = await page.evaluate(() => {
            return !!document.querySelector('textarea');
        });

        if (!loggedIn) {
            console.log('⚠️ No se pudo iniciar sesión en CSF (puede que haya otra sesión activa)');
            try {
                const errorMsg = await page.evaluate(() => {
                    const el = document.querySelector('[class*="error"], [class*="Error"]');
                    return el ? el.textContent : null;
                });
                if (errorMsg) console.log('   Mensaje de error en pagina:', errorMsg);
                await page.screenshot({ path: path.join(process.cwd(), 'debug_login.png') });
                console.log('   Screenshot guardado en debug_login.png');
            } catch(e) {}
            await browser.close();
            return null;
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

        // Esperar PDF hasta 40 segundos
        let pdfPath = null;
        for (let i = 0; i < 40; i++) {
            await new Promise(r => setTimeout(r, 1000));
            const archivos = fs.readdirSync(downloadPath).filter(f =>
                f.endsWith('.pdf') && !f.endsWith('.crdownload') && !f.endsWith('.tmp')
            );
            if (archivos.length > 0) {
                pdfPath = path.join(downloadPath, archivos[0]);
                console.log(`✅ PDF descargado: ${archivos[0]}`);
                break;
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
        return pdfPath;

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
        return null;
    }
}

// ─── FUNCION: Leer QR de imagen ──────────────────────────────────
async function leerQRdeImagen(mediaBase64) {
    try {
        const jimpModule = require('jimp');
        const Jimp = jimpModule.Jimp || jimpModule;
        const jsQR = require('jsqr');
        const tmpPath = path.join(process.cwd(), 'tmp_qr.jpg');
        fs.writeFileSync(tmpPath, Buffer.from(mediaBase64, 'base64'));
        const imagen = await Jimp.read(tmpPath);
        const { data, width, height } = imagen.bitmap;
        const code = jsQR(data, width, height);
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        return code ? code.data : null;
    } catch (err) {
        console.error('Error leerQR:', err.message);
        return null;
    }
}

// ─── FUNCION: Extraer RFC e idCIF del URL del QR ─────────────────
function extraerDatosDeURL(url) {
    try {
        const match = url.match(/D3=([^&]+)/);
        if (!match) return null;
        const partes = match[1].split('_');
        if (partes.length < 2) return null;
        return { idcif: partes[0], rfc: partes[1] };
    } catch { return null; }
}

// ─── CLIENTE WHATSAPP ─────────────────────────────────────────────
const puppeteerConfig = {
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    headless: true
};
if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    puppeteerConfig.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
}

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: process.env.WWEBJS_AUTH_PATH || undefined }),
    webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
    },
    puppeteer: puppeteerConfig
});

client.on('qr', (qr) => {
    console.log('=== ESCANEA ESTE QR CON WHATSAPP ===');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('✅ Bot conectado y listo');
});

client.on('message', async (msg) => {
    try {
        const chat = await msg.getChat();
        const esGrupoDocify = chat.isGroup && chat.name.includes(NOMBRE_GRUPO_DOCIFY);

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

        const texto         = msg.body.trim();
        const textoMayus    = texto.toUpperCase();
        const numeroCliente = msg.from;

        // ── IMAGEN: leer QR de constancia ────────────────────────
        if (msg.hasMedia && (msg.type === 'image' || msg.type === 'document')) {
            await msg.reply('⏳ Recibí tu imagen, leyendo el QR...');
            const media = await msg.downloadMedia();
            const urlQR = await leerQRdeImagen(media.data);
            if (urlQR) {
                const datos = extraerDatosDeURL(urlQR);
                if (datos) {
                    await msg.reply(`✅ QR leído:\nRFC: *${datos.rfc}*\nidCIF: *${datos.idcif}*\n\n⏳ Generando constancia...`);
                    const pdfPath = await generarCSF(datos.rfc, datos.idcif);
                    if (pdfPath) {
                        const pdfMedia = MessageMedia.fromFilePath(pdfPath);
                        await msg.reply('✅ Aquí está tu Constancia de Situación Fiscal:');
                        await chat.sendMessage(pdfMedia, { sendMediaAsDocument: true, filename: `CSF_${datos.rfc}.pdf` });
                        fs.unlinkSync(pdfPath);
                    } else {
                        await msg.reply('❌ No pude generar la constancia. Mándame el RFC e ID por texto.');
                    }
                } else {
                    await msg.reply('⚠️ Leí el QR pero no pude extraer los datos. Mándame el RFC e ID por texto.');
                }
            } else {
                await msg.reply('⚠️ No pude leer el QR. Por favor mándame el RFC y el ID por texto.');
            }
            return;
        }

        // ── TEXTO: detectar RFC y/o idCIF (en cualquier orden, mismo o distinto mensaje) ─
        const matchRFC = textoMayus.match(RFC_REGEX);
        const tieneRFC = matchRFC && !textoMayus.match(CURP_REGEX);

        // Buscamos el idCIF quitando primero el RFC del texto, para que el RFC
        // no se confunda como si fuera el numero de idCIF
        const textoSinRFC = tieneRFC ? textoMayus.replace(matchRFC[0], '') : textoMayus;
        const matchID = textoSinRFC.match(IDCIF_REGEX);
        const tieneID = !!matchID;

        if (tieneRFC || tieneID) {
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

            // Si ya tenemos los dos datos, generamos la constancia
            if (rfc && idcif) {
                esperandoIdCIF.delete(numeroCliente);
                await msg.reply(`✅ Datos recibidos:\nRFC: *${rfc}*\nidCIF: *${idcif}*\n\n⏳ Generando constancia, espera unos segundos...`);
                const pdfPath = await generarCSF(rfc, idcif);
                if (pdfPath) {
                    const pdfMedia = MessageMedia.fromFilePath(pdfPath);
                    await msg.reply('✅ Aquí está tu Constancia de Situación Fiscal:');
                    await chat.sendMessage(pdfMedia, { sendMediaAsDocument: true, filename: `CSF_${rfc}.pdf` });
                    fs.unlinkSync(pdfPath);
                } else {
                    await msg.reply('❌ No pude generar la constancia. Intenta de nuevo en unos minutos.');
                }
                return;
            }

            // Si solo tenemos uno de los dos, guardamos y pedimos el que falta
            esperandoIdCIF.set(numeroCliente, { rfc, idcif, ts: Date.now() });
            if (rfc && !idcif) {
                await msg.reply(`✅ RFC recibido: *${rfc}*\nAhora mándame el *ID* (idCIF).`);
            } else if (idcif && !rfc) {
                await msg.reply(`✅ ID recibido: *${idcif}*\nAhora mándame el *RFC*.`);
            }
            return;
        }

        // ── TEXTO: detectar CURP (actas) ──────────────────────────
        const matchCurp = textoMayus.match(CURP_REGEX);
        if (matchCurp) {
            const curp = matchCurp[0].toUpperCase();

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
            const chats = await client.getChats();
            const grupo = chats.find(c => c.isGroup && c.name.includes(NOMBRE_GRUPO_DOCIFY));
            if (grupo) await grupo.sendMessage(`${curp} ${tipoActa}`);
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
            await msg.reply(
                '📋 ¿Qué tipo de acta necesitas?\n\n' +
                '1️⃣ Nacimiento\n2️⃣ Matrimonio\n3️⃣ Divorcio\n4️⃣ Defunción\n\n' +
                'Respóndeme con el tipo y después tu CURP.'
            );
            return;
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
