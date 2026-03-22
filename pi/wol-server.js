const http = require('http');
const dgram = require('dgram');

const PORT = parseInt(process.env.PORT || '7777', 10);
const SECRET = process.env.AGENT_SECRET;
const PC_MAC = process.env.PC_MAC || '00:00:00:00:00:00';
const BROADCAST = process.env.BROADCAST || '192.168.219.255';

function createMagicPacket(mac) {
  const macBytes = mac.split(':').map(h => parseInt(h, 16));
  const packet = Buffer.alloc(102);
  for (let i = 0; i < 6; i++) packet[i] = 0xff;
  for (let i = 0; i < 16; i++) {
    for (let j = 0; j < 6; j++) {
      packet[6 + i * 6 + j] = macBytes[j];
    }
  }
  return packet;
}

function sendWol() {
  return new Promise((resolve, reject) => {
    const packet = createMagicPacket(PC_MAC);
    const client = dgram.createSocket('udp4');
    client.bind(() => {
      client.setBroadcast(true);
      let sent = 0;
      const total = 3;
      function sendOne() {
        client.send(packet, 0, packet.length, 9, BROADCAST, (err) => {
          if (err) { client.close(); return reject(err); }
          sent++;
          if (sent < total) setTimeout(sendOne, 250);
          else { client.close(); resolve(sent); }
        });
      }
      sendOne();
    });
  });
}

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Authorization,Content-Type' });
    return res.end();
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, uptime: process.uptime() }));
  }

  if (req.method === 'POST' && req.url === '/wake') {
    // Auth check
    const auth = req.headers['authorization'];
    if (!SECRET || auth !== `Bearer ${SECRET}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
    }

    try {
      const count = await sendWol();
      console.log(`[wol] Sent ${count} magic packets to ${PC_MAC} via ${BROADCAST}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, packets: count, mac: PC_MAC }));
    } catch (err) {
      console.error('[wol] Error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`WOL relay listening on port ${PORT}`);
  console.log(`Target MAC: ${PC_MAC}, Broadcast: ${BROADCAST}`);
});
