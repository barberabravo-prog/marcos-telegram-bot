const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

// ============ CONFIGURACIÓN ============

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ============ UTILIDADES ============

async function sendTelegramMessage(chatId, text, parseMode = 'HTML') {
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text: text,
      parse_mode: parseMode,
    });
  } catch (error) {
    console.error('Error sending Telegram message:', error.response?.data || error.message);
  }
}

async function processWithClaude(userMessage) {
  try {
    const prompt = `Eres un asistente para organizar tareas. El usuario te dice: "${userMessage}"

Extrae y responde ÚNICAMENTE con un JSON válido, sin texto adicional, sin bloques de código:
{
  "titulo": "nombre corto de la tarea",
  "descripcion": "detalles",
  "prioridad": "ALTA|MEDIA|BAJA",
  "fecha_vencimiento": "2026-04-23T10:00:00Z o null",
  "resumen_respuesta": "confirmación breve para enviar al usuario"
}

Fecha actual: ${new Date().toISOString()}
Si el usuario dice "mañana", calcula la fecha correcta.
Si solo menciona hora sin fecha, usa hoy.
Si no menciona fecha ni hora, usa null.`;

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 500, temperature: 0.1 },
      },
      { headers: { 'Content-Type': 'application/json' } }
    );

    const content = response.data.candidates[0].content.parts[0].text.trim();
    const clean = content.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (error) {
    console.error('Error processing with Gemini:', error.response?.data || error.message);
    return null;
  }
}

async function saveToDB(task, chatId) {
  try {
    const { data, error } = await supabase.from('tareas').insert([
      {
        titulo: task.titulo,
        descripcion: task.descripcion,
        prioridad: task.prioridad,
        fecha_vencimiento: task.fecha_vencimiento,
        completada: false,
        chat_id: chatId,
      },
    ]);

    if (error) throw error;
    return data;
  } catch (error) {
    console.error('Error saving to DB:', error.message);
    return null;
  }
}

// ============ WEBHOOK TELEGRAM ============

app.post('/webhook/telegram', async (req, res) => {
  try {
    const { message } = req.body;

    if (!message) {
      return res.status(200).json({ ok: true });
    }

    const chatId = message.chat.id;
    let userMessage = '';

    if (message.text) {
      userMessage = message.text;
    } else if (message.voice) {
      await sendTelegramMessage(chatId, '🎙️ Audio recibido, pero por ahora solo proceso texto. Escríbelo y lo guardo.');
      return res.status(200).json({ ok: true });
    } else {
      return res.status(200).json({ ok: true });
    }

    // Ignorar comandos de sistema
    if (userMessage.startsWith('/start') || userMessage.startsWith('/help')) {
      await sendTelegramMessage(chatId, '👋 <b>BravoBarbera Task Bot</b>\n\nEscríbeme una tarea en lenguaje natural y la guardo:\n\n<i>"Llamar al cliente mañana a las 10"</i>\n<i>"Entregar proyecto antes del viernes, urgente"</i>');
      return res.status(200).json({ ok: true });
    }

    // Procesar con Claude
    const processed = await processWithClaude(userMessage);
    if (!processed) {
      await sendTelegramMessage(chatId, '❌ Error procesando tu mensaje. Intenta de nuevo.');
      return res.status(200).json({ ok: true });
    }

    // Guardar en Supabase
    await saveToDB(processed, chatId);

    // Responder al usuario
    const emoji = { ALTA: '🔴', MEDIA: '🟡', BAJA: '🟢' }[processed.prioridad] || '⚪';

    const responseText = [
      `✅ ${processed.resumen_respuesta}`,
      '',
      `📌 <b>${processed.titulo}</b>`,
      `Prioridad: ${emoji} ${processed.prioridad}`,
      processed.fecha_vencimiento
        ? `📅 ${new Date(processed.fecha_vencimiento).toLocaleString('es-ES', { timeZone: 'Europe/Madrid' })}`
        : '',
      processed.descripcion ? `📝 ${processed.descripcion}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    await sendTelegramMessage(chatId, responseText);
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Webhook error:', error.message);
    return res.status(200).json({ ok: true }); // Siempre 200 a Telegram
  }
});

// ============ CRON ENDPOINT (llamar desde Vercel Cron) ============

app.get('/cron/reminders', async (req, res) => {
  // Seguridad básica: solo desde Vercel Cron
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { data: tareas } = await supabase
      .from('tareas')
      .select('*')
      .eq('completada', false)
      .lte('fecha_vencimiento', new Date().toISOString())
      .not('fecha_vencimiento', 'is', null);

    for (const tarea of tareas || []) {
      const reminderText = `⏰ <b>RECORDATORIO</b>\n\n📌 ${tarea.titulo}${tarea.descripcion ? `\n📝 ${tarea.descripcion}` : ''}`;
      await sendTelegramMessage(tarea.chat_id, reminderText);
    }

    res.json({ ok: true, processed: tareas?.length || 0 });
  } catch (error) {
    console.error('Cron error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============ ENDPOINTS AUXILIARES ============

app.get('/status', (req, res) => {
  res.json({
    status: 'Bot operativo',
    telegram: TELEGRAM_TOKEN ? '✅' : '❌',
    supabase: SUPABASE_URL ? '✅' : '❌',
    gemini: GEMINI_API_KEY ? '✅' : '❌',
    model: 'gemini-2.0-flash',
    timestamp: new Date().toISOString(),
  });
});

app.get('/', (req, res) => {
  res.json({
    bot: 'BravoBarbera Task Bot',
    version: '2.0',
    endpoints: {
      webhook: 'POST /webhook/telegram',
      status: 'GET /status',
      cron: 'GET /cron/reminders',
    },
  });
});

// ============ EXPORT PARA VERCEL ============
// Vercel no usa app.listen() — exporta el handler directamente
module.exports = app;
