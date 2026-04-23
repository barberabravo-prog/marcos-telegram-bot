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
const SUMMARY_CHAT_ID = process.env.SUMMARY_CHAT_ID || null;
const CRON_INTERVAL_MINUTES = 5; // Debe coincidir con el intervalo de cron-job.org

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
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function getMadridOffsetHours() {
  const now = new Date();
  const madridDate = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Madrid' }));
  const utcDate = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }));
  return (madridDate - utcDate) / (1000 * 60 * 60);
}

// ============ AUDIO (Groq Whisper) ============

async function transcribeAudio(fileId) {
  try {
    const fileInfo = await axios.get(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${fileId}`
    );
    const filePath = fileInfo.data.result.file_path;
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`;
    const audioResponse = await axios.get(fileUrl, { responseType: 'arraybuffer' });
    const audioBuffer = Buffer.from(audioResponse.data);

    const FormData = require('form-data');
    const form = new FormData();
    form.append('file', audioBuffer, { filename: 'audio.ogg', contentType: 'audio/ogg' });
    form.append('model', 'whisper-large-v3');
    form.append('language', 'es');

    const transcription = await axios.post(
      'https://api.groq.com/openai/v1/audio/transcriptions',
      form,
      {
        headers: {
          'Authorization': `Bearer ${GROQ_API_KEY}`,
          ...form.getHeaders(),
        },
      }
    );
    return transcription.data.text;
  } catch (error) {
    console.error('Error transcribing audio:', error.response?.data || error.message);
    return null;
  }
}

// ============ GROQ ============

async function processWithGroq(userMessage) {
  try {
    const now = new Date();
    const offsetHours = getMadridOffsetHours();
    const madridNow = now.toLocaleString('es-ES', {
      timeZone: 'Europe/Madrid',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });

    const prompt = `Eres un asistente para organizar tareas. El usuario está en Madrid, España (UTC+${offsetHours}).

Hora actual en Madrid: ${madridNow}
Hora actual UTC: ${now.toISOString()}

El usuario dice: "${userMessage}"

Responde ÚNICAMENTE con un JSON válido, sin texto adicional ni bloques de código:
{
  "titulo": "nombre corto de la tarea",
  "descripcion": "detalles adicionales o cadena vacía",
  "prioridad": "ALTA o MEDIA o BAJA",
  "fecha_vencimiento": "ISO 8601 en UTC. Si el usuario dice una hora local (ej: 16:30 Madrid), réstale ${offsetHours} horas para UTC (ej: ${16 - offsetHours}:30 UTC). Si no menciona fecha ni hora usa null.",
  "resumen_respuesta": "confirmación breve mostrando la hora en hora Madrid"
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
    const { data, error } = await supabase.from('tareas').insert([{
      titulo: task.titulo,
      descripcion: task.descripcion,
      prioridad: task.prioridad,
      fecha_vencimiento: task.fecha_vencimiento,
      completada: false,
      chat_id: chatId,
    }]);
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
      await sendTelegramMessage(chatId, '🎙️ Transcribiendo...');
      const transcription = await transcribeAudio(message.voice.file_id);
      if (!transcription) {
        await sendTelegramMessage(chatId, '❌ No pude transcribir el audio. Intenta de nuevo.');
        return res.status(200).json({ ok: true });
      }
      await sendTelegramMessage(chatId, `🎙️ Entendido: "<i>${transcription}</i>"`);
      userMessage = transcription;
    } else {
      return res.status(200).json({ ok: true });
    }

    if (userMessage.startsWith('/start') || userMessage.startsWith('/help')) {
      await sendTelegramMessage(chatId,
        '👋 <b>BravoBarbera Task Bot</b>\n\n' +
        'Escríbeme o grábame una tarea:\n' +
        '<i>"Llamar al cliente mañana a las 10"</i>\n\n' +
        'Comandos:\n' +
        '• <b>lista</b> → ver tareas pendientes numeradas\n' +
        '• <b>hecho 1</b> → marcar tarea 1 como completada\n' +
        '• <b>hecho 1 2 3</b> → marcar varias a la vez\n' +
        '• <b>hecho todo</b> → completar todas las tareas'
      );
      return res.status(200).json({ ok: true });
    }

    const msgLower = userMessage.trim().toLowerCase();

    // Comando: lista
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
        `📋 <b>Tareas pendientes:</b>\n\n${lineas.join('\n\n')}\n\n` +
        `Escribe <b>hecho 1</b>, <b>hecho 1 2 3</b> o <b>hecho todo</b>.`
      );
      return res.status(200).json({ ok: true });
    }

    // Comando: hecho (individual, múltiple o todo)
    const hechoMatch = msgLower.match(/^hecho\s+(.+)$/);
    if (hechoMatch) {
      const arg = hechoMatch[1].trim();

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

      let tareasACompletar = [];

      if (arg === 'todo' || arg === 'todas') {
        tareasACompletar = tareas;
      } else {
        const numeros = arg.split(/\s+/).map(n => parseInt(n) - 1).filter(n => !isNaN(n) && n >= 0 && n < tareas.length);
        tareasACompletar = numeros.map(i => tareas[i]);
      }

      if (tareasACompletar.length === 0) {
        await sendTelegramMessage(chatId, '❌ Números no válidos. Escribe <b>lista</b> para ver tus tareas.');
        return res.status(200).json({ ok: true });
      }

      const ids = tareasACompletar.map(t => t.id);
      await supabase.from('tareas').update({ completada: true }).in('id', ids);

      const nombres = tareasACompletar.map(t => `• ${t.titulo}`).join('\n');
      await sendTelegramMessage(chatId, `✅ Completadas:\n${nombres}`);
      return res.status(200).json({ ok: true });
    }

    // Procesar tarea nueva
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

// Recordatorios: solo notifica tareas que vencen en la ventana actual de 5 minutos
app.get('/cron/reminders', async (req, res) => {
  if (!checkCronAuth(req, res)) return;
  try {
    const now = new Date();
    // Ventana: desde hace CRON_INTERVAL_MINUTES hasta ahora
    // Solo notifica tareas que acaban de vencer en este ciclo
    const windowStart = new Date(now.getTime() - CRON_INTERVAL_MINUTES * 60 * 1000);

    const { data: tareas } = await supabase
      .from('tareas')
      .select('*')
      .eq('completada', false)
      .gte('fecha_vencimiento', windowStart.toISOString())
      .lte('fecha_vencimiento', now.toISOString())
      .not('fecha_vencimiento', 'is', null);

    for (const tarea of tareas || []) {
      const texto = `⏰ <b>RECORDATORIO</b>\n\n📌 ${tarea.titulo}${tarea.descripcion ? `\n📝 ${tarea.descripcion}` : ''}\n📅 ${formatFechaMadrid(tarea.fecha_vencimiento)}`;
      await sendTelegramMessage(tarea.chat_id, texto);
      // Marcar como completada para que no vuelva a aparecer
      await supabase.from('tareas').update({ completada: true }).eq('id', tarea.id);
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

    const lineas = tareas.map(t => {
      const emoji = { ALTA: '🔴', MEDIA: '🟡', BAJA: '🟢' }[t.prioridad] || '⚪';
      const fecha = t.fecha_vencimiento ? `📅 ${formatFechaMadrid(t.fecha_vencimiento)}` : '📅 Sin fecha';
      return `${emoji} <b>${t.titulo}</b>\n   ${fecha}`;
    });

    const mensaje = `☀️ <b>Buenos días. Tareas pendientes:</b>\n\n${lineas.join('\n\n')}`;

    if (SUMMARY_CHAT_ID) {
      await sendTelegramMessage(SUMMARY_CHAT_ID, mensaje);
    } else {
      const porChat = {};
      for (const tarea of tareas) {
        if (!porChat[tarea.chat_id]) porChat[tarea.chat_id] = [];
        porChat[tarea.chat_id].push(tarea);
      }
      for (const [chatId, listaTareas] of Object.entries(porChat)) {
        const l = listaTareas.map(t => {
          const emoji = { ALTA: '🔴', MEDIA: '🟡', BAJA: '🟢' }[t.prioridad] || '⚪';
          const fecha = t.fecha_vencimiento ? `📅 ${formatFechaMadrid(t.fecha_vencimiento)}` : '📅 Sin fecha';
          return `${emoji} <b>${t.titulo}</b>\n   ${fecha}`;
        });
        await sendTelegramMessage(chatId, `☀️ <b>Buenos días. Tareas pendientes:</b>\n\n${l.join('\n\n')}`);
      }
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
    summary_group: SUMMARY_CHAT_ID ? '✅' : '⏳ no configurado',
    model: 'llama-3.3-70b-versatile',
    timestamp: new Date().toISOString(),
  });
});

app.get('/', (req, res) => {
  res.json({ bot: 'BravoBarbera Task Bot', version: '4.1' });
});

module.exports = app;
