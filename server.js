'use strict'

/**
 * Serveur de mises a jour d'OptiMail.
 *
 * Deux roles, et deux seulement :
 *   - servir les fichiers de mise a jour a l'application installee (lecture
 *     publique : un installeur n'est pas un secret, et l'application doit
 *     pouvoir l'atteindre sans identifiants) ;
 *   - accepter le depot d'une nouvelle version, protege par un jeton.
 *
 * Sans dependance : le module `http` de Node suffit largement pour deux routes,
 * et chaque paquet en moins est une surface d'attaque en moins sur une machine
 * exposee a Internet.
 */

const http = require('node:http')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')

const PORT = Number(process.env.PORT || 3000)
const DATA_DIR = process.env.DATA_DIR || '/data'
const UPLOAD_TOKEN = process.env.UPLOAD_TOKEN || ''

/** Un installeur Electron pese une centaine de megaoctets ; 500 laisse de la marge. */
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024

/**
 * Seuls ces fichiers ont un sens ici. Tout le reste est refuse : sans cette
 * liste, le service deviendrait un hebergeur de fichiers quelconque, donc une
 * cible.
 */
const ALLOWED = new Map([
  ['.exe', 'application/octet-stream'],
  ['.yml', 'text/yaml; charset=utf-8'],
  ['.blockmap', 'application/octet-stream']
])

fs.mkdirSync(DATA_DIR, { recursive: true })

if (!UPLOAD_TOKEN) {
  console.error('[optimail-updates] UPLOAD_TOKEN absent : les depots seront tous refuses')
}

/**
 * Valide un nom de fichier venu du reseau.
 *
 * `path.basename` seul ne suffit pas : on verifie aussi qu'aucun separateur ne
 * subsiste, pour qu'un `..%2Fetc%2Fpasswd` ne puisse pas sortir du dossier.
 */
function safeName(raw) {
  let decoded
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    return null
  }
  if (decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0')) return null
  const name = path.basename(decoded)
  if (!name || name.startsWith('.')) return null
  if (!ALLOWED.has(path.extname(name).toLowerCase())) return null
  return name
}

/** Comparaison a duree constante : une egalite naive fuit le jeton, octet par octet. */
function tokenMatches(header) {
  if (!UPLOAD_TOKEN) return false
  const provided = String(header || '').replace(/^Bearer\s+/i, '')
  const a = Buffer.from(provided)
  const b = Buffer.from(UPLOAD_TOKEN)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers })
  res.end(body)
}

/**
 * Interprete un en-tete `Range` simple : `bytes=<debut>-<fin>`.
 *
 * Volontairement limite a une seule plage. Les plages multiples sont permises
 * par la norme mais aucun client de mise a jour ne les emploie, et les
 * accepter a moitie serait pire que les refuser franchement.
 */
function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim())
  if (!match) return null

  const [, rawStart, rawEnd] = match
  let start
  let end
  if (rawStart === '') {
    // `bytes=-500` : les 500 derniers octets.
    if (rawEnd === '') return null
    const length = Number(rawEnd)
    if (!Number.isFinite(length) || length <= 0) return null
    start = Math.max(0, size - length)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Number(rawEnd)
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  if (start > end || start < 0 || start >= size) return null
  return { start, end: Math.min(end, size - 1) }
}

async function handleDownload(req, res, name) {
  const file = path.join(DATA_DIR, name)
  let stat
  try {
    stat = await fsp.stat(file)
  } catch {
    return send(res, 404, 'introuvable\n')
  }

  const headers = {
    'content-type': ALLOWED.get(path.extname(name).toLowerCase()),
    // Le fichier d'index change a chaque publication ; les installeurs, jamais.
    'cache-control': name.endsWith('.yml') ? 'no-cache' : 'public, max-age=86400',
    // Sans cette annonce, un client ne tenterait meme pas de reprise.
    'accept-ranges': 'bytes'
  }

  /**
   * Requete partielle.
   *
   * electron-updater ne retelecharge pas cent megaoctets quand il possede deja
   * une version voisine : il compare les empreintes de blocs et ne demande que
   * les portions modifiees. Repondre le fichier entier a une telle demande lui
   * fait recoller des morceaux incoherents, et la verification d'integrite
   * echoue — sans que rien n'indique d'ou vient le probleme.
   */
  const range = req.headers.range ? parseRange(req.headers.range, stat.size) : null

  if (req.headers.range && !range) {
    res.writeHead(416, { 'content-range': `bytes */${stat.size}` })
    return res.end()
  }

  if (range) {
    const length = range.end - range.start + 1
    res.writeHead(206, {
      ...headers,
      'content-length': String(length),
      'content-range': `bytes ${range.start}-${range.end}/${stat.size}`
    })
    if (req.method === 'HEAD') return res.end()
    return void fs.createReadStream(file, { start: range.start, end: range.end }).pipe(res)
  }

  res.writeHead(200, { ...headers, 'content-length': String(stat.size) })
  if (req.method === 'HEAD') return res.end()
  fs.createReadStream(file).pipe(res)
}

async function handleUpload(req, res, name) {
  if (!tokenMatches(req.headers.authorization)) return send(res, 401, 'jeton invalide\n')

  // Ecriture sous un nom temporaire puis renommage : un depot interrompu ne
  // laisse jamais un installeur tronque a la place du bon.
  const target = path.join(DATA_DIR, name)
  const temporary = `${target}.part`
  const stream = fs.createWriteStream(temporary)
  let received = 0
  let aborted = false

  const abort = (status, message) => {
    if (aborted) return
    aborted = true
    stream.destroy()
    void fsp.rm(temporary, { force: true })
    send(res, status, message)
  }

  req.on('data', (chunk) => {
    received += chunk.length
    if (received > MAX_UPLOAD_BYTES) abort(413, 'fichier trop volumineux\n')
  })
  req.on('error', () => abort(400, 'transfert interrompu\n'))
  stream.on('error', () => abort(500, 'ecriture impossible\n'))

  req.pipe(stream)

  stream.on('finish', () => {
    if (aborted) return
    void fsp
      .rename(temporary, target)
      .then(() => {
        console.log(`[optimail-updates] publie : ${name} (${received} octets)`)
        send(res, 200, `${name} publie\n`)
      })
      .catch(() => abort(500, 'renommage impossible\n'))
  })
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://localhost')

  if (url.pathname === '/' || url.pathname === '/health') {
    return send(res, 200, 'OptiMail updates\n')
  }

  // Depot : PUT /publish/<nom de fichier>
  if (url.pathname.startsWith('/publish/')) {
    if (req.method !== 'PUT') return send(res, 405, 'methode non autorisee\n', { allow: 'PUT' })
    const name = safeName(url.pathname.slice('/publish/'.length))
    if (!name) return send(res, 400, 'nom de fichier refuse\n')
    return void handleUpload(req, res, name)
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, 'methode non autorisee\n', { allow: 'GET, HEAD' })
  }

  const name = safeName(url.pathname.slice(1))
  if (!name) return send(res, 404, 'introuvable\n')
  return void handleDownload(req, res, name)
})

server.listen(PORT, () => {
  console.log(`[optimail-updates] a l ecoute sur ${PORT}, fichiers dans ${DATA_DIR}`)
})
