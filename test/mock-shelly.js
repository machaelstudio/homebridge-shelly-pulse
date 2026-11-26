'use strict';

// A stand-in for a Shelly 1 Gen4 on the local network: one relay, the HTTP RPC
// calls the plugin uses, the flip-back timer, and optional password protection.

const http = require('node:http');
const crypto = require('node:crypto');

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

function parseDigest(header) {
  const fields = {};
  const pattern = /(\w+)=(?:"([^"]*)"|([^\s,]+))/g;
  let match;
  while ((match = pattern.exec(header || '')) !== null) {
    fields[match[1]] = match[2] !== undefined ? match[2] : match[3];
  }
  return fields;
}

async function startMockShelly({ password = '', generation = 4, port = 0 } = {}) {
  const id = 'shelly1g4-aabbccddeeff';
  const mock = {
    output: false,
    requests: [], // every request path, in order
    lastSet: null, // the parameters of the last Switch.Set
    failNext: 0, // answer this many RPC calls with an error
    statusDelayMs: 0, // hold back Switch.GetStatus answers this long
  };
  let flipTimer = null;
  let nonce = crypto.randomBytes(8).toString('hex');
  let lastCount = 0;

  const authorised = (req) => {
    if (!password) {
      return true;
    }
    const auth = parseDigest(req.headers.authorization);
    if (auth.nonce !== nonce || auth.uri !== req.url || auth.username !== 'admin') {
      return false;
    }
    const count = parseInt(auth.nc, 16);
    if (!(count > lastCount)) {
      return false;
    }
    const ha1 = sha256(`admin:${id}:${password}`);
    const ha2 = sha256(`${req.method}:${auth.uri}`);
    const expected = sha256(`${ha1}:${auth.nonce}:${auth.nc}:${auth.cnonce}:${auth.qop}:${ha2}`);
    if (auth.response !== expected) {
      return false;
    }
    lastCount = count;
    return true;
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://mock');
    mock.requests.push(req.url);
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === '/shelly') {
      const info =
        generation >= 2
          ? { name: null, id, mac: 'AABBCCDDEEFF', model: 'S4SW-001X16EU', gen: generation, ver: '1.6.2', app: 'S1G4', auth_en: Boolean(password) }
          : { type: 'SHSW-1', mac: 'AABBCCDDEEFF', auth: false, fw: '20230913-112003/v1.14.0' };
      send(200, info);
      return;
    }
    if (!authorised(req)) {
      send(401, { code: 401, message: 'Unauthorized' }, {
        'WWW-Authenticate': `Digest qop="auth", realm="${id}", nonce="${nonce}", algorithm=SHA-256`,
      });
      return;
    }
    if (mock.failNext > 0) {
      mock.failNext -= 1;
      send(500, { code: -1, message: 'simulated failure' });
      return;
    }
    if (url.searchParams.get('id') !== '0') {
      send(404, { code: -105, message: `Argument 'id', value ${url.searchParams.get('id')} not found!` });
      return;
    }
    if (url.pathname === '/rpc/Switch.Set') {
      const on = url.searchParams.get('on') === 'true';
      const toggleAfter = url.searchParams.has('toggle_after') ? Number(url.searchParams.get('toggle_after')) : null;
      const wasOn = mock.output;
      mock.output = on;
      mock.lastSet = { on, toggleAfter };
      clearTimeout(flipTimer);
      if (toggleAfter !== null) {
        flipTimer = setTimeout(() => {
          mock.output = !on;
        }, toggleAfter * 1000);
      }
      send(200, { was_on: wasOn });
      return;
    }
    if (url.pathname === '/rpc/Switch.GetStatus') {
      // The answer describes the relay at the moment the request arrived,
      // even when it is sent late.
      const status = { id: 0, source: 'HTTP_in', output: mock.output, temperature: { tC: 41.2, tF: 106.2 } };
      setTimeout(() => send(200, status), mock.statusDelayMs);
      return;
    }
    send(404, { code: 404, message: `No handler for ${url.pathname.replace('/rpc/', '')}` });
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  mock.host = `127.0.0.1:${server.address().port}`;
  mock.expireChallenge = () => {
    nonce = crypto.randomBytes(8).toString('hex');
    lastCount = 0;
  };
  mock.close = () => {
    clearTimeout(flipTimer);
    return new Promise((resolve) => server.close(resolve));
  };
  return mock;
}

module.exports = { startMockShelly };
