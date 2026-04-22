# 🤖 Deployment en Vercel - Guía Paso a Paso

## Paso 1: Prepara el código

1. Crea una carpeta en tu máquina:
```bash
mkdir marcos-bot
cd marcos-bot
```

2. Copia estos archivos:
   - `index.js` (renombra de marcos-bot.js)
   - `package.json`

## Paso 2: Crea un repositorio en GitHub

1. Ve a https://github.com/new
2. Nombre: `marcos-telegram-bot`
3. Público o Privado (como prefieras)
4. Crea el repositorio

En tu terminal:
```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/marcos-telegram-bot.git
git push -u origin main
```

## Paso 3: Crea la app en Vercel

1. Ve a https://vercel.com
2. Haz login con GitHub
3. Clica "New Project"
4. Selecciona tu repo `marcos-telegram-bot`
5. Haz clic en "Deploy"

**Vercel te dará una URL:** `https://marcos-telegram-bot.vercel.app`

## Paso 4: Configura las variables de entorno en Vercel

En el dashboard de Vercel:
1. Ve a Settings → Environment Variables
2. Añade TODAS estas variables:

```
TELEGRAM_TOKEN = 8775969770:AAE--O2af3aCKKY-83RPeGUUuHrembOemZ8

SUPABASE_URL = https://ozcflujcmoxegzavkdsk.supabase.co

SUPABASE_KEY = sb_publishable_au9QED5FyPJaKYGHiK6fyQ_9IdfLarY

CLAUDE_API_KEY = sk-ant-v4-... (copia de https://console.anthropic.com)

GOOGLE_CLIENT_ID = (veremos en el siguiente paso)
GOOGLE_CLIENT_SECRET = (veremos en el siguiente paso)
GOOGLE_REFRESH_TOKEN = (veremos en el siguiente paso)
```

3. Haz clic en "Save"
4. Ve a Deployments → Redeploy para que use las nuevas variables

## Paso 5: Autoriza Google Calendar

1. Abre https://console.cloud.google.com
2. Crea un nuevo proyecto: "Marcos Bot"
3. Activa Google Calendar API
4. Ve a "OAuth 2.0 Client IDs"
5. Tipo: "Web application"
6. Authorized redirect URIs: `https://tu-vercel-url.vercel.app/oauth/callback`
7. Copia `Client ID` y `Client Secret`

Añade estos a Vercel (Environment Variables):
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`

## Paso 6: Obtén el Google Refresh Token

1. Abre en el navegador:
```
https://tu-vercel-url.vercel.app/oauth/start
```

2. Te redirigirá a Google
3. Autoriza el acceso a Google Calendar
4. Obtendrás un `refresh_token`
5. Cópialo y añádelo a Vercel:
   - `GOOGLE_REFRESH_TOKEN`
6. Redeploy en Vercel

## Paso 7: Conecta el webhook de Telegram

1. Abre en el navegador (reemplaza con tu URL):
```
https://api.telegram.org/bot8775969770:AAE--O2af3aCKKY-83RPeGUUuHrembOemZ8/setWebhook?url=https://marcos-telegram-bot.vercel.app/webhook/telegram
```

Deberías ver: `{"ok":true,"result":true,"description":"Webhook was set"}`

## Paso 8: Prueba el bot

1. Abre Telegram
2. Busca tu bot (name: @YourBotName)
3. Envía un mensaje: "Llamar a cliente mañana a las 10"
4. Deberías recibir:
   - ✅ Confirmación en Telegram
   - 📆 El evento se crea en Google Calendar
   - 🔄 Aparece en tu Apple Calendar (sincronización automática)

## Troubleshooting

**Si nada funciona:**
1. Ve a https://tu-vercel-url.vercel.app/status
   - Debe mostrar todos los servicios en ✅

**Si el webhook no funciona:**
1. Verifica el TOKEN en Telegram es correcto
2. Verifica la URL de Vercel es correcta
3. Comprueba que todas las env vars están configuradas

**Si Google Calendar no funciona:**
1. Verifica que completaste el paso 6 (OAuth callback)
2. Comprueba que el GOOGLE_REFRESH_TOKEN está configurado

## Variables de entorno completas (referencia)

```
TELEGRAM_TOKEN=tu_token
SUPABASE_URL=tu_url
SUPABASE_KEY=tu_key
CLAUDE_API_KEY=tu_key
GOOGLE_CLIENT_ID=tu_id
GOOGLE_CLIENT_SECRET=tu_secret
GOOGLE_REFRESH_TOKEN=tu_refresh_token
```

## ¿Duda sobre dónde obtener algo?

- TELEGRAM_TOKEN: Ya lo tienes ✅
- SUPABASE: Ya lo tienes ✅
- CLAUDE_API_KEY: https://console.anthropic.com/account/keys
- GOOGLE_*: https://console.cloud.google.com

¡Éxito! 🚀
