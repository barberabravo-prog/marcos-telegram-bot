# 🤖 BravoBarbera Task Bot

Bot de Telegram para gestionar tareas con inteligencia artificial, sincronización automática a Google Calendar (y por tanto a Apple Calendar), y recordatorios.

## ¿Qué hace?

```
📱 Telegram (móvil)
    ↓ [Escribes o grabas audio]
"Hacer AAFF para Mallorca, urgente, antes del viernes"
    ↓
🧠 Claude (procesa e interpreta)
    ↓
📊 Supabase (guarda la tarea)
+ 📆 Google Calendar (crea evento)
+ 🔔 Apple Calendar (sincronización automática)
+ ⏰ Recordatorios automáticos cada 30 minutos
```

## Comandos

### Crear tarea

**Escribe naturalmente:**
```
/bot Llamar a Cliente X mañana a las 10:00
/bot Entregar proyecto antes del viernes
/bot Comprar ingredientes para el sábado a las 5pm
```

**O graba audio:**
```
[Graba un audio describiendo la tarea]
```

Claude interpreta automáticamente y extrae:
- **Título**: Nombre corto
- **Descripción**: Detalles
- **Prioridad**: 🔴 ALTA / 🟡 MEDIA / 🟢 BAJA
- **Fecha/Hora**: Si la mencionas, la usa. Si no, null

### Ver respuesta

El bot responde:
```
✅ Guardado: Llamar Cliente X
📌 Llamar Cliente X
Prioridad: 🔴 ALTA
📅 Mañana 10:00
📆 Añadido a tu Calendario
```

### Recordatorios

Cada 30 minutos, el bot revisa tareas vencidas y envía:
```
⏰ RECORDATORIO
📌 Llamar Cliente X
📝 Detalles...
```

## Setup

### Rápido (5 minutos)

1. Lee `DEPLOYMENT.md`
2. Sigue los pasos en orden
3. Listo

### Lo que ya tienes

✅ Telegram Token
✅ Supabase URL + KEY
✅ Claude API Key

### Lo que necesitas (Google Calendar)

- Crear OAuth credentials en Google Cloud Console
- Autorizar una sola vez vía Google
- Listo para siempre

## Estructura

```
marcos-bot/
├── index.js              # Código principal del bot
├── package.json          # Dependencias
├── .env.example         # Variables de entorno
├── DEPLOYMENT.md        # Guía de instalación
└── README.md            # Este archivo
```

## Flujo técnico

```
User → Telegram API → Vercel Webhook
                          ↓
                      Node.js Bot
                          ↓
                      ┌───┴───┬──────────┐
                      ↓       ↓          ↓
                   Claude  Supabase   Google
                      ↓       ↓          ↓
                    Parse   Save      Create
                    Task    DB        Event
                      ↓       ↓          ↓
                    ┌─────────┴──────────┘
                    ↓
            Response → Telegram
```

## Variables de entorno necesarias

| Variable | Dónde obtener | Ejemplo |
|----------|---------------|---------|
| `TELEGRAM_TOKEN` | @BotFather en Telegram | `8775969...` |
| `SUPABASE_URL` | Dashboard Supabase | `https://xxx.supabase.co` |
| `SUPABASE_KEY` | Settings → API en Supabase | `sb_publishable...` |
| `CLAUDE_API_KEY` | https://console.anthropic.com | `sk-ant-v4-...` |
| `GOOGLE_CLIENT_ID` | Google Cloud Console | `xxx.apps.googleusercontent.com` |
| `GOOGLE_CLIENT_SECRET` | Google Cloud Console | `GOCSPX-...` |
| `GOOGLE_REFRESH_TOKEN` | OAuth callback (paso 6) | Generado automáticamente |

## Ejemplos de tareas

### Tareas simples
```
Comprar café
Llamar al cliente
Responder emails
```

### Con fecha
```
Entregar proyecto mañana
Hacer AAFF antes del viernes
Reunión el lunes a las 3pm
```

### Complejas
```
Diseñar la portada del catálogo de 99Cheesecake,
con los colores nuevos, para el viernes antes de las 6pm.
Es urgente porque se presenta el sábado
```

Claude entiende el contexto y crea:
- Título: "Diseñar portada 99Cheesecake"
- Prioridad: ALTA
- Fecha: Viernes 23:59
- Descripción: "Colores nuevos, para presentación sábado"

## Sincronización

```
Bot Telegram → Supabase → Google Calendar → iCloud Sync → Apple Calendar
```

**Latencia:**
- Bot responde: ~3 segundos
- Google Calendar actualiza: ~5 segundos
- Apple Calendar sincroniza: ~1 minuto

## Recordatorios

Cada 30 minutos, el bot revisa:
- Tareas con fecha vencida
- Tareas no completadas
- Te envía recordatorio por Telegram

### Cron job

```javascript
cron.schedule('*/30 * * * *', async () => {
  // Revisa tareas vencidas
  // Envía recordatorio
});
```

## Datos guardados en Supabase

```
Tabla: tareas
├── id (UUID)
├── titulo (TEXT)
├── descripcion (TEXT)
├── prioridad (TEXT: ALTA/MEDIA/BAJA)
├── fecha_vencimiento (TIMESTAMP)
├── completada (BOOLEAN)
├── chat_id (INTEGER) - Tu ID de Telegram
├── google_event_id (TEXT) - Link a Google Calendar
└── creada_en (TIMESTAMP)
```

## Seguridad

- ✅ Las claves están en variables de entorno (no en código)
- ✅ Supabase solo acepta tu chat_id (solo tú ves tus tareas)
- ✅ Google Calendar está autorizado vía OAuth
- ✅ Vercel es serverless (sin máquina encendida)

## Troubleshooting

**El bot no responde**
1. Verifica que el webhook está configurado: `https://api.telegram.org/botTOKEN/getWebhookInfo`
2. Verifica las variables de entorno en Vercel

**No aparece en Google Calendar**
1. Comprueba que tienes GOOGLE_REFRESH_TOKEN configurado
2. Intenta autorizar de nuevo: `https://tu-vercel-url.vercel.app/oauth/start`

**Los recordatorios no llegan**
1. El cron se ejecuta cada 30 minutos
2. Verifica que Vercel está activo (debería estarlo siempre)

## Limitaciones

- Solo funciona con tareas (no eventos puntuales sin fecha)
- Google Calendar sync a Apple: hasta 1 minuto de latencia
- Recordatorios cada 30 minutos (configurable)

## Mejoras futuras

- [ ] Marcar tareas como completadas desde Telegram
- [ ] Filtros por prioridad
- [ ] Integración con Reminders nativa de iOS
- [ ] Dashboard web visual

## Créditos

- **Bot**: Node.js + Express
- **IA**: Claude 3.5 Sonnet
- **BD**: Supabase (PostgreSQL)
- **Calendario**: Google Calendar API
- **Hosting**: Vercel

---

**¿Dudas?** Lee `DEPLOYMENT.md` paso a paso. Es muy sencillo. 🚀
