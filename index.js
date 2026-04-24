const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

// ============ CONFIGURACIÓN ============

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;       // Solo para Whisper (transcripción)
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;   // Para interpretar tareas
const SUMMARY_CHAT_ID = process.env.SUMMARY_CHAT_ID || null;
const CRON_INTERVAL_MINUTES = 5;

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
    console.log(`Audio descargado: ${audioBuffer.length} bytes, fileUrl: ${fileUrl}`);

    const FormData = require('form-data');
    const form = new FormData();
    form.append('file', audioBuffer, { filename: 'audio.opus', contentType: 'audio/opus' });
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
    return transcription.data.text || null;
  } catch (error) {
    console.error('Error transcribing audio:', error.response?.data || error.message);
    return null;
  }
}

// ============ CLAUDE — PROCESAMIENTO MULTI-TAREA ============

async function processWithClaude(userMessage, existingTasks = []) {
  try {
    const now = new Date();
    const offsetHours = getMadridOffsetHours();
    const madridNow = now.toLocaleString('es-ES', {
      timeZone: 'Europe/Madrid',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });

    const isSummary = existingTasks.length > 0 &&
      /termin|hice|hoy|complet|entregu|llamé|envié|acab|ya |hech/i.test(userMessage);

    let prompt;

    if (isSummary) {
      const taskListText = existingTasks.map(t => `ID:${t.id} | ${t.titulo}`).join('\n');
      prompt = `Fecha/hora Madrid: ${madridNow} (UTC+${offsetHours})

Tareas pendientes en la base de datos:
${taskListText}

El usuario dice: "${userMessage}"

Devuelve ÚNICAMENTE un JSON array válido, sin texto adicional:
[
  {"tipo":"nueva","titulo":"nombre corto","descripcion":"detalles o cadena vacía","prioridad":"ALTA|MEDIA|BAJA","fecha_vencimiento":"ISO 8601 UTC o null"},
  {"tipo":"completada","tarea_id":"ID exacto de la lista o null","titulo":"nombre de la tarea"}
]

Reglas:
- "nueva": algo pendiente de hacer
- "completada": algo que el usuario menciona que ya hizo — busca el ID en la lista
- Las horas que diga el usuario son en Madrid: réstale ${offsetHours}h para convertir a UTC
- Si no menciona fecha → fecha_vencimiento: null`;
    } else {
      prompt = `Fecha/hora Madrid: ${madridNow} (UTC+${offsetHours})

El usuario dice: "${userMessage}"

Devuelve ÚNICAMENTE un JSON array válido, sin texto adicional:
[{"tipo":"nueva","titulo":"nombre corto de la tarea","descripcion":"detalles o cadena vacía","prioridad":"ALTA|MEDIA|BAJA","fecha_vencimiento":"ISO 8601 UTC o null"}]

Las horas que diga el usuario son en Madrid: réstale ${offsetHours}h para UTC. Sin fecha → null.`;
    }

    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      },
      {
        headers: {
          'x-api-key': CLAUDE_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
      }
    );

    const content = response.data.content[0].text.trim();
    const clean = content.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (error) {
    console.error('Error processing with Claude:', error.response?.data || error.message);
    return null;
  }
}

async function saveToDB(task, chatId) {
  try {
    const { error } = await supabase.from('tareas').insert([{
      titulo: task.titulo,
      descripcion: task.descripcion || '',
      prioridad: task.prioridad,
      fecha_vencimiento: task.fecha_vencimiento,
      completada: false,
      chat_id: chatId,
    }]);
    if (error) throw error;
  } catch (error) {
    console.error('Error saving to DB:', error.message);
  }
}

async function markComplete(tareaId) {
  try {
    const { error } = await supabase
      .from('tareas')
      .update({ completada: true })
      .eq('id', tareaId);
    if (error) throw error;
  } catch (error) {
    console.error('Error marking complete:', error.message);
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

    // Comandos de sistema
    if (userMessage.startsWith('/start') || userMessage.startsWith('/help')) {
      await sendTelegramMessage(chatId,
        '👋 <b>BravoBarbera Task Bot</b>\n\n' +
        'Escríbeme o grábame una tarea o un resumen del día:\n' +
        '<i>"Llamar al cliente mañana a las 10"</i>\n' +
        '<i>"Hoy terminé el logo de Juan, mañana tengo que enviar la factura"</i>\n\n' +
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

    // Obtener tareas existentes para contexto
    const { data: existingTasks } = await supabase
      .from('tareas')
      .select('id, titulo, descripcion')
      .eq('completada', false)
      .eq('chat_id', chatId);

    // Procesar con Claude (multi-tarea)
    const results = await processWithClaude(userMessage, existingTasks || []);
    if (!results) {
      await sendTelegramMessage(chatId, '❌ Error procesando tu mensaje. Intenta de nuevo.');
      return res.status(200).json({ ok: true });
    }

    const nuevas = results.filter(r => r.tipo === 'nueva');
    const completadas = results.filter(r => r.tipo === 'completada');

    // Guardar tareas nuevas
    for (const tarea of nuevas) {
      await saveToDB(tarea, chatId);
    }

    // Marcar completadas (solo si tenemos ID confirmado)
    const completadasConId = completadas.filter(r => r.tarea_id);
    for (const tarea of completadasConId) {
      await markComplete(tarea.tarea_id);
    }

    // Construir respuesta
    const lineas = [];

    if (nuevas.length > 0) {
      lineas.push('📥 <b>Añadidas:</b>');
      for (const t of nuevas) {
        const emoji = { ALTA: '🔴', MEDIA: '🟡', BAJA: '🟢' }[t.prioridad] || '⚪';
        const fecha = t.fecha_vencimiento ? ` · 📅 ${formatFechaMadrid(t.fecha_vencimiento)}` : '';
        lineas.push(`${emoji} ${t.titulo}${fecha}`);
      }
    }

    if (completadasConId.length > 0) {
      if (lineas.length > 0) lineas.push('');
      lineas.push('✅ <b>Completadas:</b>');
      for (const t of completadasConId) {
        lineas.push(`• ${t.titulo}`);
      }
    }

    // Tareas mencionadas como completadas pero sin match en BD
    const completadasSinId = completadas.filter(r => !r.tarea_id);
    if (completadasSinId.length > 0) {
      if (lineas.length > 0) lineas.push('');
      lineas.push('⚠️ <b>No encontradas en tu lista:</b>');
      for (const t of completadasSinId) {
        lineas.push(`• ${t.titulo}`);
      }
      lineas.push('<i>Escribe <b>lista</b> y usa <b>hecho N</b> para marcarlas.</i>');
    }

    if (lineas.length === 0) {
      await sendTelegramMessage(chatId, '🤔 No entendí ninguna tarea. Intenta ser más específico.');
    } else {
      await sendTelegramMessage(chatId, lineas.join('\n'));
    }

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

app.get('/cron/reminders', async (req, res) => {
  if (!checkCronAuth(req, res)) return;
  try {
    const now = new Date();
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
      await supabase.from('tareas').update({ completada: true }).eq('id', tarea.id);
    }

    res.json({ ok: true, processed: tareas?.length || 0 });
  } catch (error) {
    console.error('Cron reminders error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

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

    const buildMensaje = (lista) => {
      const lineas = lista.map(t => {
        const emoji = { ALTA: '🔴', MEDIA: '🟡', BAJA: '🟢' }[t.prioridad] || '⚪';
        const fecha = t.fecha_vencimiento ? `📅 ${formatFechaMadrid(t.fecha_vencimiento)}` : '📅 Sin fecha';
        return `${emoji} <b>${t.titulo}</b>\n   ${fecha}`;
      });
      return `☀️ <b>Buenos días. Tareas pendientes:</b>\n\n${lineas.join('\n\n')}`;
    };

    if (SUMMARY_CHAT_ID) {
      await sendTelegramMessage(SUMMARY_CHAT_ID, buildMensaje(tareas));
    } else {
      const porChat = {};
      for (const tarea of tareas) {
        if (!porChat[tarea.chat_id]) porChat[tarea.chat_id] = [];
        porChat[tarea.chat_id].push(tarea);
      }
      for (const [chatId, lista] of Object.entries(porChat)) {
        await sendTelegramMessage(chatId, buildMensaje(lista));
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
    groq_whisper: GROQ_API_KEY ? '✅' : '❌',
    claude: CLAUDE_API_KEY ? '✅' : '❌',
    summary_group: SUMMARY_CHAT_ID ? '✅' : '⏳ no configurado',
    model: 'claude-haiku-4-5-20251001',
    timestamp: new Date().toISOString(),
  });
});

app.get('/', (req, res) => {
  res.json({ bot: 'BravoBarbera Task Bot', version: '5.0' });
});

module.exports = app;
