export type RunnerWritableSocket = Pick<
  WebSocket,
  "close" | "readyState" | "send"
>;

export function sendOpenRunnerSocketMessage(
  socket: RunnerWritableSocket,
  message: Readonly<Record<string, unknown>>,
): void {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }
  try {
    socket.send(JSON.stringify(message));
  } catch {
    socket.close();
  }
}
