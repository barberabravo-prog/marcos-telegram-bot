# ⚡ Próximos pasos (Guía rápida)

## Ya tienes:
✅ Token de Telegram
✅ Supabase (URL + KEY)
✅ El código del bot

## Necesitas hacer AHORA:

### 1️⃣ Claude API Key (2 min)
1. Ve a https://console.anthropic.com/account/keys
2. Copia tu key (o crea una nueva)
3. Guárdala

### 2️⃣ Google Cloud Console (10 min)
1. Ve a https://console.cloud.google.com
2. **Crea proyecto nuevo:**
   - Nombre: "Marcos Bot"
   - Click en crear

3. **Activa Google Calendar API:**
   - Búsqueda: "Google Calendar API"
   - Click en "Enable"

4. **Crea OAuth credentials:**
   - Menú izquierdo: "Credentials"
   - Click "Create Credentials" → "OAuth 2.0 Client ID"
   - Tipo: "Web application"
   - Authorized redirect URIs: `https://TU_VERCEL_URL/oauth/callback` (la conseguirás luego)
   - Copia `Client ID` y `Client Secret`

### 3️⃣ GitHub (5 min)
1. Ve a https://github.com/new
2. Nombre: `marcos-telegram-bot`
3. Crea el repositorio

4. En tu terminal:
```bash
cd ~/Desktop  # o donde quieras
mkdir marcos-bot && cd marcos-bot

# Copia aquí:
# - index.js (renombra de marcos-bot.js)
# - package.json
# - vercel.json
# - .env.example

git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/marcos-telegram-bot.git
git push -u origin main
```

### 4️⃣ Vercel (5 min)
1. Ve a https://vercel.com
2. Login con GitHub
3. Click "Add New..." → "Project"
4. Selecciona `marcos-telegram-bot`
5. Click "Deploy"

⏸️ **Espera a que termine el deploy**

Vercel te dará una URL: `https://marcos-telegram-bot-xxx.vercel.app`

### 5️⃣ Vuelve a Google Console
Ahora que tienes la URL de Vercel:
1. Ve de nuevo a Google Cloud Console
2. Credentials → OAuth Client
3. Edita y añade Authorized redirect URIs:
   `https://marcos-telegram-bot-xxx.vercel.app/oauth/callback`

### 6️⃣ Vercel Environment Variables (5 min)
En el dashboard de Vercel:
1. Proyecto → Settings → Environment Variables
2. Añade estas variables:

```
TELEGRAM_TOKEN
8775969770:AAE--O2af3aCKKY-83RPeGUUuHrembOemZ8

SUPABASE_URL
https://ozcflujcmoxegzavkdsk.supabase.co

SUPABASE_KEY
sb_publishable_au9QED5FyPJaKYGHiK6fyQ_9IdfLarY

CLAUDE_API_KEY
sk-ant-v4-... (copia de https://console.anthropic.com)

GOOGLE_CLIENT_ID
(copia de Google Console)

GOOGLE_CLIENT_SECRET
(copia de Google Console)

GOOGLE_REFRESH_TOKEN
(veremos en el siguiente paso)
```

3. Click "Save"
4. Ve a "Deployments" → Click el último → "Redeploy"

### 7️⃣ Autorizar Google Calendar (2 min)
1. Abre en navegador:
```
https://marcos-telegram-bot-xxx.vercel.app/oauth/start
```

2. Google te pide permisos → Autoriza
3. Te redirige a una página con `Refresh token:`
4. **COPIA ese refresh token**

### 8️⃣ Añade el Google Refresh Token a Vercel
1. Vercel → Settings → Environment Variables
2. Añade:
```
GOOGLE_REFRESH_TOKEN
(el que copiaste en el paso anterior)
```
3. Save y Redeploy

### 9️⃣ Conecta el webhook de Telegram (1 min)
Abre en navegador (reemplaza XXX por tu token):
```
https://api.telegram.org/bot8775969770:AAE--O2af3aCKKY-83RPeGUUuHrembOemZ8/setWebhook?url=https://marcos-telegram-bot-xxx.vercel.app/webhook/telegram
```

Deberías ver:
```json
{
  "ok": true,
  "result": true,
  "description": "Webhook was set"
}
```

### 🔟 ¡Prueba!
1. Abre Telegram
2. Busca tu bot (nombre que pusiste en @BotFather)
3. Escribe: `Llamar a cliente mañana a las 10`
4. Deberías recibir confirmación inmediatamente
5. Abre Google Calendar → deberías ver el evento creado
6. Abre Apple Calendar → se sincroniza automáticamente

---

## ¿Duda en algún paso?

Lee `DEPLOYMENT.md` que es más detallado.

## ✅ Checklist final

- [ ] Claude API Key obtenida
- [ ] Proyecto en Google Cloud creado
- [ ] Google Calendar API activada
- [ ] OAuth credentials creadas (Client ID + Secret)
- [ ] Repositorio en GitHub
- [ ] Deploy en Vercel (terminado)
- [ ] Variables de entorno en Vercel configuradas
- [ ] Google Refresh Token obtenido
- [ ] Google Refresh Token en Vercel
- [ ] Webhook de Telegram configurado
- [ ] Bot probado en Telegram

Si todo está ✅, **¡funcionará!**

Tiempo total: **30-45 minutos**

🚀
