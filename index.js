// Limpiar bloqueos de Chromium al iniciar
const { execSync } = require('child_process');
try {
    execSync('rm -f /app/.wwebjs_auth/session/SingletonLock');
    execSync('rm -f /app/.wwebjs_auth/session/.org.chromium.Chromium*');
    console.log('🧹 Locks limpiados');
} catch(e) {}



const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const http = require('http');
const fs = require('fs');

const NOMBRE_GRUPO_DOCIFY = 'ACTA DOCIFY 13-GONZALEZ';
const CURP_REGEX = /[A-Z]{4}\d{6}[HM][A-Z]{5}[A-Z0-9]\d/i;
const solicitudes = new Map();
const esperandoCurp = new Map();

// Servidor HTTP simple para mantener el proceso vivo
const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('Bot activo');
});
server.listen(process.env.PORT || 3000);

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: '/app/.wwebjs_auth' }),
    puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--single-process'],
        headless: true
    }
});

client.on('qr', (qr) => {
    console.log('=== ESCANEA ESTE QR CON WHATSAPP ===');
    qrcode.generate(qr, { small: true });
    console.log('====================================');
});

client.on('ready', async () => {
    console.log('✅ Bot conectado y listo');
    const chats = await client.getChats();
    const grupo = chats.find(c => c.isGroup && c.name.includes(NOMBRE_GRUPO_DOCIFY));
    if (grupo) {
        console.log(`✅ Grupo Docify encontrado: ${grupo.name}`);
    } else {
        console.log('⚠️ Grupo Docify NO encontrado');
        console.log('Grupos:', chats.filter(c => c.isGroup).map(c => c.name));
    }
});

client.on('message', async (msg) => {
    const chat = await msg.getChat();
    const esGrupoDocify = chat.isGroup && chat.name.includes(NOMBRE_GRUPO_DOCIFY);

    if (esGrupoDocify) {
        if (msg.hasMedia && msg.type === 'document') {
            const nombreArchivo = msg._data?.filename || '';
            const curpEnArchivo = nombreArchivo.replace('.pdf', '').toUpperCase();
            const numeroCliente = solicitudes.get(curpEnArchivo);
            if (numeroCliente) {
                console.log(`📄 PDF recibido para ${curpEnArchivo}, enviando a ${numeroCliente}`);
                const media = await msg.downloadMedia();
                const chatCliente = await client.getChatById(numeroCliente);
                await chatCliente.sendMessage('✅ Aquí está tu acta de nacimiento:');
                await chatCliente.sendMessage(media, { sendMediaAsDocument: true, filename: `${curpEnArchivo}.pdf` });
                solicitudes.delete(curpEnArchivo);
            }
        }
        return;
    }

    if (chat.isGroup) return;

    const textoCliente = msg.body.trim().toUpperCase();
    const numeroCliente = msg.from;
    const matchCurp = textoCliente.match(CURP_REGEX);

    if (matchCurp) {
        const curp = matchCurp[0].toUpperCase();
        console.log(`📨 CURP de ${numeroCliente}: ${curp}`);
        await msg.reply('⏳ Recibido. Consultando tu acta, en unos segundos te la enviamos...');
        solicitudes.set(curp, numeroCliente);
        esperandoCurp.delete(numeroCliente);
        const chats = await client.getChats();
        const grupo = chats.find(c => c.isGroup && c.name.includes(NOMBRE_GRUPO_DOCIFY));
        if (grupo) {
            await grupo.sendMessage(`${curp} ACTA`);
            console.log(`📤 Enviado a Docify: ${curp} ACTA`);
        }
    } else {
        const palabrasClave = ['ACTA', 'NACIMIENTO', 'DOCUMENTO', 'NECESITO', 'QUIERO', 'SOLICITO', 'HOLA'];
        const esSolicitud = palabrasClave.some(p => textoCliente.includes(p));
        if (esSolicitud || esperandoCurp.get(numeroCliente)) {
            esperandoCurp.set(numeroCliente, true);
            await msg.reply(
                '👋 Hola, para consultar tu acta de nacimiento necesito tu *CURP*.\n\n' +
                'Puedes encontrarla en:\n• curp.sep.gob.mx\n• Tu INE o pasaporte\n\n' +
                'Envíamela y en segundos te entrego el documento 📄'
            );
        }
    }
});

client.initialize();
