const { 
  default: makeWASocket, 
  useMultiFileAuthState, 
  DisconnectReason,
  makeInMemoryStore,
  fetchLatestBaileysVersion 
} = require('@whiskeysockets/baileys')
const { Boom } = require('@hapi/boom')
const qrcode = require('qrcode-terminal')
const express = require('express')
const fs = require('fs')
const path = require('path')
require('dotenv').config()

const app = express()
const PORT = process.env.PORT || 3000

// Middleware
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// Store for messages
const store = makeInMemoryStore({})
const authFolder = './auth_info'

// Routes
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>WhatsApp Bot</title>
      <style>
        body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
        .status { padding: 20px; background: #f0f0f0; border-radius: 10px; margin: 20px auto; max-width: 500px; }
      </style>
    </head>
    <body>
      <h1>🤖 WhatsApp Bot</h1>
      <div class="status">
        <p>Status: <strong>Running</strong></p>
        <p>Port: ${PORT}</p>
        <p>Check console/terminal for QR code</p>
      </div>
      <p><a href="/qr">View QR Code</a> | <a href="/health">Health Check</a></p>
    </body>
    </html>
  `)
})

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'whatsapp-bot',
    uptime: process.uptime()
  })
})

app.get('/qr', (req, res) => {
  res.send(`
    <html>
    <body style="text-align:center; padding:50px;">
      <h1>QR Code</h1>
      <p>Check your Railway logs/console for QR code</p>
      <p>Look for "SCAN THIS QR CODE" in logs</p>
    </body>
    </html>
  `)
})

app.get('/restart', (req, res) => {
  if (req.query.secret === process.env.RESTART_SECRET) {
    res.send('Restarting bot...')
    process.exit(0) // Railway will automatically restart
  } else {
    res.status(403).send('Unauthorized')
  }
})

// Store QR for web display (optional)
let currentQR = null
app.get('/qrcode', (req, res) => {
  if (currentQR) {
    res.send(`
      <html>
      <body style="text-align:center;">
        <h1>Scan QR Code</h1>
        <pre>${currentQR}</pre>
      </body>
      </html>
    `)
  } else {
    res.send('No QR code available. Check logs.')
  }
})

// Start server
const server = app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`)
  console.log(`🌐 Web interface: http://localhost:${PORT}`)
})

// Bot initialization
let sock = null
let isConnected = false

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(authFolder)
  
  const { version } = await fetchLatestBaileysVersion()
  
  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true,
    browser: ['Railway-Bot', 'Chrome', '3.0'],
    markOnlineOnConnect: true,
    generateHighQualityLinkPreview: true,
    emitOwnEvents: true,
    defaultQueryTimeoutMs: 60000
  })

  store.bind(sock.ev)

  // Save credentials
  sock.ev.on('creds.update', saveCreds)

  // Handle connection updates
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update
    
    if (qr) {
      console.log('===== SCAN THIS QR CODE =====')
      qrcode.generate(qr, { small: true })
      console.log('=============================')
      currentQR = qr
    }

    if (connection === 'open') {
      console.log('✅ WhatsApp connected successfully!')
      console.log(`👤 User: ${sock.user?.name || 'Unknown'}`)
      console.log(`📱 ID: ${sock.user?.id}`)
      isConnected = true
      
      // Send welcome message to yourself
      const selfJid = sock.user.id
      sock.sendMessage(selfJid, { 
        text: `🤖 *Bot Online*\n\n` +
              `✅ Connected from Railway\n` +
              `🕒 ${new Date().toLocaleString()}\n` +
              `🌐 Port: ${PORT}`
      })
    }

    if (connection === 'close') {
      console.log('❌ Connection closed')
      isConnected = false
      const statusCode = lastDisconnect?.error?.output?.statusCode
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut
      
      console.log(`Last disconnect: ${JSON.stringify(lastDisconnect?.error, null, 2)}`)
      
      if (shouldReconnect) {
        console.log('🔄 Reconnecting in 5 seconds...')
        setTimeout(connectToWhatsApp, 5000)
      } else {
        console.log('⚠️ Logged out. Please delete auth_info folder and rescan QR.')
      }
    }
  })

  // Handle incoming messages
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return

    const msg = messages[0]
    if (!msg.message || msg.key.fromMe) return

    const sender = msg.key.remoteJid
    const messageText = msg.message?.conversation || 
                       msg.message?.extendedTextMessage?.text || 
                       msg.message?.imageMessage?.caption || ''

    console.log(`📨 [${new Date().toLocaleTimeString()}] Message from ${sender}: ${messageText}`)

    // Command handler
    const command = messageText.toLowerCase().trim()
    const args = messageText.split(' ').slice(1)
    const prefix = '!'

    if (command.startsWith(prefix)) {
      const cmd = command.slice(prefix.length).split(' ')[0]
      
      switch(cmd) {
        case 'ping':
          await sock.sendMessage(sender, { text: '🏓 Pong!' })
          break
          
        case 'help':
          const helpText = `*🤖 Bot Commands*\n\n` +
                          `• \`!ping\` - Test connection\n` +
                          `• \`!time\` - Current time\n` +
                          `• \`!info\` - Bot information\n` +
                          `• \`!status\` - Check bot status\n` +
                          `• \`!echo [text]\` - Repeat text\n` +
                          `• \`!help\` - Show this menu`
          await sock.sendMessage(sender, { text: helpText })
          break
          
        case 'time':
          await sock.sendMessage(sender, { 
            text: `⏰ *Current Time*\n${new Date().toLocaleString()}`
          })
          break
          
        case 'info':
          await sock.sendMessage(sender, {
            text: `*Bot Information*\n\n` +
                  `• Platform: Railway.app\n` +
                  `• Library: Baileys\n` +
                  `• Uptime: ${Math.floor(process.uptime())}s\n` +
                  `• Connected: ${isConnected ? 'Yes' : 'No'}\n` +
                  `• User: ${sock.user?.name || 'N/A'}`
          })
          break
          
        case 'status':
          await sock.sendMessage(sender, {
            text: `📊 *Status*\n\n` +
                  `• Connection: ${isConnected ? '✅ Connected' : '❌ Disconnected'}\n` +
                  `• Memory: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)} MB\n` +
                  `• Platform: ${process.platform}\n` +
                  `• Port: ${PORT}`
          })
          break
          
        case 'echo':
          if (args.length > 0) {
            await sock.sendMessage(sender, { text: args.join(' ') })
          } else {
            await sock.sendMessage(sender, { text: 'Usage: !echo [message]' })
          }
          break
          
        default:
          await sock.sendMessage(sender, { 
            text: `Unknown command. Type \`!help\` for available commands.`
          })
      }
    }
  })

  // Handle other events
  sock.ev.on('messages.update', (updates) => {
    for (const update of updates) {
      if (update.update.messageStubType === 2) {
        console.log('📱 User is typing...')
      }
    }
  })
}

// Start bot
connectToWhatsApp().catch(console.error)

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...')
  server.close(() => {
    console.log('HTTP server closed')
    process.exit(0)
  })
})
