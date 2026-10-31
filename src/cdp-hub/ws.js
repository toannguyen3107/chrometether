import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const WS_STATE = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3
};

/**
 * Verify that a WebSocket request does not originate from an untrusted web page.
 * Allows header-less Node clients and chrome-extension:// origins.
 * Rejects http://, https://, file://, null, etc.
 */
export function isAllowedOrigin(originHeader) {
  if (originHeader === undefined || originHeader === null || originHeader === '') {
    return true;
  }
  const normalized = String(originHeader).trim().toLowerCase();
  if (normalized.startsWith('chrome-extension://')) {
    return true;
  }
  return false;
}

/**
 * Extract authentication token from HTTP upgrade request headers, Sec-WebSocket-Protocol, or query string.
 */
export function extractAuthToken(req, parsedUrl) {
  const authHeader = req?.headers?.authorization || req?.headers?.Authorization;
  if (typeof authHeader === 'string') {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match) return match[1].trim();
  }

  const customHeader = req?.headers?.['x-chrometether-token'];
  if (typeof customHeader === 'string' && customHeader.trim()) {
    return customHeader.trim();
  }

  const protoHeader = req?.headers?.['sec-websocket-protocol'];
  if (typeof protoHeader === 'string') {
    const parts = protoHeader.split(',').map(p => p.trim());
    for (const part of parts) {
      if (part.startsWith('chrometether-token.')) {
        return part.slice('chrometether-token.'.length);
      }
    }
  }

  if (parsedUrl?.searchParams?.has('token')) {
    return parsedUrl.searchParams.get('token');
  }

  return null;
}

/**
 * Encode a single WebSocket frame (RFC 6455).
 */
export function encodeWsFrame(opcode, payloadBuffer, mask = false) {
  const payload = Buffer.isBuffer(payloadBuffer)
    ? payloadBuffer
    : Buffer.from(String(payloadBuffer ?? ''), 'utf8');
  const len = payload.length;

  let headerLen = 2;
  if (len >= 126 && len <= 0xffff) {
    headerLen += 2;
  } else if (len > 0xffff) {
    headerLen += 8;
  }

  const maskKey = mask ? crypto.randomBytes(4) : null;
  if (mask) {
    headerLen += 4;
  }

  const frame = Buffer.allocUnsafe(headerLen + len);
  frame[0] = 0x80 | (opcode & 0x0f); // FIN = 1

  let offset = 2;
  const maskBit = mask ? 0x80 : 0x00;
  if (len < 126) {
    frame[1] = maskBit | len;
  } else if (len <= 0xffff) {
    frame[1] = maskBit | 126;
    frame.writeUInt16BE(len, 2);
    offset = 4;
  } else {
    frame[1] = maskBit | 127;
    frame.writeBigUInt64BE(BigInt(len), 2);
    offset = 10;
  }

  if (mask && maskKey) {
    maskKey.copy(frame, offset);
    offset += 4;
    for (let i = 0; i < len; i++) {
      frame[offset + i] = payload[i] ^ maskKey[i & 3];
    }
  } else {
    payload.copy(frame, offset);
  }

  return frame;
}

/**
 * Minimal RFC 6455 WebSocket wrapper over a duplex net.Socket.
 */
export class MiniWebSocket extends EventEmitter {
  constructor(socket, { isClient = false } = {}) {
    super();
    this.socket = socket;
    this.isClient = isClient;
    this.readyState = WS_STATE.OPEN;
    this._buffer = Buffer.alloc(0);
    this._fragments = [];
    this._fragmentOpcode = 0;

    socket.setNoDelay(true);

    socket.on('data', chunk => this._onData(chunk));
    socket.on('close', () => {
      if (this.readyState !== WS_STATE.CLOSED) {
        this.readyState = WS_STATE.CLOSED;
        this.emit('close', 1006, '');
      }
    });
    socket.on('error', err => {
      if (this.listenerCount('error') > 0) {
        this.emit('error', err);
      }
      if (this.readyState !== WS_STATE.CLOSED) {
        this.readyState = WS_STATE.CLOSED;
        this.emit('close', 1006, err?.message || '');
      }
    });
  }

  send(data) {
    if (this.readyState !== WS_STATE.OPEN) return false;
    const isBinary = Buffer.isBuffer(data);
    const opcode = isBinary ? 0x02 : 0x01;
    const payload = isBinary ? data : Buffer.from(String(data), 'utf8');
    const frame = encodeWsFrame(opcode, payload, this.isClient);
    try {
      return this.socket.write(frame);
    } catch (err) {
      this.emit('error', err);
      return false;
    }
  }

  ping(data = '') {
    if (this.readyState !== WS_STATE.OPEN) return false;
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const frame = encodeWsFrame(0x09, payload, this.isClient);
    try {
      return this.socket.write(frame);
    } catch {
      return false;
    }
  }

  pong(data = '') {
    if (this.readyState !== WS_STATE.OPEN) return false;
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const frame = encodeWsFrame(0x0a, payload, this.isClient);
    try {
      return this.socket.write(frame);
    } catch {
      return false;
    }
  }

  close(code = 1000, reason = '') {
    if (this.readyState === WS_STATE.CLOSED || this.readyState === WS_STATE.CLOSING) {
      return;
    }
    this.readyState = WS_STATE.CLOSING;
    const reasonBuf = Buffer.from(String(reason || ''), 'utf8');
    const payload = Buffer.allocUnsafe(2 + reasonBuf.length);
    payload.writeUInt16BE(code, 0);
    reasonBuf.copy(payload, 2);
    try {
      this.socket.write(encodeWsFrame(0x08, payload, this.isClient));
      this.socket.end();
    } catch {
      this.socket.destroy();
    }
    this.readyState = WS_STATE.CLOSED;
    this.emit('close', code, reason);
  }

  _onData(chunk) {
    this._buffer = this._buffer.length === 0 ? chunk : Buffer.concat([this._buffer, chunk]);

    while (this._buffer.length >= 2) {
      const firstByte = this._buffer[0];
      const secondByte = this._buffer[1];
      const fin = (firstByte & 0x80) !== 0;
      const opcode = firstByte & 0x0f;
      const masked = (secondByte & 0x80) !== 0;
      let payloadLen = secondByte & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (this._buffer.length < 4) return;
        payloadLen = this._buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this._buffer.length < 10) return;
        const bigLen = this._buffer.readBigUInt64BE(2);
        payloadLen = Number(bigLen);
        offset = 10;
      }

      const maskOffset = offset;
      if (masked) {
        offset += 4;
      }

      if (this._buffer.length < offset + payloadLen) {
        return;
      }

      const payload = Buffer.from(this._buffer.subarray(offset, offset + payloadLen));
      if (masked) {
        const maskKey = this._buffer.subarray(maskOffset, maskOffset + 4);
        for (let i = 0; i < payloadLen; i++) {
          payload[i] ^= maskKey[i & 3];
        }
      }

      this._buffer = this._buffer.subarray(offset + payloadLen);
      this._handleFrame(fin, opcode, payload);
    }
  }

  _handleFrame(fin, opcode, payload) {
    if (opcode === 0x08) {
      // Close frame
      let code = 1000;
      let reason = '';
      if (payload.length >= 2) {
        code = payload.readUInt16BE(0);
        reason = payload.subarray(2).toString('utf8');
      }
      if (this.readyState === WS_STATE.OPEN) {
        this.readyState = WS_STATE.CLOSING;
        try {
          this.socket.write(encodeWsFrame(0x08, payload.subarray(0, 2), this.isClient));
          this.socket.end();
        } catch {
          this.socket.destroy();
        }
      }
      if (this.readyState !== WS_STATE.CLOSED) {
        this.readyState = WS_STATE.CLOSED;
        this.emit('close', code, reason);
      }
      return;
    }

    if (opcode === 0x09) {
      // Ping -> auto reply Pong
      this.pong(payload);
      this.emit('ping', payload);
      return;
    }

    if (opcode === 0x0a) {
      this.emit('pong', payload);
      return;
    }

    if (opcode === 0x00) {
      // Continuation
      this._fragments.push(payload);
      if (fin) {
        const full = Buffer.concat(this._fragments);
        const origOpcode = this._fragmentOpcode;
        this._fragments = [];
        this._fragmentOpcode = 0;
        this.emit('message', origOpcode === 0x01 ? full.toString('utf8') : full);
      }
      return;
    }

    if (opcode === 0x01 || opcode === 0x02) {
      if (!fin) {
        this._fragmentOpcode = opcode;
        this._fragments = [payload];
        return;
      }
      this.emit('message', opcode === 0x01 ? payload.toString('utf8') : payload);
    }
  }
}

/**
 * Perform server-side RFC 6455 HTTP Upgrade and return a MiniWebSocket.
 */
export function upgradeToWebSocket(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return null;
  }

  const accept = crypto
    .createHash('sha1')
    .update(key + WS_GUID)
    .digest('base64');

  const protoHeader = req.headers['sec-websocket-protocol'];
  let selectedProto = null;
  if (typeof protoHeader === 'string' && protoHeader.trim()) {
    selectedProto = protoHeader.split(',')[0].trim();
  }

  const headers = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`
  ];
  if (selectedProto) {
    headers.push(`Sec-WebSocket-Protocol: ${selectedProto}`);
  }
  headers.push('\r\n');

  socket.write(headers.join('\r\n'));

  const ws = new MiniWebSocket(socket, { isClient: false });
  if (head && head.length > 0) {
    ws._onData(head);
  }
  return ws;
}

/**
 * Connect as a WebSocket client with custom HTTP headers.
 */
export function connectWebSocket(urlString, { headers = {}, timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlString);
    const isSecure = parsed.protocol === 'wss:' || parsed.protocol === 'https:';
    const mod = isSecure ? https : http;
    const key = crypto.randomBytes(16).toString('base64');

    const req = mod.request({
      protocol: isSecure ? 'https:' : 'http:',
      hostname: parsed.hostname,
      port: parsed.port || (isSecure ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      method: 'GET',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': key,
        ...headers
      },
      timeout: timeoutMs
    });

    let settled = false;
    const fail = err => {
      if (settled) return;
      settled = true;
      try {
        req.destroy();
      } catch {
        // ignore
      }
      reject(err);
    };

    req.on('timeout', () => fail(new Error(`WebSocket connection timed out after ${timeoutMs}ms`)));
    req.on('error', fail);

    req.on('upgrade', (res, socket, head) => {
      if (settled) return;
      settled = true;
      const ws = new MiniWebSocket(socket, { isClient: true });
      if (head && head.length > 0) {
        ws._onData(head);
      }
      resolve(ws);
    });

    req.on('response', res => {
      fail(new Error(`Unexpected HTTP status ${res.statusCode} when upgrading WebSocket`));
    });

    req.end();
  });
}
