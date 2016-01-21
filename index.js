var bitgo = null // require('bitgo')
var http = require('http')
var https = require('https')
var querystring = require('querystring')
var underscore = require('underscore')
var url = require('url')
var util = require('util')
var webcrypto = require('./msrcrypto.min.js')

var Client = function (options, state, callback) {
  if (!(this instanceof Client)) return new Client(options, state, callback)

  var self = this

  self.options = underscore.defaults(options || {}, { server: 'https://vault-staging.brave.com', verboseP: false })
  self.state = state || {}
  self.runtime = {}

  if ((typeof state === 'string') && (!self.url2state(callback))) return

  if (self.state.masterKey) {
    if (self.state.server) self.options.server = self.state.server

    webcrypto.subtle.importKey('jwk', self.state.masterKey, { name: 'AES-GCM' }, true, [ 'encrypt', 'decrypt' ]).then(
      function (masterKey) {
        self.runtime.masterKey = masterKey

        webcrypto.subtle.importKey('jwk', self.state.privateKey, { name: 'ECDSA', namedCurve: 'P-256' }, true, [ 'sign' ]).then(
          function (privateKey) {
            self.runtime.pair = { privateKey: privateKey }

            callback(null, typeof state !== 'string' ? undefined : self.state)
          }
        )
      }
    )

    return
  }

  webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [ 'encrypt', 'decrypt', 'wrapKey', 'unwrapKey' ]).then(
    function (masterKey) {
      self.runtime.masterKey = masterKey

      webcrypto.subtle.exportKey('raw', self.runtime.masterKey).then(
        function (exportKey) {
          var keychain = bitgo ? new (bitgo).BitGo({ env: 'prod' }).keychains().create() : null

          self.state = { userId: uuid(), sessionId: uuid(), masterKey: exportKey }
          if (keychain) underscore.extend(self.state, { xpub: keychain.xpub, xprv: keychain.xprv })
          webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [ 'sign', 'verify' ]).then(
            function (pair) {
              self.runtime.pair = pair

              webcrypto.subtle.exportKey('jwk', self.runtime.pair.privateKey).then(
                function (privateKey) {
                  self.state.privateKey = privateKey

                  webcrypto.subtle.exportKey('jwk', self.runtime.pair.publicKey).then(
                    function (publicKey) {
                      var iv = webcrypto.getRandomValues(new Uint8Array(12))
                      var payload = { version: 1,
                                      /* note that the publicKey is not sent as an x/y pair,
                                         but instead is a concatenation (the 0x04 prefix indicates this)
                                       */
                                      publicKey: '04' +
                                                 new Buffer(publicKey.x, 'base64').toString('hex') +
                                                 new Buffer(publicKey.y, 'base64').toString('hex'),
                                      xpub: self.state.xpub
                                    }

                      self.state.server = self.options.server

                      webcrypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, self.runtime.masterKey,
                                               obj2ab(self.state.privateKey)).then(
                        function (ciphertext) {
                          payload.privateKey = { encryptedData: ab2hex(ciphertext), iv: ab2hex(iv) }
                          try {
                            self.signedtrip({ method: 'PUT', path: '/v1/users/' + self.state.userId }, payload,
                              function (err, response) {
                                if ((!err) && (response.statusCode !== 201)) {
                                  err = new Error('HTTP response ' + response.statusCode)
                                }
                                callback(err, err ? undefined : self.state)
                              }
                            )
                          } catch (err) {
                            callback(err)
                          }
                        }
                      )
                    }
                  )
                }
              )
            }
          )
        }
      )
    }
  )
}

Client.prototype.read = function (options, callback) {
  var self = this

  var path, uuid

  if (options.sessionId === true) options.sessionid = self.state.sessionId
  if (options.sessionId) {
    uuid = options.sessionId.split('-').join('')
    if ((uuid.length !== 32) || (uuid.substr(12, 1) !== '4')) {
      return self.oops(new Error('invalid sessionId: ' + options.sessionId), callback)
    }

    if (!options.type) return self.oops(new Error('missing type for sessionId: ' + options.sessionId), callback)
  } else if (options.type) return self.oops(new Error('missing sessionId for type: ' + options.type), callback)

  path = '/v1/users/' + self.state.userId
  if (options.sessionId) path += '/sessions/' + options.sessionId + '/types/' + options.type

  self.roundtrip({ path: path, method: 'GET' }, function (err, response, payload) {
    var ciphertext, inner, outer, result

    if (err) return callback(err)

    outer = payload.payload
    if (!options.sessionId) outer = outer && outer.state
    inner = outer && outer.payload
    if (!inner) return callback(null, {})

    result = { object1: underscore.omit(inner, 'encryptedData', 'iv') }

    ciphertext = underscore.pick(inner, 'encryptedData', 'iv')
    if (underscore.keys(ciphertext).length === 0) return callback(null, result)

    webcrypto.subtle.decrypt({ name: 'AES-GCM',
                               iv: hex2ab(ciphertext.iv)
                             }, self.runtime.masterKey, hex2ab(ciphertext.encryptedData)).then(
      function (plaintext) {
        try { result.object2 = ab2obj(plaintext) } catch (err) { result.err = err }

        callback(null, result)
      }
    )
  })
}

Client.prototype.list = function (options, callback) {
  var self = this

  var path, uuid

  if (options.sessionId === true) options.sessionid = self.state.sessionId
  if (options.sessionId) {
    uuid = options.sessionId.split('-').join('')
    if ((uuid.length !== 32) || (uuid.substr(12, 1) !== '4')) {
      return self.oops(new Error('invalid sessionId: ' + options.sessionId), callback)
    }
  }

  path = '/v1/users/' + self.state.userId + '/sessions'
  if (options.sessionId) {
    path += '/' + options.sessionId + '/types'
    if (options.type) path += '/' + options.type
  }

  self.roundtrip({ path: path, method: 'GET' }, function (err, response, payload) {
    var count, inner, results

    var next = function (entry, result) {
      if (entry) results.push(underscore.extend({ sessionId: entry.sessionId, type: entry.type }, result))

      if (--count <= 0) callback(null, results)
    }

    var process = function (entry) {
      var ciphertext, result
      var inner = entry.payload

      if (((options.session) && (options.session !== entry.sessionId)) || ((options.type) && (options.type !== entry.type))) {
        return next()
      }

      result = { object1: underscore.omit(inner, 'encryptedData', 'iv') }

      ciphertext = underscore.pick(inner, 'encryptedData', 'iv')
      if (underscore.keys(ciphertext).length === 0) return next(entry, result)

      webcrypto.subtle.decrypt({ name: 'AES-GCM',
                                 iv: hex2ab(ciphertext.iv)
                               }, self.runtime.masterKey, hex2ab(ciphertext.encryptedData)).then(
        function (plaintext) {
          try { result.object2 = ab2obj(plaintext) } catch (err) { result.err = err }

          next(entry, result)
        }
      )
    }

    if (err) return self.oops(err, callback)

    inner = payload.payload
    if (!util.isArray(inner)) return self.oops(new Error('invalid response from server'), callback)

    results = []
    count = inner.length
    if (count === 0) return callback(null, results)

    inner.forEach(process)
  })
}

Client.prototype.write = function (options, object1, object2, callback) {
  var self = this

  var iv, path, uuid

  if (options.sessionId === true) options.sessionid = self.state.sessionId
  if (options.sessionId) {
    uuid = options.sessionId.split('-').join('')
    if ((uuid.length !== 32) || (uuid.substr(12, 1) !== '4')) {
      return self.oops(new Error('invalid sessionId: ' + options.sessionId), callback)
    }

    if (!options.type) return self.oops(new Error('missing type for sessionId: ' + options.sessionId), callback)
  } else if (options.type) return self.oops(new Error('missing sessionId for type: ' + options.type), callback)

  path = '/v1/users/' + self.state.userId
  if (options.sessionId) path += '/sessions/' + options.sessionId + '/types/' + options.type

  iv = webcrypto.getRandomValues(new Uint8Array(12))
  webcrypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, self.runtime.masterKey, obj2ab(object2 || {})).then(
    function (ciphertext) {
      var payload = underscore.defaults({ encryptedData: ab2hex(ciphertext), iv: ab2hex(iv) }, object1 || {})

      try {
        self.signedtrip({ method: 'PUT', path: path }, payload, function (err) { callback(err) })
      } catch (err) {
        callback(err)
      }
    }
  )
}

Client.prototype.remove = function (options, callback) {
  var self = this

  var path
  var payload = ab2hex(webcrypto.getRandomValues(new Uint8Array(12)))

  if (options.sessionId === true) options.sessionid = self.state.sessionId
  if (options.sessionId) {
    uuid = options.sessionId.split('-').join('')
    if ((uuid.length !== 32) || (uuid.substr(12, 1) !== '4')) {
      return self.oops(new Error('invalid sessionId: ' + options.sessionId), callback)
    }

    if (!options.type) return self.oops(new Error('missing type for sessionId: ' + options.sessionId), callback)
  } else if (options.type) return self.oops(new Error('missing sessionId for type: ' + options.type), callback)

  path = '/v1/users/' + self.state.userId
  if (options.sessionId) path += '/sessions/' + options.sessionId + '/types/' + options.type

  self.signedtrip({ method: 'DELETE', path: path }, payload, function (err) { callback(err) })
}

Client.prototype.qrcodeURL = function (options, callback) {
  var self = this

  var p = 'persona://' + self.state.server.host + '/v1/' + self.state.userId +
              '?m=' + encodeURIComponent(JSON.stringify(self.state.masterKey)) +
              '&p=' + encodeURIComponent(JSON.stringify(self.state.privateKey))

  setTimeout(function () {
    try { callback.bind(self)(null, p) } catch (err0) { if (self.options.verboseP) console.log('oops: ' + err0.toString()) }
  }, 0)
}

/*
 *
 * internal functions
 *
 */

/*
 *
 * signed roundtrip to the vault
 *
 * the pattern here is the same for all POSTs/PUTs to the vault:
 *  - generate a nonce
 *  - generate the string to be hashed and then convert to an array buffer
 *  - generate a signature
 *  - fill-in the message
 *  - round-trip to the vault
 *
 * although sending an HTTP body with DELETE is allowed, it may be sent as a query parameter
 * (as some browsers may not be that clueful)
 */

Client.prototype.signedtrip = function (options, payload, callback) {
  var self = this

  var nonce = (new Date().getTime() / 1000.0).toString()
  var combo = JSON.stringify({ userId: self.state.userId, nonce: nonce, payload: payload })

  webcrypto.subtle.sign({ name: 'ECDSA', namedCurve: 'P-256', hash: { name: 'SHA-256' } },
                        self.runtime.pair.privateKey, str2ab(combo)).then(
    function (signature) {
      var message = { header: { signature: ab2hex(signature), nonce: nonce }, payload: payload }

      options.headers = { 'Content-Type': 'application/json' }
      if (options.method === 'DELETE') {
        options.path += '?' + querystring.stringify({ message: JSON.stringify(message) })
      } else {
        options.payload = message
      }
      self.roundtrip(options, callback)
    }
  )
}

// roundtrip to the vault
Client.prototype.roundtrip = function (options, callback) {
  var self = this

  var request
  var client = self.options.server.protocol === 'https:' ? https : http

  options = underscore.extend(underscore.pick(self.options.server, 'protocol', 'hostname', 'port'), options)

  request = client.request(underscore.omit(options, 'payload'), function (response) {
    var body = ''

    response.on('data', function (chunk) {
      body += chunk.toString()
    }).on('end', function () {
      var payload

      if (self.options.verboseP) {
        console.log('>>> HTTP/' + response.httpVersionMajor + '.' + response.httpVersionMinor + ' ' + response.statusCode +
                   ' ' + (response.statusMessage || ''))
      }
      if (Math.floor(response.statusCode / 100) !== 2) return callback(new Error('HTTP response ' + response.statusCode))

      try {
        payload = (response.statusCode !== 204) ? JSON.parse(body) : null
      } catch (err) {
        return callback(err)
      }
      if (self.options.verboseP) console.log('>>> ' + JSON.stringify(payload, null, 2).split('\n').join('\n>>> '))

      try {
        callback(null, response, payload)
      } catch (err0) {
        if (self.options.verboseP) console.log('callback: ' + err0.toString())
      }
    }).setEncoding('utf8')
  }).on('error', function (err) {
    callback(err)
  })
  if (options.payload) request.write(JSON.stringify(options.payload))
  request.end()

  if (!self.options.verboseP) return

  console.log('<<< ' + options.method + ' ' + options.path)
  if (options.payload) console.log('<<< ' + JSON.stringify(options.payload, null, 2).split('\n').join('\n<<< '))
}

Client.prototype.url2state = function (callback) {
  var self = this

  var path
  var parts = url.parse(self.state)
  var query = querystring.parse(parts.query)
  var userId

  if (parts.protocol !== 'persona:') return self.oops(new Error('invalid URI scheme for persona: ' + parts.protocol), callback)
  path = parts.pathname.split('/')
  if ((path.length !== 3) || (path[0] !== '')) {
    return self.oops(new Error('invalid pathname for persona: ' + parts.partname), callback)
  }
  if (path[1] !== 'v1') return self.oops(new Error('invalid version for persona: ' + path[1]), callback)
  userId = path[2].split('-').join('')
  if ((userId.length !== 32) || (userId.substr(12, 1) !== '4')) {
    return self.oops(new Error('invalid userID for persona: ' + path[2]), callback)
  }

  try {
    query.m = JSON.parse(query.m)
    query.p = JSON.parse(query.p)
  } catch (err) {
    return self.oops(new Error('invalid persona URL parameters: ' + parts.query), callback)
  }

  self.state = { userId: path[2],
                 sessionId: uuid(),
                 masterKey: query.m,
                 privateKey: query.p,
                 server: underscore.extend(parts,
                                           { protocol: parts.hostname !== '127.0.0.1' ? 'https:' : 'http:',
                                             slashes: true,
                                             hash: null,
                                             search: null,
                                             query: null,
                                             pathname: '/',
                                             path: '/'
                                            })
               }
  self.state.server.href = self.state.server.protocol + '//' + self.state.server.host + self.state.server.path

  return true
}

Client.prototype.oops = function (err, callback) {
  var self = this

  setTimeout(function () {
    try { callback.bind(self)(err) } catch (err0) { if (self.options.verboseP) console.log('oops: ' + err0.toString()) }
  }, 0)
}

/*
 *
 * utility functions
 *
 */

// courtesy of http://stackoverflow.com/questions/105034/create-guid-uuid-in-javascript#2117523
var uuid = function () {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    var r = webcrypto.getRandomValues(new Uint8Array(1))[0] % 16 | 0
    var v = c === 'x' ? r : (r & 0x3 | 0x8)

    return v.toString(16).toUpperCase()
  })
}

// convert a string to an array of unsigned octets
var str2ab = function (s) {
  var buffer = new Uint8Array(s.length)

  for (var i = 0; i < s.length; i++) buffer[i] = s.charCodeAt(i)
  return buffer
}

var obj2ab = function (o) {
  return str2ab(JSON.stringify(o))
}

// convert an array buffer to a utf8 string
var ab2obj = function (ab) {
  var buffer = []
  var view = new Uint8Array(ab)

  for (var i = 0; i < ab.byteLength; i++) buffer[i] = view[i]
  return JSON.parse(new Buffer(buffer).toString('utf8'))
}

// convert a hex string to an array buffer
var hex2ab = function (s) {
  if (typeof s !== 'string') return

  return new Uint8Array(new Buffer(s, 'hex'))
}

// convert an array buffer to a hex string, not base64 (MTR is so old-school, he's pre-historic!)
var ab2hex = function (ab) {
  var buffer = []
  var view = new Uint8Array(ab)

  for (var i = 0; i < ab.byteLength; i++) buffer[i] = view[i]
  return new Buffer(buffer).toString('hex')
}

module.exports = Client
