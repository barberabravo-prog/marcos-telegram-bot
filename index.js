const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

// ============ CONFIGURACIÓN ============

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;           // Ya no se usa
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;   // Transcripción de audio
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;       // Interpretación de tareas
const SUMMARY_CHAT_ID = process.env.SUMMARY_CHAT_ID || null;
const WEATHER_LAT = process.env.WEATHER_LAT || '39.47';   // Valencia por defecto
const WEATHER_LON = process.env.WEATHER_LON || '-0.38';
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
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${fileInfo.data.result.file_path}`;

    const response = await axios.post(
      'https://api.deepgram.com/v1/listen?model=nova-2&language=es&smart_format=true',
      { url: fileUrl },
      {
        headers: {
          'Authorization': `Token ${DEEPGRAM_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    return response.data.results.channels[0].alternatives[0].transcript || null;
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

// ============ TIEMPO (Open-Meteo) ============

function weatherEmoji(code) {
  if (code === 0) return '☀️';
  if (code <= 2) return '🌤️';
  if (code === 3) return '☁️';
  if (code <= 48) return '🌫️';
  if (code <= 55) return '🌦️';
  if (code <= 65) return '🌧️';
  if (code <= 75) return '❄️';
  if (code <= 82) return '🌧️';
  return '⛈️';
}

function weatherDesc(code) {
  if (code === 0) return 'Despejado';
  if (code === 1) return 'Mayormente despejado';
  if (code === 2) return 'Parcialmente nublado';
  if (code === 3) return 'Nublado';
  if (code <= 48) return 'Niebla';
  if (code <= 55) return 'Llovizna';
  if (code <= 65) return 'Lluvia';
  if (code <= 75) return 'Nieve';
  if (code <= 82) return 'Chubascos';
  return 'Tormenta';
}

async function getWeather() {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${WEATHER_LAT}&longitude=${WEATHER_LON}&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_sum,windspeed_10m_max&hourly=temperature_2m&timezone=Europe/Madrid&forecast_days=1`;
    const { data } = await axios.get(url);

    const code = data.daily.weathercode[0];
    const tMax = Math.round(data.daily.temperature_2m_max[0]);
    const tMin = Math.round(data.daily.temperature_2m_min[0]);
    const lluvia = data.daily.precipitation_sum[0];
    const viento = Math.round(data.daily.windspeed_10m_max[0]);
    const temps = data.hourly.temperature_2m;
    const tMedia = Math.round(temps.reduce((a, b) => a + b, 0) / temps.length);

    return { code, tMax, tMin, tMedia, lluvia, viento };
  } catch (error) {
    console.error('Error getting weather:', error.message);
    return null;
  }
}

// ============ CRON ENDPOINTS ============

function checkCronAuth(req, res) {
  // Si no hay CRON_SECRET configurado, permitir acceso libre
  if (!process.env.CRON_SECRET) return true;
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

// Mensaje de las 9:00 — tiempo + tareas del día
app.get('/cron/morning', async (req, res) => {
  if (!checkCronAuth(req, res)) return;
  try {
    const [weather, { data: tareas }] = await Promise.all([
      getWeather(),
      supabase.from('tareas').select('*').eq('completada', false)
        .order('fecha_vencimiento', { ascending: true, nullsFirst: false }),
    ]);

    const lineas = [];

    // Bloque tiempo
    if (weather) {
      const emoji = weatherEmoji(weather.code);
      const desc = weatherDesc(weather.code);
      lineas.push(`${emoji} <b>${desc}</b>`);
      lineas.push(`🌡️ Media <b>${weather.tMedia}°C</b>  ·  Máx ${weather.tMax}°C  ·  Mín ${weather.tMin}°C`);
      if (weather.lluvia > 0) lineas.push(`🌧️ Lluvia: ${weather.lluvia} mm`);
      if (weather.viento > 30) lineas.push(`💨 Viento: ${weather.viento} km/h`);
    }

    // Bloque tareas
    if (tareas && tareas.length > 0) {
      lineas.push('');
      lineas.push('📋 <b>Tareas de hoy:</b>');
      for (const t of tareas) {
        const e = { ALTA: '🔴', MEDIA: '🟡', BAJA: '🟢' }[t.prioridad] || '⚪';
        const fecha = t.fecha_vencimiento ? ` · 📅 ${formatFechaMadrid(t.fecha_vencimiento)}` : '';
        lineas.push(`${e} ${t.titulo}${fecha}`);
      }
    } else {
      lineas.push('');
      lineas.push('✅ Sin tareas pendientes.');
    }

    const mensaje = `☀️ <b>Buenos días, Marcos</b>\n\n${lineas.join('\n')}`;

    if (SUMMARY_CHAT_ID) {
      await sendTelegramMessage(SUMMARY_CHAT_ID, mensaje);
    } else {
      const chats = [...new Set((tareas || []).map(t => t.chat_id))];
      if (chats.length === 0 && SUMMARY_CHAT_ID === null) {
        // No hay chats conocidos — no hacer nada
      } else {
        for (const chatId of chats) {
          await sendTelegramMessage(chatId, mensaje);
        }
      }
    }

    res.json({ ok: true, tareas: tareas?.length || 0, weather: !!weather });
  } catch (error) {
    console.error('Cron morning error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

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
    deepgram: DEEPGRAM_API_KEY ? '✅' : '❌',
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
