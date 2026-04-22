const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { google } = require('googleapis');
const cron = require('node-cron');

const app = express();
app.use(express.json());

// ============ CONFIGURACIÓN ============

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const oauth2Client = new google.auth.OAuth2(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  `${process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : 'http://localhost:3000'}/oauth/callback`
);

if (GOOGLE_REFRESH_TOKEN) {
  oauth2Client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
}

const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

// ============ UTILIDADES ============

async function sendTelegramMessage(chatId, text, parseMode = 'HTML') {
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text: text,
      parse_mode: parseMode,
    });
  } catch (error) {
    console.error('Error sending Telegram message:', error);
  }
}

async function transcribeAudio(fileId) {
  try {
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${fileId}`;
    const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
    
    // Enviar a Claude para transcripción (usando vision si es necesario)
    // Por ahora, retornamos placeholder
    return 'Audio transcrito';
  } catch (error) {
    console.error('Error transcribing audio:', error);
    return null;
  }
}

async function processWithClaude(userMessage) {
  try {
    const response = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 500,
      messages: [
        {
          role: 'user',
          content: `Eres un asistente para organizar tareas. El usuario te dice: "${userMessage}"

Extrae y responde en JSON:
{
  "titulo": "nombre corto de la tarea",
  "descripcion": "detalles",
  "prioridad": "ALTA|MEDIA|BAJA",
  "fecha_vencimiento": "2026-04-23T10:00:00Z (ISO 8601, si no menciona hora, usa 09:00) o null",
  "resumen_respuesta": "confirmación bonita para enviar al usuario"
}

IMPORTANTE: La fecha debe ser en ISO 8601. Si el usuario dice "mañana", calcula la fecha. Si solo dice hora sin fecha, usa hoy. Si no menciona nada, usa null.`,
        },
      ],
    }, {
      headers: {
        'x-api-key': CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
      },
    });

    const content = response.data.content[0].text;
    const parsed = JSON.parse(content);
    return parsed;
  } catch (error) {
    console.error('Error processing with Claude:', error);
    return null;
  }
}

async function createGoogleCalendarEvent(task) {
  try {
    if (!task.fecha_vencimiento) {
      // Si no hay fecha, no crear evento
      return null;
    }

    const event = {
      summary: task.titulo,
      description: task.descripcion,
      start: {
        dateTime: task.fecha_vencimiento,
        timeZone: 'Europe/Madrid',
      },
      end: {
        dateTime: new Date(new Date(task.fecha_vencimiento).getTime() + 60 * 60 * 1000).toISOString(),
        timeZone: 'Europe/Madrid',
      },
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'popup', minutes: 30 },
          { method: 'notification', minutes: 10 },
        ],
      },
    };

    const result = await calendar.events.insert({
      calendarId: 'primary',
      resource: event,
    });

    return result.data.id;
  } catch (error) {
    console.error('Error creating Google Calendar event:', error);
    return null;
  }
}

async function saveToDB(task, chatId, googleEventId = null) {
  try {
    const { data, error } = await supabase
      .from('tareas')
      .insert([
        {
          titulo: task.titulo,
          descripcion: task.descripcion,
          prioridad: task.prioridad,
          fecha_vencimiento: task.fecha_vencimiento,
          completada: false,
          chat_id: chatId,
          google_event_id: googleEventId,
        },
      ]);

    if (error) throw error;
    return data;
  } catch (error) {
    console.error('Error saving to DB:', error);
    return null;
  }
}

// ============ WEBHOOKS ============

app.post('/webhook/telegram', async (req, res) => {
  try {
    const { message } = req.body;

    if (!message) {
      return res.status(200).json({ ok: true });
    }

    const chatId = message.chat.id;
    const userId = message.from.id;
    let userMessage = '';

    // Procesar texto o audio
    if (message.text) {
      userMessage = message.text;
    } else if (message.voice) {
      // Telegram proporciona el file_id del audio
      const fileId = message.voice.file_id;
      userMessage = await transcribeAudio(fileId);
      
      if (!userMessage) {
        await sendTelegramMessage(chatId, '❌ No pude transcribir el audio. Intenta enviar texto.');
        return res.status(200).json({ ok: true });
      }
    } else {
      return res.status(200).json({ ok: true });
    }

    // Procesar con Claude
    const processed = await processWithClaude(userMessage);
    if (!processed) {
      await sendTelegramMessage(chatId, '❌ Error procesando tu mensaje. Intenta de nuevo.');
      return res.status(200).json({ ok: true });
    }

    // Crear evento en Google Calendar
    const googleEventId = await createGoogleCalendarEvent(processed);

    // Guardar en Supabase
    await saveToDB(processed, chatId, googleEventId);

    // Responder al usuario
    const emoji = {
      ALTA: '🔴',
      MEDIA: '🟡',
      BAJA: '🟢',
    }[processed.prioridad] || '⚪';

    const responseText = `✅ ${processed.resumen_respuesta}

📌 <b>${processed.titulo}</b>
Prioridad: ${emoji} ${processed.prioridad}
${processed.fecha_vencimiento ? `📅 ${new Date(processed.fecha_vencimiento).toLocaleString('es-ES')}` : ''}
${processed.descripcion ? `\n📝 ${processed.descripcion}` : ''}

${googleEventId ? '📆 Añadido a tu Calendario' : ''}`;

    await sendTelegramMessage(chatId, responseText);

    res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============ OAUTH GOOGLE ============

app.get('/oauth/start', (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/calendar'],
  });
  res.redirect(authUrl);
});

app.get('/oauth/callback', async (req, res) => {
  try {
    const { code } = req.query;
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Guardar el refresh_token en tus variables de entorno
    console.log('✅ Google Calendar autorizado');
    console.log('Refresh token:', tokens.refresh_token);
    
    res.send('✅ Google Calendar conectado. Cierra esta ventana y configura tu GOOGLE_REFRESH_TOKEN en Vercel.');
  } catch (error) {
    console.error('OAuth error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============ REMINDERS CRON ============

cron.schedule('*/30 * * * *', async () => {
  try {
    const { data: tareas } = await supabase
      .from('tareas')
      .select('*')
      .eq('completada', false)
      .lte('fecha_vencimiento', new Date().toISOString());

    for (const tarea of tareas || []) {
      // Enviar recordatorio
      const reminderText = `⏰ <b>RECORDATORIO</b>\n\n📌 ${tarea.titulo}\n${tarea.descripcion ? `📝 ${tarea.descripcion}` : ''}`;
      await sendTelegramMessage(tarea.chat_id, reminderText);

      // Marcar como recordado (opcional: puedes agregar un campo)
    }
  } catch (error) {
    console.error('Cron job error:', error);
  }
});

// ============ RUTAS AUXILIARES ============

app.get('/status', (req, res) => {
  res.json({
    status: 'Bot operativo',
    telegram: TELEGRAM_TOKEN ? '✅' : '❌',
    supabase: SUPABASE_URL ? '✅' : '❌',
    claude: CLAUDE_API_KEY ? '✅' : '❌',
    google: GOOGLE_REFRESH_TOKEN ? '✅' : '⏳ (necesita autorización)',
  });
});

app.get('/', (req, res) => {
  res.json({
    bot: 'BravoBarbera Task Bot',
    version: '1.0',
    endpoints: {
      webhook: 'POST /webhook/telegram',
      oauth: 'GET /oauth/start',
      status: 'GET /status',
    },
  });
});

// ============ INICIAR SERVIDOR ============

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🤖 Bot running on port ${PORT}`);
  console.log(`📡 Webhook: https://<tu-vercel-url>/webhook/telegram`);
  console.log(`🔑 OAuth: https://<tu-vercel-url>/oauth/start`);
});
