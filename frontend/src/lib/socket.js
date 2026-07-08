import { io } from "socket.io-client";

let socket = null;

export function connectSocket(backendUrl) {
  if (socket && socket.connected) return socket;
  socket = io(backendUrl, { transports: ["websocket"] });
  return socket;
}

export function getSocket() {
  return socket;
}
