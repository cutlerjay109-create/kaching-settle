// backend/src/sockets.js
// Manages Socket.IO connections and broadcasts live updates to all browsers.

let io = null;

function init(socketIo) {
  io = socketIo;

  io.on("connection", (socket) => {
    console.log("[sockets] Client connected:", socket.id);

    socket.on("subscribe-market", (fixtureId) => {
      socket.join(`market-${fixtureId}`);
      console.log(`[sockets] ${socket.id} subscribed to market-${fixtureId}`);
    });

    socket.on("disconnect", () => {
      console.log("[sockets] Client disconnected:", socket.id);
    });
  });
}

// Broadcast live score update to all subscribers of a market
function broadcastScore(fixtureId, scoreData) {
  if (!io) return;
  io.to(`market-${fixtureId}`).emit("score-update", scoreData);
}

// Broadcast match event (goal, card, etc.)
function broadcastEvent(fixtureId, eventData) {
  if (!io) return;
  io.to(`market-${fixtureId}`).emit("match-event", eventData);
}

// Broadcast settlement result to all subscribers
function broadcastSettlement(fixtureId, settlement) {
  if (!io) return;
  io.to(`market-${fixtureId}`).emit("settlement", settlement);
  console.log(`[sockets] Settlement broadcast for market-${fixtureId}`);
}

// Broadcast to everyone
function broadcastAll(event, data) {
  if (!io) return;
  io.emit(event, data);
}

module.exports = { init, broadcastScore, broadcastEvent, broadcastSettlement, broadcastAll };
