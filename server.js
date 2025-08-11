const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// In-memory stores (simple prototype)
const players = new Map(); // socketId -> {id, name, lat, lng, points, collection:[]}
const spawns = new Map(); // spawnId -> {id, ownerId, name, dataUrl, lat, lng, timestamp}
let nextSpawnId = 1;

const CATCH_RADIUS_METERS = 60; // how close to catch

function haversineDistanceMeters(aLat, aLng, bLat, bLng) {
  const toRad = (v) => (v * Math.PI) / 180;
  const R = 6371000; // m
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);

  const aa = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLng/2)**2;
  const c = 2 * Math.atan2(Math.sqrt(aa), Math.sqrt(1-aa));
  return R * c;
}

io.on('connection', (socket) => {
  console.log('connect', socket.id);

  socket.on('join', ({name}) => {
    players.set(socket.id, {id: socket.id, name: name || 'Anon', lat: null, lng: null, points: 0, collection: []});
    // send current spawns and players
    socket.emit('init', {spawns: Array.from(spawns.values()), players: Array.from(players.values())});
    io.emit('players_update', Array.from(players.values()));
  });

  socket.on('position_update', ({lat, lng}) => {
    const p = players.get(socket.id);
    if (!p) return;
    p.lat = lat; p.lng = lng;
    players.set(socket.id, p);
    // broadcast position to others (lightweight)
    io.emit('player_moved', {id: p.id, lat, lng});
  });

  socket.on('spawn_creature', ({name, dataUrl, lat, lng}) => {
    const p = players.get(socket.id);
    if (!p) return;
    const id = String(nextSpawnId++);
    const spawn = {id, ownerId: p.id, ownerName: p.name, name: name || 'Creature', dataUrl, lat, lng, timestamp: Date.now()};
    spawns.set(id, spawn);
    io.emit('spawn_added', spawn);
    console.log('spawned', id, 'by', p.name);
  });

  socket.on('attempt_catch', ({spawnId, lat, lng}) => {
    const p = players.get(socket.id);
    if (!p) return;
    const spawn = spawns.get(spawnId);
    if (!spawn) {
      socket.emit('catch_result', {success: false, reason: 'not_found'});
      return;
    }
    const dist = haversineDistanceMeters(lat, lng, spawn.lat, spawn.lng);
    if (dist > CATCH_RADIUS_METERS) {
      socket.emit('catch_result', {success: false, reason: 'too_far', distance: dist});
      return;
    }
    // success: assign creature to catcher, award points to owner and catcher
    const owner = players.get(spawn.ownerId);
    if (owner) {
      owner.points = (owner.points || 0) + 10; // points for drawing
      players.set(owner.id, owner);
    }
    p.points = (p.points || 0) + 3; // points for catching
    p.collection = p.collection || [];
    p.collection.push({spawnId: spawn.id, name: spawn.name, dataUrl: spawn.dataUrl, ownerName: spawn.ownerName});
    players.set(p.id, p);

    // remove spawn
    spawns.delete(spawnId);

    // notify everyone
    io.emit('spawn_removed', {spawnId});
    io.emit('players_update', Array.from(players.values()));

    socket.emit('catch_result', {success: true, creature: spawn});
    if (owner && owner.id !== p.id) {
      io.to(owner.id).emit('you_scored', {points: 10, spawn});
    }
  });

  socket.on('disconnect', () => {
    console.log('disconnect', socket.id);
    players.delete(socket.id);
    io.emit('players_update', Array.from(players.values()));
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Server listening on', PORT));