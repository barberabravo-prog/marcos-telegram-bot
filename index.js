const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

// ============ CONFIGURACIÓN ============

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

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

function formatFechaMadrid(fechaUTC) {
  return new Date(fechaUTC).toLocaleString('es-ES', {
    timeZone: 'Europe/Madrid',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

async function processWithGroq(userMessage) {
  try {
    const now = new Date();

    // Calcular offset de Madrid dinámicamente (CEST=+2 en verano, CET=+1 en invierno)
    const madridDate = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Madrid' }));
    const utcDate = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }));
    const offsetHours = (madridDate - utcDate) / (1000 * 60 * 60);
    const offsetStr = `UTC+${offsetHours}`;

    const madridNow = now.toLocaleString('es-ES', {
      timeZone: 'Europe/Madrid',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });

    const prompt = `Eres un asistente para organizar tareas. El usuario está en Madrid, España (${offsetStr}).

Hora actual en Madrid: ${madridNow}
Hora actual UTC: ${now.toISOString()}

El usuario dice: "${userMessage}"

Responde ÚNICAMENTE con un JSON válido, sin texto adicional ni bloques de código:
{
  "titulo": "nombre corto de la tarea",
  "descripcion": "detalles adicionales o cadena vacía",
  "prioridad": "ALTA o MEDIA o BAJA",
  "fecha_vencimiento": "ISO 8601 en UTC. IMPORTANTE: si el usuario dice una hora local (ej: 16:30), debes restarle ${offsetHours} horas para convertir a UTC (ej: 16:30 Madrid = ${16 - offsetHours}:30 UTC). Si no menciona fecha ni hora usa null.",
  "resumen_respuesta": "confirmación breve mostrando la hora en hora Madrid, no UTC"
}`;

    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.3-70b-versatile',
        max_tokens: 500,
        temperature: 0.1,
        messages: [{ role: 'user', content: prompt }],
      },
      {
        headers: {
          'Authorization': `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const content = response.data.choices[0].message.content.trim();
    const clean = content.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (error) {
    console.error('Error processing with Groq:', error.response?.data || error.message);
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
    if (!message) return res.status(200).json({ ok: true });

    const chatId = message.chat.id;
    let userMessage = '';

    if (message.text) {
      userMessage = message.text;
    } else if (message.voice) {
      await sendTelegramMessage(chatId, '🎙️ Por ahora solo proceso texto. Escríbelo y lo guardo.');
      return res.status(200).json({ ok: true });
    } else {
      return res.status(200).json({ ok: true });
    }

    // Comandos /start y /help
    if (userMessage.startsWith('/start') || userMessage.startsWith('/help')) {
      await sendTelegramMessage(chatId,
        '👋 <b>BravoBarbera Task Bot</b>\n\n' +
        'Escríbeme una tarea en lenguaje natural:\n' +
        '<i>"Llamar al cliente mañana a las 10"</i>\n' +
        '<i>"Entregar proyecto el viernes, urgente"</i>\n\n' +
        'Comandos:\n' +
        '• <b>lista</b> → ver tareas pendientes\n' +
        '• <b>hecho N</b> → marcar tarea N como completada'
      );
      return res.status(200).json({ ok: true });
    }

    const msgLower = userMessage.trim().toLowerCase();

    // Comando: lista de tareas pendientes
    if (msgLower === 'lista' || msgLower === 'tareas') {
      const { data: tareas } = await supabase
        .from('tareas')
        .select('*')
        .eq('completada', false)
        .eq('chat_id', chatId)
        .order('fecha_vencimiento', { ascending: true, nullsFirst: false });

      if (!tareas || tareas.length === 0) {
        await sendTelegramMessage(chatId, '✅ No tienes tareas pendientes.');
        return res.status(200).json({ ok: true });
      }

      const lineas = tareas.map((t, i) => {
        const emoji = { ALTA: '🔴', MEDIA: '🟡', BAJA: '🟢' }[t.prioridad] || '⚪';
        const fecha = t.fecha_vencimiento ? `📅 ${formatFechaMadrid(t.fecha_vencimiento)}` : '📅 Sin fecha';
        return `${i + 1}. ${emoji} <b>${t.titulo}</b>\n   ${fecha}`;
      });

      await sendTelegramMessage(chatId,
        `📋 <b>Tareas pendientes:</b>\n\n${lineas.join('\n\n')}\n\nEscribe <b>hecho N</b> para marcar una como completada.`
      );
      return res.status(200).json({ ok: true });
    }

    // Comando: marcar tarea como completada
    const hechoMatch = msgLower.match(/^hecho\s+(\d+)$/);
    if (hechoMatch) {
      const index = parseInt(hechoMatch[1]) - 1;
      const { data: tareas } = await supabase
        .from('tareas')
        .select('*')
        .eq('completada', false)
        .eq('chat_id', chatId)
        .order('fecha_vencimiento', { ascending: true, nullsFirst: false });

      if (!tareas || index < 0 || index >= tareas.length) {
        await sendTelegramMessage(chatId, '❌ Número no válido. Escribe <b>lista</b> para ver tus tareas.');
        return res.status(200).json({ ok: true });
      }

      const tarea = tareas[index];
      await supabase.from('tareas').update({ completada: true }).eq('id', tarea.id);
      await sendTelegramMessage(chatId, `✅ <b>${tarea.titulo}</b> marcada como completada.`);
      return res.status(200).json({ ok: true });
    }

    // Procesar tarea nueva con Groq
    const processed = await processWithGroq(userMessage);
    if (!processed) {
      await sendTelegramMessage(chatId, '❌ Error procesando tu mensaje. Intenta de nuevo.');
      return res.status(200).json({ ok: true });
    }

    await saveToDB(processed, chatId);

    const emoji = { ALTA: '🔴', MEDIA: '🟡', BAJA: '🟢' }[processed.prioridad] || '⚪';
    const responseText = [
      `✅ ${processed.resumen_respuesta}`,
      '',
      `📌 <b>${processed.titulo}</b>`,
      `Prioridad: ${emoji} ${processed.prioridad}`,
      processed.fecha_vencimiento ? `📅 ${formatFechaMadrid(processed.fecha_vencimiento)}` : '',
      processed.descripcion ? `📝 ${processed.descripcion}` : '',
    ].filter(Boolean).join('\n');

    await sendTelegramMessage(chatId, responseText);
    return res.status(200).json({ ok: true });

  } catch (error) {
    console.error('Webhook error:', error.message);
    return res.status(200).json({ ok: true });
  }
});

// ============ CRON ENDPOINTS ============

function checkCronAuth(req, res) {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

// Recordatorios de tareas vencidas
app.get('/cron/reminders', async (req, res) => {
  if (!checkCronAuth(req, res)) return;
  try {
    const { data: tareas } = await supabase
      .from('tareas')
      .select('*')
      .eq('completada', false)
      .lte('fecha_vencimiento', new Date().toISOString())
      .not('fecha_vencimiento', 'is', null);

    for (const tarea of tareas || []) {
      const texto = `⏰ <b>RECORDATORIO</b>\n\n📌 ${tarea.titulo}${tarea.descripcion ? `\n📝 ${tarea.descripcion}` : ''}\n📅 ${formatFechaMadrid(tarea.fecha_vencimiento)}`;
      await sendTelegramMessage(tarea.chat_id, texto);
    }

    res.json({ ok: true, processed: tareas?.length || 0 });
  } catch (error) {
    console.error('Cron reminders error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Resumen diario a las 9:30
app.get('/cron/daily-summary', async (req, res) => {
  if (!checkCronAuth(req, res)) return;
  try {
    const { data: tareas } = await supabase
      .from('tareas')
      .select('*')
      .eq('completada', false)
      .order('fecha_vencimiento', { ascending: true, nullsFirst: false });

    if (!tareas || tareas.length === 0) {
      return res.json({ ok: true, processed: 0 });
    }

    const porChat = {};
    for (const tarea of tareas) {
      if (!porChat[tarea.chat_id]) porChat[tarea.chat_id] = [];
      porChat[tarea.chat_id].push(tarea);
    }

    for (const [chatId, listaTareas] of Object.entries(porChat)) {
      const lineas = listaTareas.map(t => {
        const emoji = { ALTA: '🔴', MEDIA: '🟡', BAJA: '🟢' }[t.prioridad] || '⚪';
        const fecha = t.fecha_vencimiento ? `📅 ${formatFechaMadrid(t.fecha_vencimiento)}` : '📅 Sin fecha';
        return `${emoji} <b>${t.titulo}</b>\n   ${fecha}`;
      });
      await sendTelegramMessage(chatId, `☀️ <b>Buenos días. Tareas pendientes:</b>\n\n${lineas.join('\n\n')}`);
    }

    res.json({ ok: true, processed: tareas.length });
  } catch (error) {
    console.error('Cron daily-summary error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============ ENDPOINTS AUXILIARES ============

app.get('/status', (req, res) => {
  res.json({
    status: 'Bot operativo',
    telegram: TELEGRAM_TOKEN ? '✅' : '❌',
    supabase: SUPABASE_URL ? '✅' : '❌',
    groq: GROQ_API_KEY ? '✅' : '❌',
    model: 'llama-3.3-70b-versatile',
    timestamp: new Date().toISOString(),
  });
});

app.get('/', (req, res) => {
  res.json({
    bot: 'BravoBarbera Task Bot',
    version: '3.0',
    endpoints: {
      webhook: 'POST /webhook/telegram',
      status: 'GET /status',
      reminders: 'GET /cron/reminders',
      summary: 'GET /cron/daily-summary',
    },
  });
});

module.exports = app;
