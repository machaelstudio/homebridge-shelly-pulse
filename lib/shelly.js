'use strict';

// Talks to one relay channel of a Shelly Gen 2 or newer device (Plus, Pro,
// Gen3, Gen4) over the device's local HTTP RPC API.

const http = require('node:http');
const crypto = require('node:crypto');

class ShellyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ShellyError';
  }
}

function httpGet(host, path, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(`http://${host}${path}`);
    } catch {
      reject(new ShellyError(`"${host}" is not a valid address`));
      return;
    }

    let timer = null;
    const fail = (err) => {
      clearTimeout(timer);
      reject(err instanceof ShellyError ? err : new ShellyError(`cannot reach ${host} (${err.message})`));
    };

    const req = http.request(
      {
        hostname: url.hostname.replace(/^\[|\]$/g, ''),
        port: url.port || 80,
        path: url.pathname + url.search,
        method: 'GET',
        headers,
        // A fresh connection per request: the device drops idle connections,
        // and a reused one would fail on the next command.
        agent: false,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('error', fail);
        res.on('end', () => {
          clearTimeout(timer);
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', fail);
    timer = setTimeout(() => {
      req.destroy(new ShellyError(`no answer from ${host} within ${timeoutMs} ms`));
    }, timeoutMs);
    req.end();
  });
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Reads `Digest qop="auth", realm="shelly1g4-…", nonce="…", algorithm=SHA-256`.
function parseChallenge(header) {
  if (typeof header !== 'string' || !/^\s*Digest\s/i.test(header)) {
    return null;
  }
  const fields = {};
  const pattern = /(\w+)=(?:"([^"]*)"|([^\s,]+))/g;
  let match;
  while ((match = pattern.exec(header)) !== null) {
    fields[match[1].toLowerCase()] = match[2] !== undefined ? match[2] : match[3];
  }
  return fields.realm && fields.nonce ? fields : null;
}

function digestAuthorization(challenge, password, path, count) {
  const algorithm = challenge.algorithm || 'SHA-256';
  const hashName = algorithm.toUpperCase() === 'MD5' ? 'md5' : 'sha256';
  const hash = (text) => crypto.createHash(hashName).update(text).digest('hex');
  const username = 'admin'; // the only user a Shelly has
  const nc = count.toString(16).padStart(8, '0');
  const cnonce = crypto.randomBytes(8).toString('hex');
  const ha1 = hash(`${username}:${challenge.realm}:${password}`);
  const ha2 = hash(`GET:${path}`);
  const response = hash(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:auth:${ha2}`);
  return (
    `Digest username="${username}", realm="${challenge.realm}", nonce="${challenge.nonce}", ` +
    `uri="${path}", algorithm=${algorithm}, qop=auth, nc=${nc}, cnonce="${cnonce}", response="${response}"`
  );
}

class ShellyRelay {
  constructor({ host, channel = 0, password = '', timeoutMs = 2500 }) {
    this.host = host;
    this.channel = channel;
    this.password = password;
    this.timeoutMs = timeoutMs;
    this.device = null;
    this.challenge = null;
    this.requestCount = 0;
  }

  // Who is at this address. Asked once, then remembered.
  async identify() {
    if (this.device) {
      return this.device;
    }
    const res = await httpGet(this.host, '/shelly', {}, this.timeoutMs);
    const info = parseJson(res.body);
    if (res.status !== 200 || !info || typeof info !== 'object') {
      throw new ShellyError(`${this.host} does not answer like a Shelly device`);
    }
    if (!(Number(info.gen) >= 2)) {
      throw new ShellyError(`${this.host} is a first-generation Shelly, which this plugin does not support`);
    }
    this.device = {
      id: String(info.id || this.host),
      mac: String(info.mac || ''),
      model: String(info.app || info.model || 'Shelly'),
      generation: Number(info.gen),
      firmware: String(info.ver || ''),
    };
    return this.device;
  }

  authHeaders(path) {
    if (!this.password || !this.challenge) {
      return {};
    }
    this.requestCount += 1;
    return { Authorization: digestAuthorization(this.challenge, this.password, path, this.requestCount) };
  }

  async rpc(method, params) {
    await this.identify();
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      query.set(key, String(value));
    }
    const path = `/rpc/${method}?${query}`;

    let res = await httpGet(this.host, path, this.authHeaders(path), this.timeoutMs);
    if (res.status === 401 && this.password) {
      // First request, or the device retired the challenge we were using.
      const challenge = parseChallenge(res.headers['www-authenticate']);
      if (challenge) {
        this.challenge = challenge;
        this.requestCount = 0;
        res = await httpGet(this.host, path, this.authHeaders(path), this.timeoutMs);
      }
    }
    if (res.status === 401) {
      throw new ShellyError(
        this.password
          ? `${this.host} rejected the password`
          : `${this.host} is password protected: add its password in the plugin settings`,
      );
    }

    const body = parseJson(res.body);
    if (res.status !== 200 || !body || typeof body !== 'object') {
      const reason = body && body.message ? body.message : `HTTP ${res.status}`;
      throw new ShellyError(`${this.host} refused ${method} (${reason})`);
    }
    return body;
  }

  // Switches the relay. With `flipBackSeconds`, the Shelly itself reverses the
  // relay after that time, so it is released even if Homebridge stops.
  async set(on, flipBackSeconds = 0) {
    const params = { id: this.channel, on: Boolean(on) };
    if (flipBackSeconds > 0) {
      params.toggle_after = flipBackSeconds;
    }
    await this.rpc('Switch.Set', params);
  }

  async isOn() {
    const status = await this.rpc('Switch.GetStatus', { id: this.channel });
    if (typeof status.output !== 'boolean') {
      throw new ShellyError(`${this.host} sent a relay status without an "output" value`);
    }
    return status.output;
  }
}

module.exports = { ShellyRelay, ShellyError };
