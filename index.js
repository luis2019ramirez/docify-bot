const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');

// ─── CONFIGURACIÓN ───────────────────────────────────────────────
// Pon aquí el nombre exacto del grupo de Docify como aparece en WhatsApp
const NOMBRE_GRUPO_DOCIFY = 'ACTA DOCIFY 13 - GONZALEZ'; // cámbialo al nombre completo

// Regex para detectar una CURP válida (18 caracteres)
const CURP_REGEX = /[A-Z]{4}\d{6}[HM][A-Z]{5}[A-Z0-9]\d/i;

// Mapa temporal: CURP -> número de cliente que la solicitó
const solicitudes = new Map();

// Mapa temporal: número de cliente -> esperando CURP (true/false)
const esperandoCurp = new Map();
// ─────────────────────────────────────────────────────────────────

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        headless: true
    }
});

// Muestra el QR para vincular tu WhatsApp
client.on('qr', (qr) => {
    console.log('Escanea este QR con tu WhatsApp:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', async () => {
    console.log('✅ Bot conectado y listo');

    // Busca el grupo de Docify al iniciar
    const chats = await client.getChats();
    const grupoDocify = chats.find(c => c.name && c.name.includes(NOMBRE_GRUPO_DOCIFY));
    if (grupoDocify) {
        console.log(`✅ Grupo Docify encontrado: ${grupoDocify.name}`);
    } else {
        console.log('⚠️  Grupo Docify NO encontrado. Revisa el nombre en NOMBRE_GRUPO_DOCIFY');
        console.log('Grupos disponibles:', chats.filter(c => c.isGroup).map(c => c.name));
    }
});

client.on('message', async (msg) => {
    const chat = await msg.getChat();
    const esGrupoDocify = chat.isGroup && chat.name.includes(NOMBRE_GRUPO_DOCIFY);

    // ── MENSAJES QUE VIENEN DEL GRUPO DE DOCIFY ──────────────────
    if (esGrupoDocify) {
        // Si Docify manda un PDF
        if (msg.hasMedia && msg.type === 'document') {
            // Buscamos a qué cliente pertenece este PDF por el nombre del archivo
            // El archivo viene como CURP.pdf, ej: GORL980330HCCNMS17.pdf
            const nombreArchivo = msg._data?.filename || '';
            const curpEnArchivo = nombreArchivo.replace('.pdf', '').toUpperCase();

            const numeroCliente = solicitudes.get(curpEnArchivo);

            if (numeroCliente) {
                console.log(`📄 PDF de Docify recibido para ${curpEnArchivo}, enviando a ${numeroCliente}`);
                const media = await msg.downloadMedia();
                const chatCliente = await client.getChatById(numeroCliente);
                await chatCliente.sendMessage('✅ Aquí está tu acta de nacimiento:');
                await chatCliente.sendMessage(media, { sendMediaAsDocument: true, filename: `${curpEnArchivo}.pdf` });
                solicitudes.delete(curpEnArchivo);
            }
        }
        return; // No procesar más mensajes del grupo
    }

    // ── MENSAJES QUE VIENEN DE CLIENTES (chats privados) ─────────
    if (chat.isGroup) return; // ignorar otros grupos

    const textoCliente = msg.body.trim().toUpperCase();
    const numeroCliente = msg.from;

    // Detecta si el mensaje contiene una CURP directamente
    const matchCurp = textoCliente.match(CURP_REGEX);

    if (matchCurp) {
        const curp = matchCurp[0].toUpperCase();
        console.log(`📨 CURP recibida de ${numeroCliente}: ${curp}`);

        // Confirmamos al cliente
        await msg.reply('⏳ Recibido. Estamos consultando tu acta, en unos segundos te la enviamos...');

        // Guardamos quién solicitó esta CURP
        solicitudes.set(curp, numeroCliente);
        esperandoCurp.delete(numeroCliente);

        // Enviamos la CURP al grupo de Docify
        const chats = await client.getChats();
        const grupoDocify = chats.find(c => c.name && c.name.includes(NOMBRE_GRUPO_DOCIFY));

        if (grupoDocify) {
            await grupoDocify.sendMessage(`${curp} ACTA`);
            console.log(`📤 Enviado a Docify: ${curp} ACTA`);
        } else {
            await msg.reply('❌ Error interno: no se encontró el canal de consulta. Contacta a tu asesor.');
            console.error('Grupo Docify no encontrado al intentar enviar');
        }

    } else {
        // El cliente escribió algo pero sin CURP — preguntar
        const palabrasClave = ['ACTA', 'NACIMIENTO', 'DOCUMENTO', 'NECESITO', 'QUIERO', 'SOLICITO'];
        const esSolicitud = palabrasClave.some(p => textoCliente.includes(p));

        if (esSolicitud || esperandoCurp.get(numeroCliente)) {
            esperandoCurp.set(numeroCliente, true);
            await msg.reply(
                '👋 Hola, para consultar tu acta de nacimiento necesito tu *CURP*.\n\n' +
                'Puedes encontrarla en:\n' +
                '• curp.sep.gob.mx\n' +
                '• Tu INE o pasaporte\n\n' +
                'Envíamela y en segundos te entrego el documento 📄'
            );
        }
        // Si no es solicitud ni tiene CURP, ignorar (puede ser un saludo genérico, etc.)
    }
});

client.initialize();
